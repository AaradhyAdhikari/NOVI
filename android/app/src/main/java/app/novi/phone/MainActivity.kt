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

/** Pair with Novi once, give the permissions, try a test card. Everything else happens in NoviService. */
class MainActivity : ComponentActivity() {
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
