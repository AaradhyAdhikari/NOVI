package app.novi.phone

import android.Manifest
import android.annotation.SuppressLint
import android.app.AlertDialog
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.PowerManager
import android.provider.Settings
import android.text.InputType
import android.view.ViewGroup
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import androidx.activity.ComponentActivity
import com.journeyapps.barcodescanner.ScanContract
import com.journeyapps.barcodescanner.ScanOptions
import org.json.JSONObject
import kotlin.concurrent.thread

/** Setup: pair with Novi once, give the permissions, try a test card (⚙ in the app; first run). */
class SetupActivity : ComponentActivity() {
    private lateinit var store: Store
    private lateinit var state: TextView
    private lateinit var link: EditText
    private lateinit var perms: LinearLayout
    private lateinit var info: TextView

    private val scan = registerForActivityResult(ScanContract()) { result ->
        result.contents?.let {
            link.setText(it)
            pair(it)
        }
    }

    private fun dp(v: Int) = (v * resources.displayMetrics.density).toInt()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        store = Store(this)
        val col = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(20), dp(28), dp(20), dp(20))
        }
        col.addView(TextView(this).apply {
            text = "Novi"
            textSize = 30f
        })
        state = TextView(this).apply {
            textSize = 16f
            setPadding(0, dp(4), 0, dp(16))
        }
        col.addView(state)

        col.addView(heading("1. Connect to your laptop"))
        col.addView(TextView(this).apply {
            text = "Scan the pairing QR in Novi on the laptop (Settings → Phone), or type the laptop's Tailscale name (like mylaptop.tail1234.ts.net) if this phone is on your Tailscale."
        })
        link = EditText(this).apply {
            hint = "Laptop name or pairing link"
            inputType = InputType.TYPE_TEXT_VARIATION_URI
            setSingleLine()
            setText(store.base.orEmpty())
        }
        col.addView(link)
        col.addView(row(
            button("Scan QR") { scan.launch(ScanOptions().setPrompt("Scan the QR from Novi on the laptop").setBeepEnabled(false).setOrientationLocked(false)) },
            button("Connect") { pair(link.text.toString()) },
        ))

        col.addView(heading("2. Allow these"))
        perms = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        col.addView(perms)

        col.addView(heading("Novi's voice volume"))
        val level = TextView(this).apply { text = "${store.voicePercent}%" }
        col.addView(level)
        col.addView(android.widget.SeekBar(this).apply {
            max = 90
            progress = store.voicePercent - 10
            setOnSeekBarChangeListener(object : android.widget.SeekBar.OnSeekBarChangeListener {
                override fun onProgressChanged(bar: android.widget.SeekBar, value: Int, fromUser: Boolean) {
                    level.text = "${value + 10}%"
                }
                override fun onStartTrackingTouch(bar: android.widget.SeekBar) {}
                override fun onStopTrackingTouch(bar: android.widget.SeekBar) {
                    store.voicePercent = bar.progress + 10
                    NoviService.instance?.say("This is how loud I'll be.", always = true)
                }
            })
        })

        col.addView(android.widget.Switch(this).apply {
            text = "Short read-outs: she never lists the options"
            isChecked = store.shortReadOuts
            setOnCheckedChangeListener { _, on -> store.shortReadOuts = on }
        })
        col.addView(android.widget.Switch(this).apply {
            text = "Speak only through earbuds: silent cards without them"
            isChecked = store.earbudsOnly
            setOnCheckedChangeListener { _, on -> store.earbudsOnly = on }
        })

        // Novi Flick v2 (2026-11-16): the wrist flick on any screen, and the pop-up after a screenshot.
        col.addView(android.widget.Switch(this).apply {
            text = "Flick anywhere: flick your phone toward the laptop to send what is on screen"
            isChecked = store.flickAnywhere
            setOnCheckedChangeListener { _, on -> store.flickAnywhere = on; NoviService.instance?.flickRefresh() }
        })
        // Flick down pulls from the laptop, a circle in the air brings a picture of its screen (2026-11-18).
        col.addView(android.widget.Switch(this).apply {
            text = "Swap flick up / down (if flicking up pulls instead of sends)"
            isChecked = store.flickSwapped
            setOnCheckedChangeListener { _, on -> store.flickSwapped = on }
        })
        col.addView(android.widget.Switch(this).apply {
            text = "Screenshot pop-up: Send to Novi after each screenshot"
            isChecked = store.screenshotPopup
            setOnCheckedChangeListener { _, on -> store.screenshotPopup = on; NoviService.instance?.flickRefresh() }
        })

        col.addView(heading("3. Try it"))
        col.addView(row(
            button("Send a test card") {
                val svc = NoviService.instance ?: return@button say("Not connected yet.")
                svc.testCard(::say)
            },
            button("Forget laptop") {
                NoviService.stop(this)
                store.forget()
                say("Forgotten. Connect again to use Novi here.")
                refresh()
            },
        ))
        info = TextView(this).apply { setPadding(0, dp(8), 0, 0) }
        col.addView(info)

        setContentView(ScrollView(this).apply { addView(col) })
        if (store.paired) NoviService.start(this)
    }

    override fun onResume() {
        super.onResume()
        NoviService.onState = { refresh() }
        NoviService.instance?.flickRefresh() // photos permission may have been given in Android Settings
        refresh()
    }

    override fun onPause() {
        NoviService.onState = null
        super.onPause()
    }

    private fun heading(t: String) = TextView(this).apply {
        text = t
        textSize = 18f
        setPadding(0, dp(18), 0, dp(6))
    }

    private fun button(label: String, onTap: () -> Unit) = Button(this).apply {
        text = label
        isAllCaps = false
        setOnClickListener { onTap() }
        layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
    }

    private fun row(vararg views: Button) = LinearLayout(this).apply { views.forEach { addView(it) } }

    private fun say(text: String) = runOnUiThread { info.text = text }

    private fun refresh() {
        state.text = if (store.paired) NoviService.stateText else "Not connected to a laptop yet."
        perms.removeAllViews()
        val pm = getSystemService(PowerManager::class.java)
        permission("Show cards over other apps", Settings.canDrawOverlays(this)) {
            startActivity(Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, Uri.parse("package:$packageName")))
        }
        if (Build.VERSION.SDK_INT >= 33) {
            permission("Notifications", granted(Manifest.permission.POST_NOTIFICATIONS)) {
                requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 2)
            }
        }
        if (Build.VERSION.SDK_INT >= 34) {
            val nm = getSystemService(android.app.NotificationManager::class.java)
            permission("Cards on the lock screen", nm.canUseFullScreenIntent()) {
                startActivity(Intent(Settings.ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT, Uri.parse("package:$packageName")))
            }
        }
        permission("Microphone (answer by voice)", granted(Manifest.permission.RECORD_AUDIO)) {
            requestPermissions(arrayOf(Manifest.permission.RECORD_AUDIO), 3)
        }
        // Phone typing (2026-10-29): Android lets only the user switch an Accessibility service on.
        permission("Phone typing + flick what is on screen: Settings → Accessibility → Novi", NoviAccess.instance != null) {
            startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS))
        }
        // One tap off (user, 2026-11-18, until Novi is on the Play Store): Google Pay blocks payments while an app
        // installed from a file has Accessibility on. A service may switch itself off; only the user can switch it on.
        // Fixed 2026-11-19 ("the payment thing is not working"): always shown (typing may already be off), waits until
        // Android really lists Novi's service as off, hides everything Novi draws (PayMode), ends Google Pay's old
        // copy that still remembers the block, then opens it fresh.
        perms.addView(Button(this).apply {
            text = "💳 Pay: Novi steps aside and opens Google Pay"
            isAllCaps = false
            setOnClickListener { button ->
                button.isEnabled = false
                text = "Getting out of the way…"
                PayMode.start()
                NoviService.instance?.payStarted()
                NoviAccess.instance?.disableSelf()
                val am = getSystemService(android.view.accessibility.AccessibilityManager::class.java)
                val began = System.currentTimeMillis()
                fun novisServiceOn() = am?.getEnabledAccessibilityServiceList(android.accessibilityservice.AccessibilityServiceInfo.FEEDBACK_ALL_MASK)
                    ?.any { it.resolveInfo?.serviceInfo?.packageName == packageName } == true
                fun open() {
                    val acts = getSystemService(android.app.ActivityManager::class.java)
                    val pkg = PAY_APPS.firstOrNull { packageManager.getLaunchIntentForPackage(it) != null }
                    if (pkg == null) {
                        text = "Novi is out of the way for ${PayMode.MINUTES} min. Open your payment app."
                        return
                    }
                    runCatching { acts?.killBackgroundProcesses(pkg) }
                    text = if (novisServiceOn()) "Android didn't turn Novi typing off. Turn it off in Settings → Accessibility → Novi."
                        else "Novi is out of the way for ${PayMode.MINUTES} min."
                    postDelayed({
                        packageManager.getLaunchIntentForPackage(pkg)?.let {
                            startActivity(it.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK))
                        }
                    }, 400)
                }
                fun waitOff() {
                    if (!novisServiceOn() || System.currentTimeMillis() - began > 3000) open() else postDelayed({ waitOff() }, 150)
                }
                waitOff()
            }
        })
        // Novi Flick v2: reading new screenshots (only to offer sending them; nothing leaves without a flick or a tap).
        // Android 14 "Select photos" gives only chosen photos: a new screenshot needs "Allow all".
        permission("Photos (Allow all): offer to send new screenshots", FlickAnywhere.canReadShots(this)) {
            requestPermissions(FlickAnywhere.shotPermissions(), 4)
        }
        // Novi Flick: whole files from file managers / document viewers (found by name, sent only when you flick).
        if (Build.VERSION.SDK_INT >= 30) {
            permission("All files: flick sends the whole file", android.os.Environment.isExternalStorageManager()) {
                runCatching { startActivity(Intent(Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION, Uri.parse("package:$packageName"))) }
                    .onFailure { startActivity(Intent(Settings.ACTION_MANAGE_ALL_FILES_ACCESS_PERMISSION)) }
            }
        }
        // Fingerprint instead of the PIN on risky cards (2026-11-11); set up again after a new fingerprint is added.
        if (Fingerprint.canUse(this)) {
            permission("Fingerprint for risky cards", Fingerprint.has()) {
                startActivity(Intent(this, FingerprintActivity::class.java).putExtra("setup", true))
            }
        }
        permission("Keep running (no battery limit)", pm.isIgnoringBatteryOptimizations(packageName)) {
            @SuppressLint("BatteryLife")
            val i = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:$packageName"))
            startActivity(i)
        }
    }

    private fun granted(p: String) = checkSelfPermission(p) == PackageManager.PERMISSION_GRANTED

    private fun permission(label: String, ok: Boolean, ask: () -> Unit) {
        perms.addView(Button(this).apply {
            text = if (ok) "✓ $label" else "Allow: $label"
            isAllCaps = false
            isEnabled = !ok
            setOnClickListener { ask() }
        })
    }

    @Deprecated("old API, enough for three permission buttons")
    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == 4) NoviService.instance?.flickRefresh()
        refresh()
    }

    /**
     * A QR link has a one-time code (/api/pair). Without one, a phone on the laptop owner's own Tailscale
     * account is let in by itself (/api/pair/auto). A laptop certificate Android doesn't already trust
     * (self-signed, on the home Wi-Fi) is shown once and pinned only if the user accepts it.
     */
    private fun pair(text: String) {
        val target = parsePairLink(text) ?: return say("That isn't a Novi address. Scan the QR from Novi on the laptop.")
        say("Connecting to ${target.base}…")
        thread {
            val cert = runCatching { Net.probe(target.base) }
            cert.onFailure { return@thread say(it.message ?: "Couldn't reach the laptop.") }
            val c = cert.getOrNull()
            if (c == null) finishPair(target, null)
            else runOnUiThread {
                AlertDialog.Builder(this)
                    .setTitle("Trust this laptop?")
                    .setMessage("This address uses Novi's own certificate (not Tailscale's), so Android can't check it.\n\nCertificate:\n${c.second}\n\nOnly continue on your own network, with your own laptop.")
                    .setPositiveButton("Trust") { _, _ -> thread { finishPair(target, c.first) } }
                    .setNegativeButton("Cancel") { _, _ -> say("Not connected.") }
                    .show()
            }
        }
    }

    private fun finishPair(target: PairLink, pin: String?) {
        val net = Net(target.base, null, pin)
        val name = "Novi app (${Build.MANUFACTURER.replaceFirstChar { it.uppercase() }} ${Build.MODEL})"
        val result = runCatching {
            if (target.code != null) net.post("/api/pair", JSONObject().put("code", target.code).put("name", name))
            else net.post("/api/pair/auto", JSONObject().put("name", name))
        }
        result.onFailure {
            return say(
                if (target.code == null) "This phone isn't let in by itself (${it.message}). Scan the pairing QR from Novi on the laptop instead."
                else "Pairing failed: ${it.message} The QR code changes after each try, so scan it again.",
            )
        }
        val token = result.getOrThrow().optString("token")
        if (token.isEmpty()) return say("Novi didn't send a token. Try again.")
        NoviService.stop(this)
        store.base = target.base
        store.token = token
        store.pin = pin
        NoviService.start(this)
        say("Paired. Cards from Novi will show up here, over any app.")
        runOnUiThread { refresh() }
    }
}
