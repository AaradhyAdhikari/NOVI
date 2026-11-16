package app.novi.phone

import android.Manifest
import android.content.BroadcastReceiver
import android.content.ContentUris
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.database.ContentObserver
import android.graphics.Bitmap
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.app.KeyguardManager
import android.os.Looper
import android.os.PowerManager
import android.os.SystemClock
import android.os.VibrationEffect
import android.os.Vibrator
import android.provider.MediaStore
import android.util.Size
import kotlin.math.sqrt

/**
 * Novi Flick v2, anywhere on the phone (user, 2026-11-16: "whenever I do that gesture with my phone it works …
 * flick as the first, send to Novi as a secondary thing"). While the screen is on, the motion sensors watch for
 * the wrist flick (FlickDetector). A flick sends: Novi's own flick screen's top card, else a screenshot taken in
 * the last 90 s, else the link in the browser in front, else a picture of the screen (Novi typing must be on).
 * Never a bank / UPI / password app or a screen with a password box. 1.5 s to cancel before anything goes.
 * New screenshots also get a small pop-up: "Flick your phone to send it" + Send to Novi.
 */
class FlickAnywhere(private val svc: NoviService, private val store: Store) : SensorEventListener {
    private val main = Handler(Looper.getMainLooper())
    // MediaStore queries and thumbnails happen here, never on the main thread (review 2026-11-16).
    private val worker = HandlerThread("novi-flick").apply { start() }
    private val bg = Handler(worker.looper)
    private val sensors = svc.getSystemService(SensorManager::class.java)
    private val detector = FlickDetector()
    private val overlay = FlickOverlay(svc)
    private var acc = 0f
    private var listening = false
    private var busy = false
    // What just landed (bytes, name, type, kind), for the WhatsApp / Share buttons on the "Landed" card.
    private var lastSent: Pair<Triple<ByteArray, String, String>, String>? = null

    private data class Shot(val uri: Uri, val name: String, val type: String, val at: Long)
    private var lastShot: Shot? = null
    private var lastShotId = -1L

    private val screen = object : BroadcastReceiver() {
        override fun onReceive(c: Context?, i: Intent?) = update()
    }
    private val shots = object : ContentObserver(bg) {
        override fun onChange(selfChange: Boolean, uri: Uri?) = checkScreenshot()
    }

    fun start() {
        svc.registerReceiver(screen, IntentFilter().apply { addAction(Intent.ACTION_SCREEN_ON); addAction(Intent.ACTION_SCREEN_OFF); addAction(Intent.ACTION_USER_PRESENT) })
        if (canReadShots(svc)) runCatching { svc.contentResolver.registerContentObserver(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, true, shots) }
        update()
    }

    fun stop() {
        runCatching { svc.unregisterReceiver(screen) }
        runCatching { svc.contentResolver.unregisterContentObserver(shots) }
        sensorsOff()
        overlay.hide()
    }

    /** After the setting changes or permission is given. */
    fun refresh() { stop(); start() }

    private fun update() {
        // Screen on and unlocked only: never from the lock screen (notifications and codes show there).
        val on = store.flickAnywhere && svc.getSystemService(PowerManager::class.java).isInteractive && !locked()
        if (on) sensorsOn() else sensorsOff()
    }

    private fun locked() = svc.getSystemService(KeyguardManager::class.java).isKeyguardLocked

    /** The service is ending for good. */
    fun close() { stop(); worker.quitSafely() }

    private fun sensorsOn() {
        if (listening) return
        val lin = sensors.getDefaultSensor(Sensor.TYPE_LINEAR_ACCELERATION) ?: return
        val gyro = sensors.getDefaultSensor(Sensor.TYPE_GYROSCOPE) ?: return
        sensors.registerListener(this, lin, SensorManager.SENSOR_DELAY_GAME)
        sensors.registerListener(this, gyro, SensorManager.SENSOR_DELAY_GAME)
        listening = true
    }

    private fun sensorsOff() {
        if (!listening) return
        sensors.unregisterListener(this)
        listening = false
    }

