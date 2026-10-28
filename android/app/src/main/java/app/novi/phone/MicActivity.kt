package app.novi.phone

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.content.pm.PackageManager
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import android.os.Bundle
import android.view.Gravity
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView
import java.io.ByteArrayOutputStream
import java.nio.ByteBuffer
import java.nio.ByteOrder
import kotlin.concurrent.thread
import kotlin.math.sqrt

/**
 * "Listening…" for a card's 🎤 button. A small window in front (Android lets only a visible app use
 * the mic): records until a short silence, the laptop turns it into words, and Novi gets them as a
 * request ("option 2", "yes, but…") or, for a PIN card, as the spoken PIN.
 */
class MicActivity : Activity() {
    @Volatile private var stopNow = false
    private lateinit var line: TextView

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setFinishOnTouchOutside(false)
        val pad = (16 * resources.displayMetrics.density).toInt()
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(pad, pad, pad, pad)
        }
        root.addView(TextView(this).apply {
            text = intent.getStringExtra("title").orEmpty()
            textSize = 15f
        })
        line = TextView(this).apply {
            textSize = 20f
            gravity = Gravity.CENTER
            setPadding(0, pad, 0, pad)
            text = if (pin()) "Say your PIN…" else "Listening… say your answer"
        }
        root.addView(line)
        val row = LinearLayout(this)
        row.addView(Button(this).apply {
            text = "Done"
            setOnClickListener { stopNow = true }
        })
        row.addView(Button(this).apply {
            text = "Cancel"
            setOnClickListener { finish() }
        })
        root.addView(row)
        setContentView(root)
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) record()
        else requestPermissions(arrayOf(Manifest.permission.RECORD_AUDIO), 1)
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        if (grantResults.firstOrNull() == PackageManager.PERMISSION_GRANTED) record()
        else {
            line.text = "Novi needs the microphone for this."
            line.postDelayed({ finish() }, 2000)
        }
    }

    override fun onDestroy() {
        stopNow = true
        super.onDestroy()
    }

    private fun pin() = intent.getBooleanExtra("pin", false)

    @SuppressLint("MissingPermission")
    private fun record() {
        val card = intent.getStringExtra("card") ?: return finish()
        thread {
            val pcm = runCatching { capture() }.getOrNull()
            if (isFinishing) return@thread
            if (pcm == null || pcm.isEmpty()) return@thread show("I didn't hear anything.", close = true)
            show("Got it…")
            val svc = NoviService.instance ?: return@thread show("Novi isn't connected.", close = true)
            val heard = runCatching { svc.transcribe(wav(pcm)) }
            heard.onFailure { show(it.message ?: "Couldn't reach Novi.", close = true) }
            heard.onSuccess { text ->
                if (text.isBlank()) return@onSuccess show("I didn't catch that.", close = true)
                runOnUiThread {
                    if (pin()) svc.sendPin(card, spoken = text) else svc.sendText(text)
                }
                // A PIN is never shown back.
                show(if (pin()) "Checking the PIN…" else "“$text”", close = true)
            }
        }
    }

    private fun show(text: String, close: Boolean = false) = runOnUiThread {
        line.text = text
        if (close) line.postDelayed({ finish() }, 1500)
    }

    /** 16 kHz mono; stops 1.2 s after speech ends, after 5 s of nothing, at 12 s, or on "Done". */
    @SuppressLint("MissingPermission")
    private fun capture(): ByteArray {
        val rate = 16000
        val frame = rate / 10
        val min = AudioRecord.getMinBufferSize(rate, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
        val rec = AudioRecord(MediaRecorder.AudioSource.VOICE_RECOGNITION, rate, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, maxOf(min, frame * 4))
        val out = ByteArrayOutputStream()
        val buf = ShortArray(frame)
        var spoke = false
        var quiet = 0
        var frames = 0
        rec.startRecording()
        try {
            while (!stopNow && frames < 120) {
                val n = rec.read(buf, 0, frame)
                if (n <= 0) break
                frames++
                var sum = 0.0
                val bytes = ByteBuffer.allocate(n * 2).order(ByteOrder.LITTLE_ENDIAN)
                for (i in 0 until n) {
                    sum += buf[i] * buf[i].toDouble()
                    bytes.putShort(buf[i])
                }
                out.write(bytes.array())
                val rms = sqrt(sum / n)
                if (rms > 900) {
                    spoke = true
                    quiet = 0
                } else if (spoke) quiet++
                if (spoke && quiet >= 12) break
                if (!spoke && frames >= 50) return ByteArray(0)
            }
        } finally {
            rec.stop()
            rec.release()
        }
        return if (spoke || stopNow) out.toByteArray() else ByteArray(0)
    }

    private fun wav(pcm: ByteArray): ByteArray {
        val h = ByteBuffer.allocate(44).order(ByteOrder.LITTLE_ENDIAN)
        h.put("RIFF".toByteArray()).putInt(36 + pcm.size).put("WAVE".toByteArray())
        h.put("fmt ".toByteArray()).putInt(16).putShort(1).putShort(1).putInt(16000).putInt(32000).putShort(2).putShort(16)
        h.put("data".toByteArray()).putInt(pcm.size)
        return h.array() + pcm
    }
}
