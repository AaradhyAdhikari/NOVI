package app.novi.phone

import android.app.Activity
import android.content.ClipboardManager
import android.content.Intent
import android.os.Bundle

/**
 * Novi Flick: reads what the selection menu's Copy just put on the clipboard. Android lets only the app in front
 * read the clipboard, so this invisible screen comes up for a moment, reads it once, and closes.
 */
class ClipActivity : Activity() {
    companion object { @Volatile var onRead: ((String?) -> Unit)? = null }
    private var done = false
    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (!hasFocus || done) return
        done = true
        val text = runCatching { getSystemService(ClipboardManager::class.java).primaryClip?.getItemAt(0)?.coerceToText(this)?.toString() }.getOrNull()
        onRead?.invoke(text?.trim()?.take(20000)?.ifEmpty { null })
        onRead = null
        finish()
    }
}

/** "Send to Novi" in the text selection menu (Copy / Share / Select all / …): the words go straight to the laptop. */
class ProcessTextActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // Some apps hand the words differently; this screen is in front, so the clipboard can be read too.
        val words = listOfNotNull(
            intent.getCharSequenceExtra(Intent.EXTRA_PROCESS_TEXT)?.toString(),
            intent.getStringExtra(Intent.EXTRA_PROCESS_TEXT),
            intent.getCharSequenceExtra(Intent.EXTRA_TEXT)?.toString(),
        ).map { it.trim() }.firstOrNull { it.isNotEmpty() }
            ?: runCatching { getSystemService(android.content.ClipboardManager::class.java).primaryClip?.getItemAt(0)?.coerceToText(this)?.toString()?.trim() }.getOrNull().orEmpty()
        val svc = NoviService.instance
        if (words.isNotEmpty() && svc != null) { svc.flickWords(words.take(20000)); android.widget.Toast.makeText(this, "Sent to the laptop", android.widget.Toast.LENGTH_SHORT).show() }
        else android.widget.Toast.makeText(this, if (svc == null) "Open Novi first." else "This app didn't pass the text. Tap Copy, then Send to Novi again.", android.widget.Toast.LENGTH_SHORT).show()
        finish()
    }
}