    override fun onAccuracyChanged(sensor: Sensor?, accuracy: Int) {}

    override fun onSensorChanged(e: SensorEvent) {
        val v = e.values
        if (e.sensor.type == Sensor.TYPE_LINEAR_ACCELERATION) { acc = sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]); return }
        // Gyroscope (rad/s → °/s) drives the check, with the newest jolt.
        val deg = 57.29578f
        if (detector.feed(SystemClock.uptimeMillis(), acc, v[0] * deg, v[1] * deg, v[2] * deg)) main.post { flicked() }
    }

    private fun buzz() = runCatching {
        svc.getSystemService(Vibrator::class.java)?.vibrate(VibrationEffect.createOneShot(30, VibrationEffect.DEFAULT_AMPLITUDE))
    }

    // ---- what a flick sends ----

    /**
     * A flick, or "send this to my laptop" said to the Novi mic button (done = the answer for the laptop).
     * It goes at once (user, 2026-11-16: no asking first); the small card only says what happened.
     */
    fun flicked(done: ((Boolean, String) -> Unit)? = null) {
        val answer = { ok: Boolean, note: String -> done?.invoke(ok, note); Unit }
        if (busy) return answer(false, "Still sending the last one.")
        val access = NoviAccess.instance
        val front = access?.frontPackage().orEmpty()
        val shotAge = lastShot?.let { SystemClock.elapsedRealtime() - it.at }
        val choice = flickChoice(
            locked = locked(),
            noviOpen = MainActivity.visible, shotAgeMs = shotAge, accessOn = access != null, frontPkg = front,
            passwordShown = access?.passwordShown() ?: false,
            link = if (access != null && shotAge?.let { it <= 90_000 } != true) access.browserLink() else null,
            canShoot = access?.canShoot() ?: false,
            youtubeTitle = access?.youtubeTitle(),
            selection = access?.selectedText(),
            copyShown = access?.selectedText() == null && access?.copyShown() == true,
            filesOk = Build.VERSION.SDK_INT >= 30 && android.os.Environment.isExternalStorageManager(),
        )
        val no = { text: String -> overlay.result(text, false); answer(false, text) }
        when (choice) {
            FlickSend.PAGE -> { MainActivity.flickPage(); answer(true, "Sent the top card from the flick screen.") }
            FlickSend.SCREENSHOT -> lastShot?.let { s -> lastShot = null; buzz(); send(answer) { readUri(s.uri)?.let { Triple(it, s.name, s.type) } } } ?: no("Nothing to flick here.")
            FlickSend.LINK -> (access?.selectedText()?.let { browserAddress(it) } ?: access?.browserLink())?.let { link -> buzz(); send(answer, kind = "link") { Triple(link.toByteArray(), "link", "") } } ?: no("Nothing to flick here.")
            FlickSend.TEXT -> access?.selectedText()?.let { words -> buzz(); send(answer, kind = "text") { Triple(words.toByteArray(), "text", "text/plain") } } ?: no("Nothing to flick here.")
            // The app didn't say what's selected: press its Copy, then read the clipboard for a moment in front.
            FlickSend.COPY -> {
                buzz()
                if (access?.pressCopy() != true) return no("Couldn't copy the selection.")
                ClipActivity.onRead = { words -> main.post { if (words == null) no("Couldn't read what was copied.") else sendWordsNow(words, answer) } }
                main.postDelayed({ runCatching { svc.startActivity(Intent(svc, ClipActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_NO_ANIMATION)) } }, 250)
            }
            // A file manager or document viewer: the whole file, found by its name on screen.
            FlickSend.FILE -> {
                buzz()
                val (chosen, shown) = access?.screenWords() ?: (emptyList<String>() to emptyList())
                val names = fileNames(chosen, shown)
                Thread {
                    val files = findFiles(names)
                    main.post {
                        if (files.isNotEmpty()) sendFiles(files, answer)
                        else access?.shot { bytes -> main.post { if (bytes == null) no("Couldn't find the file.") else send(answer) { Triple(bytes, "Novi flick ${stamp()}.jpg", "image/jpeg") } } }
                    }
                }.start()
            }
            FlickSend.PICTURE -> {
                buzz()
                val words = access?.screenWords()?.second.orEmpty()
                val video = access?.videoShown() == true
                Thread {
                    val media = shownMedia(words, video)
                    main.post {
                        when {
                            media != null -> sendFileTriples(listOf(media), answer)
                            video -> no("Couldn't tell which video this is. Use Share → Send to Novi for it.")
                            else -> access?.shot(trim = true) { bytes -> main.post { if (bytes == null) no("Couldn't take the picture.") else send(answer) { Triple(bytes, "Novi photo ${stamp()}.jpg", "image/jpeg") } } }
                        }
                    }
                }.start()
            }
            FlickSend.YOUTUBE -> access?.youtubeTitle()?.let { title ->
                buzz()
                pausePhone()
                send(answer, kind = "youtube") { Triple(title.toByteArray(), "youtube", "") }
            } ?: no("Nothing to flick here.")
            // Instagram and other apps: their website opens on the laptop, and a picture of the phone screen lands too.
            FlickSend.APP -> {
                buzz()
                val site = appSite(front)
                access?.shot { bytes ->
                    main.post {
                        if (bytes != null) send(answer, then = { site?.let { s -> sendQuiet(s) } }) { Triple(bytes, "Novi flick ${stamp()}.jpg", "image/jpeg") }
                        else if (site != null) send(answer, kind = "link") { Triple(site.toByteArray(), "link", "") }
                        else no("Couldn't take a picture of the screen.")
                    }
                }
            }
            FlickSend.SCREEN -> {
                buzz()
                access?.shot { bytes -> main.post { if (bytes == null) no("Couldn't take a picture of the screen.") else send(answer) { Triple(bytes, "Novi flick ${stamp()}.jpg", "image/jpeg") } } }
            }
            FlickSend.PRIVATE -> no("Not from this app: it may show private things.")
            FlickSend.NEED_ACCESS -> no("To flick what's on screen, turn on Novi typing in ⚙.")
            FlickSend.NOTHING -> no(if (locked()) "Unlock the phone first." else "Nothing to flick here.")
        }
    }

    /** Sends at once. `what` loads the bytes off the main thread. */
    private fun send(done: (Boolean, String) -> Unit, kind: String = "file", then: () -> Unit = {}, what: () -> Triple<ByteArray, String, String>?) {
        busy = true
        overlay.result("Flicking to the laptop…", true)
        Thread {
            val out = runCatching {
                val (bytes, name, type) = what() ?: throw IllegalStateException("Couldn't read it.")
                lastSent = Triple(bytes, name, type) to kind
                val net = svc.netOrNull() ?: throw IllegalStateException("Not connected to Novi.")
                net.flick(bytes, name, type, kind)
            }
            main.post {
                busy = false
                out.onSuccess { r ->
                    if (r.optBoolean("ok", true)) {
                        then()
                        // "Send to" (user, 2026-11-16): where the thing that just landed goes next.
                        if (kind == "youtube") overlay.result("Playing on the laptop", true) else overlay.landed({ where -> svc.sendText("send the last flick to $where") }, { whatsapp -> share(whatsapp) })
                        done(true, if (kind == "youtube") "It is playing on the laptop." else "It landed on the laptop.")
                    }
                    else r.optString("error", "The laptop didn't take it.").let { overlay.result(it, false); done(false, it) }
                }.onFailure { (it.message ?: "Couldn't reach the laptop.").let { m -> overlay.result(m, false); done(false, m) } }
            }
        }.start()
    }

    /** A second thing that goes with the first (an app's website after its screenshot), with no card of its own. */
    private fun sendQuiet(link: String) = Thread { runCatching { svc.netOrNull()?.flick(link.toByteArray(), "link", "", "link") } }.start()

    /**
     * The thing that just landed, from the phone: WhatsApp's own contact picker (search, tap) or Android's share
     * sheet (recent contacts, Quick Share, Gmail…). Pictures and files go through Novi's FileProvider (cache/share/
     * only, read permission for that one share); links and text go as text.
     */
    private fun share(whatsapp: Boolean) {
        val (data, kind) = lastSent ?: return
        val (bytes, name, type) = data
        val send = Intent(Intent.ACTION_SEND)
        if (kind == "link" || kind == "text") {
            send.type = "text/plain"
            send.putExtra(Intent.EXTRA_TEXT, String(bytes))
        } else {
            val dir = java.io.File(svc.cacheDir, "share").apply { mkdirs() }
            dir.listFiles()?.forEach { it.delete() } // only the newest share is kept
            val safe = name.replace(Regex("""[\\/:*?"<>|]"""), "_").ifBlank { "Novi flick.jpg" }
            val file = java.io.File(dir, safe).apply { writeBytes(bytes) }
            val uri = androidx.core.content.FileProvider.getUriForFile(svc, "${svc.packageName}.flickshare", file)
            send.type = type.ifBlank { "image/jpeg" }
            send.putExtra(Intent.EXTRA_STREAM, uri)
            send.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
        val wa = listOf("com.whatsapp", "com.whatsapp.w4b").firstOrNull { pkg -> runCatching { svc.packageManager.getPackageInfo(pkg, 0) }.isSuccess }
        val intent = if (whatsapp && wa != null) send.setPackage(wa) else Intent.createChooser(send, "Share")
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_GRANT_READ_URI_PERMISSION)
        runCatching { svc.startActivity(intent) }.onFailure { overlay.result("Couldn't open sharing.", false) }
    }

    /** The phone's video stops when it starts on the laptop. */
    private fun pausePhone() = runCatching {
        val am = svc.getSystemService(android.media.AudioManager::class.java)
        am.dispatchMediaKeyEvent(android.view.KeyEvent(android.view.KeyEvent.ACTION_DOWN, android.view.KeyEvent.KEYCODE_MEDIA_PAUSE))
        am.dispatchMediaKeyEvent(android.view.KeyEvent(android.view.KeyEvent.ACTION_UP, android.view.KeyEvent.KEYCODE_MEDIA_PAUSE))
    }

    /** Words (selected text, the selection menu's "Send to Novi"): a link goes as a link, else as text. */
    fun sendWords(words: String) = sendWordsNow(words) { _, _ -> }
    private fun sendWordsNow(words: String, done: (Boolean, String) -> Unit) {
        val link = browserAddress(words)
        if (link != null) send(done, kind = "link") { Triple(link.toByteArray(), "link", "") }
        else send(done, kind = "text") { Triple(words.toByteArray(), "text", "text/plain") }
    }

    /** What the share menu handed over: whole files streamed, links as links. */
    fun sendInbox() {
        val items = FlickInbox.takeItems()
        items.filter { it.link != null }.forEach { sendWords(it.link!!) }
        val files = items.mapNotNull { it.file?.let { f -> Triple(f, it.name, it.type) } }
        if (files.isNotEmpty()) sendFileTriples(files) { _, _ -> }
    }

    private fun sendFiles(files: List<java.io.File>, done: (Boolean, String) -> Unit) =
        sendFileTriples(files.map { Triple(it, it.name, android.webkit.MimeTypeMap.getSingleton().getMimeTypeFromExtension(it.extension.lowercase()) ?: "") }, done)

    private fun sendFileTriples(files: List<Triple<java.io.File, String, String>>, done: (Boolean, String) -> Unit) {
        busy = true
        overlay.result(if (files.size == 1) "Sending ${files[0].second}…" else "Sending ${files.size} files…", true)
        Thread {
            val out = runCatching {
                val net = svc.netOrNull() ?: throw IllegalStateException("Not connected to Novi.")
                files.forEach { (f, name, type) -> net.flickFile(f, name, type) }
            }
            main.post {
                busy = false
                out.onSuccess { overlay.result(if (files.size == 1) "${files[0].second} landed on the laptop" else "${files.size} files landed on the laptop", true); done(true, "It landed on the laptop.") }
                    .onFailure { (it.message ?: "Couldn't reach the laptop.").let { m -> overlay.result(m, false); done(false, m) } }
            }
        }.start()
    }

    /**
     * The original photo/video a gallery has open: the media item taken at the date + time shown on screen
     * (videos first when a player shows), copied into Novi's cache to send. Null when it can't tell.
     */
    private fun shownMedia(words: List<String>, video: Boolean): Triple<java.io.File, String, String>? = runCatching {
        val range = shownWhen(words) ?: return null
        val uri = MediaStore.Files.getContentUri("external")
        val cols = arrayOf(MediaStore.Files.FileColumns._ID, MediaStore.Files.FileColumns.DISPLAY_NAME, MediaStore.Files.FileColumns.MIME_TYPE, MediaStore.Files.FileColumns.MEDIA_TYPE, MediaStore.MediaColumns.DATE_TAKEN)
        val kinds = if (video) "${MediaStore.Files.FileColumns.MEDIA_TYPE} = ${MediaStore.Files.FileColumns.MEDIA_TYPE_VIDEO}"
            else "(${MediaStore.Files.FileColumns.MEDIA_TYPE} = ${MediaStore.Files.FileColumns.MEDIA_TYPE_IMAGE} OR ${MediaStore.Files.FileColumns.MEDIA_TYPE} = ${MediaStore.Files.FileColumns.MEDIA_TYPE_VIDEO})"
        val mid = range.first + (range.last - range.first) / 2
        data class M(val id: Long, val name: String, val type: String, val kind: Int, val at: Long)
        val found = mutableListOf<M>()
        svc.contentResolver.query(uri, cols, "$kinds AND ${MediaStore.MediaColumns.DATE_TAKEN} BETWEEN ? AND ?", arrayOf(range.first.toString(), range.last.toString()), null)?.use { c ->
            while (c.moveToNext()) found.add(M(c.getLong(0), c.getString(1).orEmpty(), c.getString(2).orEmpty(), c.getInt(3), c.getLong(4)))
        }
        // A whole day (no time shown) with several items is a guess: only one item that day counts.
        val dayOnly = range.last - range.first > 10 * 60_000L
        val pick = (if (dayOnly && found.size != 1) null else found.minByOrNull { kotlin.math.abs(it.at - mid) }) ?: return null
        val itemUri = ContentUris.withAppendedId(if (pick.kind == MediaStore.Files.FileColumns.MEDIA_TYPE_VIDEO) MediaStore.Video.Media.EXTERNAL_CONTENT_URI else MediaStore.Images.Media.EXTERNAL_CONTENT_URI, pick.id)
        val dir = java.io.File(svc.cacheDir, "flick-out").apply { mkdirs(); listFiles()?.forEach { it.delete() } }
        val out = java.io.File(dir, pick.name.replace(Regex("""[\\/:*?"<>|]"""), "_").ifBlank { "Novi media" })
        svc.contentResolver.openInputStream(itemUri)?.use { input -> out.outputStream().use { input.copyTo(it) } } ?: return null
        if (out.length() == 0L || out.length() > 300L * 1024 * 1024) return null
        Triple(out, out.name, pick.type)
    }.getOrNull()

    /** The files with these names on the phone (Download, Documents, DCIM, Pictures, WhatsApp…), newest first. */
    private fun findFiles(names: List<String>): List<java.io.File> {
        if (names.isEmpty()) return emptyList()
        val wanted = names.map { it.lowercase() }.toSet()
        val base = android.os.Environment.getExternalStorageDirectory()
        val roots = listOf("Download", "Documents", "DCIM", "Pictures", "Movies", "Music", "Android/media/com.whatsapp/WhatsApp/Media", "WhatsApp/Media").map { java.io.File(base, it) }
        val found = mutableMapOf<String, java.io.File>()
        var seen = 0
        fun walk(dir: java.io.File, depth: Int) {
            if (depth > 6 || seen > 30000 || found.size == wanted.size) return
            for (f in dir.listFiles() ?: return) {
                seen++
                if (f.isDirectory) { if (!f.name.startsWith(".")) walk(f, depth + 1) }
                else { val k = f.name.lowercase(); if (k in wanted && (found[k]?.lastModified() ?: 0) < f.lastModified()) found[k] = f }
            }
        }
        roots.filter { it.isDirectory }.forEach { walk(it, 0) }
        return names.mapNotNull { found[it.lowercase()] }.filter { it.length() <= 300L * 1024 * 1024 }
    }

    /** "Send to Novi" on the screenshot pop-up. */
    private fun sendShot(s: Shot) {
        lastShot = null
        send({ _, _ -> }) { readUri(s.uri)?.let { Triple(it, s.name, s.type) } }
    }

    private fun readUri(uri: Uri): ByteArray? = runCatching {
        svc.contentResolver.openInputStream(uri)?.use { input ->
            val out = java.io.ByteArrayOutputStream()
            val buf = ByteArray(64 * 1024)
            var total = 0
            while (true) { val n = input.read(buf); if (n < 0) break; total += n; if (total > 50 * 1024 * 1024) return null; out.write(buf, 0, n) }
            out.toByteArray()
        }
    }.getOrNull()

    private fun stamp() = java.text.SimpleDateFormat("yyyy-MM-dd HHmmss", java.util.Locale.US).format(java.util.Date())

    // ---- screenshots ----

    private fun checkScreenshot() {
        if (Build.VERSION.SDK_INT < 29 || !store.screenshotPopup || !canReadShots(svc)) return
        val cols = arrayOf(MediaStore.Images.Media._ID, MediaStore.Images.Media.DISPLAY_NAME, MediaStore.Images.Media.RELATIVE_PATH, MediaStore.Images.Media.DATE_ADDED, MediaStore.Images.Media.MIME_TYPE)
        val since = System.currentTimeMillis() / 1000 - 20
        val found = runCatching {
            svc.contentResolver.query(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, cols, "${MediaStore.Images.Media.DATE_ADDED} >= ? AND ${MediaStore.Images.Media.IS_PENDING} = 0", arrayOf(since.toString()), "${MediaStore.Images.Media.DATE_ADDED} DESC")?.use { c ->
                if (!c.moveToFirst()) null else Triple(c.getLong(0), c.getString(1).orEmpty(), Pair(c.getString(2), c.getString(4) ?: "image/png"))
            }
        }.getOrNull() ?: return
        val (id, name, rest) = found
        if (id == lastShotId || !isScreenshot(rest.first, name)) return
        lastShotId = id
        val uri = ContentUris.withAppendedId(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, id)
        val shot = Shot(uri, name, rest.second, SystemClock.elapsedRealtime())
        val thumb: Bitmap? = if (Build.VERSION.SDK_INT >= 29) runCatching { svc.contentResolver.loadThumbnail(uri, Size(160, 240), null) }.getOrNull() else null
        main.post {
            lastShot = shot
            // Never over the cancel window of a flick that is about to go.
            if (!busy) overlay.screenshot(thumb) { sendShot(shot) }
        }
    }

    companion object {
        // Android 13+: photos and videos are two permissions; the screenshot check needs photos only.
        fun shotPermission(): String = if (Build.VERSION.SDK_INT >= 33) Manifest.permission.READ_MEDIA_IMAGES else Manifest.permission.READ_EXTERNAL_STORAGE
        fun shotPermissions(): Array<String> = if (Build.VERSION.SDK_INT >= 34) arrayOf(Manifest.permission.READ_MEDIA_IMAGES, Manifest.permission.READ_MEDIA_VIDEO, Manifest.permission.READ_MEDIA_VISUAL_USER_SELECTED) else arrayOf(shotPermission())
        fun canReadShots(c: Context) = c.checkSelfPermission(shotPermission()) == PackageManager.PERMISSION_GRANTED
    }
}
