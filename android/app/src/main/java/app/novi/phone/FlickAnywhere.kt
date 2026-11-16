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

    private fun flicked() {
        if (busy) return
        val access = NoviAccess.instance
        val front = access?.frontPackage().orEmpty()
        val shotAge = lastShot?.let { SystemClock.elapsedRealtime() - it.at }
        val choice = flickChoice(
            locked = locked(),
            noviOpen = MainActivity.visible, shotAgeMs = shotAge, accessOn = access != null, frontPkg = front,
            passwordShown = access?.passwordShown() ?: false,
            link = if (access != null && shotAge?.let { it <= 90_000 } != true) access.browserLink() else null,
            canShoot = access?.canShoot() ?: false,
        )
        when (choice) {
            FlickSend.PAGE -> MainActivity.flickPage()
            FlickSend.SCREENSHOT -> lastShot?.let { s -> buzz(); sendLater("the screenshot", onStart = { lastShot = null }) { readUri(s.uri)?.let { Triple(it, s.name, s.type) } } }
            FlickSend.LINK -> access?.browserLink()?.let { link -> buzz(); sendLater("the link") { Triple(link.toByteArray(), "link", "") } }
            FlickSend.SCREEN -> { buzz(); access?.shot { bytes -> main.post { if (bytes == null) overlay.result("Couldn't take a picture of the screen.", false) else sendLater("this screen") { Triple(bytes, "Novi flick ${stamp()}.jpg", "image/jpeg") } } } }
            FlickSend.PRIVATE -> overlay.result("Not from this app: it may show private things.", false)
            FlickSend.NEED_ACCESS -> overlay.result("To flick what's on screen, turn on Novi typing in ⚙.", false)
            FlickSend.NOTHING -> overlay.result("Nothing to flick here.", false)
        }
    }

    /** 1.5 s to cancel, then it goes. `what` loads the bytes off the main thread. */
    private fun sendLater(label: String, onStart: () -> Unit = {}, what: () -> Triple<ByteArray, String, String>?) {
        busy = true
        var cancelled = false
        overlay.sending(label) { cancelled = true; busy = false }
        main.postDelayed({
            if (cancelled) return@postDelayed
            onStart()
            Thread {
                val out = runCatching {
                    val (bytes, name, type) = what() ?: throw IllegalStateException("Couldn't read it.")
                    val net = svc.netOrNull() ?: throw IllegalStateException("Not connected to Novi.")
                    net.flick(bytes, name, type, link = name == "link")
                }
                main.post {
                    busy = false
                    out.onSuccess { r -> if (r.optBoolean("ok", true)) overlay.result("Landed on the laptop", true) else overlay.result(r.optString("error", "The laptop didn't take it."), false) }
                        .onFailure { overlay.result(it.message ?: "Couldn't reach the laptop.", false) }
                }
            }.start()
        }, 1500)
    }

    /** "Send to Novi" on the screenshot pop-up: straight away, no wait. */
    private fun sendShot(s: Shot) {
        sendLater("the screenshot", onStart = { lastShot = null }) { readUri(s.uri)?.let { Triple(it, s.name, s.type) } }
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
        fun shotPermission(): String = if (Build.VERSION.SDK_INT >= 33) Manifest.permission.READ_MEDIA_IMAGES else Manifest.permission.READ_EXTERNAL_STORAGE
        fun shotPermissions(): Array<String> = if (Build.VERSION.SDK_INT >= 34) arrayOf(Manifest.permission.READ_MEDIA_IMAGES, Manifest.permission.READ_MEDIA_VISUAL_USER_SELECTED) else arrayOf(shotPermission())
        fun canReadShots(c: Context) = c.checkSelfPermission(shotPermission()) == PackageManager.PERMISSION_GRANTED
    }
}
