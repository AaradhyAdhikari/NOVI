package app.novi.phone

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.OpenableColumns
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.UUID

/**
 * Novi Flick: what the Android share menu hands to "Flick to Novi". Shared files are copied into the app's own
 * cache (the share permission lasts only while the share screen is open); the page picks them up with
 * NoviApp.flickInbox() and reads each one from https://novi-flick.local/<id>, then flicks it like a picked file.
 */
object FlickInbox {
    const val HOST = "novi-flick.local"
    data class Item(val id: String, val name: String, val type: String, val file: File?, val link: String?)

    private val items = mutableListOf<Item>()
    private const val MAX_BYTES = 300L * 1024 * 1024

    @Synchronized
    fun take(ctx: Context, intent: Intent) {
        val dir = File(ctx.cacheDir, "flick").apply { mkdirs() }
        dir.listFiles()?.filter { System.currentTimeMillis() - it.lastModified() > 6 * 3600_000 }?.forEach { it.delete() }
        val uris = mutableListOf<Uri>()
        if (intent.action == Intent.ACTION_SEND_MULTIPLE) {
            @Suppress("DEPRECATION")
            intent.getParcelableArrayListExtra<Uri>(Intent.EXTRA_STREAM)?.let { uris.addAll(it) }
        } else {
            @Suppress("DEPRECATION")
            (intent.getParcelableExtra<Uri>(Intent.EXTRA_STREAM))?.let { uris.add(it) }
        }
        // Only files another app really shared (security review): content:// from some other app, never file://
        // and never Novi's own provider, so another app can't use "Flick to Novi" to read Novi's private files.
        for (uri in uris.filter { allowedShare(it.scheme, it.authority, ctx.packageName) }.take(20)) {
            val name = displayName(ctx, uri) ?: "file"
            val id = UUID.randomUUID().toString().replace("-", "").take(12)
            val out = File(dir, id)
            val copied = runCatching {
                ctx.contentResolver.openInputStream(uri)?.use { input ->
                    out.outputStream().use { o ->
                        val buf = ByteArray(64 * 1024)
                        var total = 0L
                        while (true) {
                            val n = input.read(buf)
                            if (n < 0) break
                            total += n
                            if (total > MAX_BYTES) throw IllegalStateException("too big")
                            o.write(buf, 0, n)
                        }
                    }
                } != null
            }.getOrDefault(false)
            if (copied) items.add(Item(id, name, ctx.contentResolver.getType(uri) ?: "", out, null)) else out.delete()
        }
        if (uris.isEmpty()) {
            val text = intent.getStringExtra(Intent.EXTRA_TEXT) ?: ""
            firstLink(text)?.let { items.add(Item(UUID.randomUUID().toString().take(12), it, "", null, it)) }
        }
    }

    /** Everything waiting, once: the page takes it and the list empties (the files stay for reading). */
    @Synchronized
    fun takeJson(): String {
        val arr = JSONArray()
        for (it in items) arr.put(JSONObject().apply {
            put("id", it.id); put("name", it.name); put("type", it.type)
            if (it.link != null) put("link", it.link)
        })
        items.clear()
        return arr.toString()
    }

    /** A shared file by id, only from our own cache folder. */
    fun file(ctx: Context, id: String): File? {
        if (!Regex("^[a-f0-9]{8,32}$").matches(id)) return null
        val f = File(File(ctx.cacheDir, "flick"), id)
        return if (f.isFile) f else null
    }

    private fun displayName(ctx: Context, uri: Uri): String? = runCatching {
        ctx.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { c ->
            if (c.moveToFirst()) c.getString(0) else null
        }
    }.getOrNull()
}

/** A shared file is taken only from another app's content provider. */
fun allowedShare(scheme: String?, authority: String?, ownPackage: String): Boolean =
    scheme == "content" && !authority.isNullOrBlank() && authority != ownPackage && !authority.startsWith("$ownPackage.")

/** The first http(s) link in shared text (YouTube, Chrome and others share "Title https://…"). */
fun firstLink(text: String): String? = Regex("https?://[^\\s<>\"']+", RegexOption.IGNORE_CASE).find(text)?.value
