package app.novi.phone

import android.content.Context
import android.content.Intent
import android.media.AudioManager
import android.os.Bundle
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer

/**
 * The phone's own speech recognition for the remote view (user, 2026-11-08: voice control and typing were too
 * slow and "type" was misheard as "Pipe"). Words come straight from the phone's recognizer, with live partial
 * results, instead of recording, uploading and running Novi's speech-to-text. Main thread only.
 * emit(id, text, final, error): error is "" when fine; "no speech" / "no match" end a listen quietly.
 */
class PhoneSpeech(private val context: Context, private val emit: (String, String, Boolean, String) -> Unit) {
    private var rec: SpeechRecognizer? = null
    private val audio = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
    // The recognizer beeps each time it starts listening (every few seconds in the remote view; user: "it is
    // making sound always, it's irritating"). Those sounds stay muted while the view listens; only the ones
    // muted here are turned back on.
    private val BEEPS = intArrayOf(AudioManager.STREAM_MUSIC, AudioManager.STREAM_NOTIFICATION, AudioManager.STREAM_SYSTEM)
    private val mutedHere = mutableSetOf<Int>()

    private fun hush() {
        for (s in BEEPS) runCatching {
            if (!audio.isStreamMute(s)) { audio.adjustStreamVolume(s, AudioManager.ADJUST_MUTE, 0); mutedHere.add(s) }
        }
    }

    /** The view stopped listening (closed, or the mic turned off): the sounds come back. */
    fun release() {
        stop()
        for (s in mutedHere) runCatching { audio.adjustStreamVolume(s, AudioManager.ADJUST_UNMUTE, 0) }
        mutedHere.clear()
    }

    fun available(): Boolean = SpeechRecognizer.isRecognitionAvailable(context)

    fun start(id: String) {
        stop()
        hush()
        val r = SpeechRecognizer.createSpeechRecognizer(context)
        rec = r
        r.setRecognitionListener(object : RecognitionListener {
            override fun onResults(results: Bundle?) = emit(id, best(results), true, "")
            override fun onPartialResults(partial: Bundle?) {
                val text = best(partial)
                if (text.isNotEmpty()) emit(id, text, false, "")
            }
            override fun onError(error: Int) = emit(id, "", true, errorName(error))
            override fun onReadyForSpeech(params: Bundle?) {}
            override fun onBeginningOfSpeech() {}
            override fun onRmsChanged(rmsdB: Float) {}
            override fun onBufferReceived(buffer: ByteArray?) {}
            override fun onEndOfSpeech() {}
            override fun onEvent(eventType: Int, params: Bundle?) {}
        })
        r.startListening(Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
            putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
            putExtra(RecognizerIntent.EXTRA_LANGUAGE, "en-IN")
            putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
            putExtra(RecognizerIntent.EXTRA_PREFER_OFFLINE, true)
            putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1)
            // A short pause ended the phrase mid-sentence live ("type your" | "are you me…"): wait 1.5 s.
            putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_COMPLETE_SILENCE_LENGTH_MILLIS, 1500L)
            putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_POSSIBLY_COMPLETE_SILENCE_LENGTH_MILLIS, 1500L)
        })
    }

    fun stop() {
        rec?.destroy()
        rec = null
    }

    private fun best(b: Bundle?): String =
        b?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull()?.trim().orEmpty()

    private fun errorName(code: Int): String = when (code) {
        SpeechRecognizer.ERROR_SPEECH_TIMEOUT -> "no speech"
        SpeechRecognizer.ERROR_NO_MATCH -> "no match"
        SpeechRecognizer.ERROR_RECOGNIZER_BUSY -> "busy"
        SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS -> "no permission"
        SpeechRecognizer.ERROR_NETWORK, SpeechRecognizer.ERROR_NETWORK_TIMEOUT -> "network"
        else -> "error $code"
    }
}
