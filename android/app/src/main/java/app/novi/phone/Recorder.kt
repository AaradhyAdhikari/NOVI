package app.novi.phone

import android.annotation.SuppressLint
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import android.media.audiofx.AcousticEchoCanceler
import android.media.audiofx.NoiseSuppressor
import java.io.ByteArrayOutputStream
import java.nio.ByteBuffer
import java.nio.ByteOrder
import kotlin.math.sqrt

/** What the mic got: speech (empty when nobody spoke), and whether Android gave only zeros (mic blocked). */
class Heard(val pcm: ByteArray, val blocked: Boolean)

/** 16 kHz mono speech capture, shared by the card's own listening and the mic dialog. */
object Recorder {
    private const val RATE = 16000

    /**
     * Records until 1.2 s of quiet after speech, `giveUpMs` with no speech, `maxMs` in all, or `stop()`.
     * `echo` (Novi reads the card out meanwhile): the call-style mic with echo cancelling, a higher speech
     * level while `speaking()`, and `giveUpMs` counted only after Novi stopped talking. `onSpeech` runs once
     * when the user starts talking (Novi then stops). Only the speech is kept (from 0.3 s before it began).
     */
    @SuppressLint("MissingPermission")
    fun capture(
        giveUpMs: Int = 5000,
        maxMs: Int = 12000,
        echo: Boolean = false,
        speaking: () -> Boolean = { false },
        onSpeech: () -> Unit = {},
        stop: () -> Boolean = { false },
    ): Heard {
        val frame = RATE / 10
        val min = AudioRecord.getMinBufferSize(RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
        val source = if (echo) MediaRecorder.AudioSource.VOICE_COMMUNICATION else MediaRecorder.AudioSource.VOICE_RECOGNITION
        val rec = AudioRecord(source, RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, maxOf(min, frame * 4))
        if (rec.state != AudioRecord.STATE_INITIALIZED) {
            rec.release()
            return Heard(ByteArray(0), blocked = true)
        }
        val effects = if (echo) listOfNotNull(
            if (AcousticEchoCanceler.isAvailable()) AcousticEchoCanceler.create(rec.audioSessionId)?.apply { enabled = true } else null,
            if (NoiseSuppressor.isAvailable()) NoiseSuppressor.create(rec.audioSessionId)?.apply { enabled = true } else null,
        ) else emptyList()
        val out = ByteArrayOutputStream()
        val before = ArrayDeque<ByteArray>()
        val buf = ShortArray(frame)
        var spoke = false
        var loud = 0
        var quiet = 0
        var frames = 0
        var waited = 0
        var anySound = false
        rec.startRecording()
        try {
            while (!stop() && frames < maxMs / 100) {
                val n = rec.read(buf, 0, frame)
                if (n <= 0) break
                frames++
                val talking = speaking()
                if (!talking) waited++
                var sum = 0.0
                val bytes = ByteBuffer.allocate(n * 2).order(ByteOrder.LITTLE_ENDIAN)
                for (i in 0 until n) {
                    sum += buf[i] * buf[i].toDouble()
                    bytes.putShort(buf[i])
                }
                val chunk = bytes.array()
                if (!anySound && !isSilent(chunk)) anySound = true
                val rms = sqrt(sum / n)
                // While Novi talks, only a clearly louder voice for 0.3 s counts as the user (echo leftovers don't).
                val level = if (talking) 1500 else 700
                if (!spoke) {
                    loud = if (rms > level) loud + 1 else 0
                    before.addLast(chunk)
                    if (before.size > 4) before.removeFirst()
                    if (loud >= (if (talking) 3 else 1)) {
                        spoke = true
                        onSpeech()
                        before.forEach { out.write(it) }
                    }
                } else {
                    out.write(chunk)
                    if (rms > 700) quiet = 0 else quiet++
                    if (quiet >= 12) break
                }
                if (!spoke && waited >= giveUpMs / 100) break
            }
        } finally {
            rec.stop()
            rec.release()
            effects.forEach { it.release() }
        }
        return Heard(if (spoke) out.toByteArray() else ByteArray(0), blocked = frames > 0 && !anySound)
    }

    fun wav(pcm: ByteArray): ByteArray {
        val h = ByteBuffer.allocate(44).order(ByteOrder.LITTLE_ENDIAN)
        h.put("RIFF".toByteArray()).putInt(36 + pcm.size).put("WAVE".toByteArray())
        h.put("fmt ".toByteArray()).putInt(16).putShort(1).putShort(1).putInt(RATE).putInt(RATE * 2).putShort(2).putShort(16)
        h.put("data".toByteArray()).putInt(pcm.size)
        return h.array() + pcm
    }
}
