package app.novi.phone

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.content.pm.PackageManager
import android.os.Bundle
import android.view.Gravity
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView
import kotlin.concurrent.thread

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
            val pcm = runCatching { Recorder.capture(stop = { stopNow }) }.getOrNull()?.pcm
            if (isFinishing) return@thread
            if (pcm == null || pcm.isEmpty()) return@thread show("I didn't hear anything.", close = true)
            show("Got it…")
            val svc = NoviService.instance ?: return@thread show("Novi isn't connected.", close = true)
            val heard = runCatching { svc.transcribe(Recorder.wav(pcm)) }
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
}
