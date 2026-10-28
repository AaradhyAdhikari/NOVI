package app.novi.phone

import android.annotation.SuppressLint
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import java.io.ByteArrayOutputStream
import java.nio.ByteBuffer
import java.nio.ByteOrder
import kotlin.math.sqrt

/** What the mic got: speech (empty when nobody spoke), and whether Android gave only zeros (mic blocked). */
class Heard(val pcm: ByteArray, val blocked: Boolean)

/** 16 kHz mono speech capture, shared by the card's own listening and the mic dialog. */
object Recorder {
    private const val RATE = 16000

    /** Records until 1.2 s of quiet after speech, `giveUpMs` with no speech, `maxMs` in all, or `stop()`. */
    @SuppressLint("MissingPermission")
    fun capture(giveUpMs: Int = 5000, maxMs: Int = 12000, stop: () -> Boolean = { false }): Heard {
        val frame = RATE / 10
        val min = AudioRecord.getMinBufferSize(RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
        val rec = AudioRecord(MediaRecorder.AudioSource.VOICE_RECOGNITION, RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, maxOf(min, frame * 4))
        if (rec.state != AudioRecord.STATE_INITIALIZED) {
            rec.release()
            return Heard(ByteArray(0), blocked = true)
        }
        val out = ByteArrayOutputStream()
        val buf = ShortArray(frame)
        var spoke = false
        var quiet = 0
        var frames = 0
        rec.startRecording()
        try {
            while (!stop() && frames < maxMs / 100) {
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
                // Speech level: a little lower than before (900), so a quieter voice also counts.
                if (sqrt(sum / n) > 700) {
                    spoke = true
                    quiet = 0
                } else if (spoke) quiet++
                if (spoke && quiet >= 12) break
                if (!spoke && frames >= giveUpMs / 100) break
            }
        } finally {
            rec.stop()
            rec.release()
        }
        val all = out.toByteArray()
        return Heard(if (spoke) all else ByteArray(0), blocked = frames > 0 && isSilent(all))
    }

    fun wav(pcm: ByteArray): ByteArray {
        val h = ByteBuffer.allocate(44).order(ByteOrder.LITTLE_ENDIAN)
        h.put("RIFF".toByteArray()).putInt(36 + pcm.size).put("WAVE".toByteArray())
        h.put("fmt ".toByteArray()).putInt(16).putShort(1).putShort(1).putInt(RATE).putInt(RATE * 2).putShort(2).putShort(16)
        h.put("data".toByteArray()).putInt(pcm.size)
        return h.array() + pcm
    }
}
