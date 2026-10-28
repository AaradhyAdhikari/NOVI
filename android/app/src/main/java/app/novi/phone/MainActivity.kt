package app.novi.phone

import android.Manifest
import android.annotation.SuppressLint
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.graphics.drawable.GradientDrawable
import android.net.http.SslError
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.view.Gravity
import android.webkit.PermissionRequest
import android.webkit.SslErrorHandler
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import android.widget.TextView
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import java.security.MessageDigest

/**
 * The one Novi app (user, 2026-10-28: "I only want one Novi app"): the full Novi page (chat, talk,
 * settings, memory) inside the app, signed in with this phone's own token. Cards still pop up over other
 * apps and on the lock screen through NoviService; while this page is open, the page shows them itself.
 * ⚙ (bottom left) opens the setup screen.
 */
class MainActivity : ComponentActivity() {
    companion object {
        /** The Novi page is on screen (NoviService then leaves the cards to it). */
        @Volatile var visible = false
    }

    private lateinit var store: Store
    private var web: WebView? = null
    private var loadedBase: String? = null
    private var signedIn = false

    private fun dp(v: Int) = (v * resources.displayMetrics.density).toInt()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        store = Store(this)
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                val w = web
                if (w != null && w.canGoBack()) w.goBack() else moveTaskToBack(true)
            }
        })
    }

    override fun onResume() {
        super.onResume()
        // First run, or the pop-up permission not given yet: the setup screen first.
        if (!store.paired || !Settings.canDrawOverlays(this)) {
            startActivity(Intent(this, SetupActivity::class.java))
            return
        }
        NoviService.start(this)
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(arrayOf(Manifest.permission.RECORD_AUDIO), 1)
        }
        if (web == null || loadedBase != store.base) show()
        visible = true
        NoviService.instance?.pageShown(true)
    }

    override fun onPause() {
        visible = false
        NoviService.instance?.pageShown(false)
        super.onPause()
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun show() {
        val base = store.base ?: return
        val token = store.token ?: return
        val pin = store.pin
        signedIn = false
        val w = WebView(this).apply {
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.mediaPlaybackRequiresUserGesture = false
            webViewClient = object : WebViewClient() {
                // Novi's own pages stay here; any other link opens in the phone's browser.
                override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                    if (request.url.toString().startsWith(base)) return false
                    runCatching { startActivity(Intent(Intent.ACTION_VIEW, request.url)) }
                    return true
                }

                // The page signs in with this phone's token (the web app keeps it as "novi.token").
                override fun onPageFinished(view: WebView, url: String) {
                    if (signedIn || !url.startsWith(base)) return
                    val js = "(function(){var t=${jsString(token)};if(localStorage.getItem('novi.token')!==t){localStorage.setItem('novi.token',t);return 'set';}return 'ok';})()"
                    view.evaluateJavascript(js) { r ->
                        signedIn = true
                        if (r.contains("set")) view.reload()
                    }
                }

                // A laptop certificate Android doesn't trust: only the exact one accepted at pairing.
                override fun onReceivedSslError(view: WebView, handler: SslErrorHandler, error: SslError) {
                    val x509 = if (Build.VERSION.SDK_INT >= 29) error.certificate.x509Certificate else null
                    val ok = pin != null && x509 != null &&
                        MessageDigest.getInstance("SHA-256").digest(x509.encoded).joinToString("") { "%02x".format(it.toInt() and 0xFF) } == pin
                    if (ok) handler.proceed() else handler.cancel()
                }
            }
            webChromeClient = object : WebChromeClient() {
                // The talk button: the mic, for Novi's own page only.
                override fun onPermissionRequest(request: PermissionRequest) {
                    val ours = request.origin.toString().startsWith(base)
                    val mic = checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED
                    val wanted = request.resources.filter { it == PermissionRequest.RESOURCE_AUDIO_CAPTURE }
                    if (ours && mic && wanted.isNotEmpty()) request.grant(wanted.toTypedArray()) else request.deny()
                }
            }
            loadUrl("$base/")
        }
        web?.destroy()
        web = w
        loadedBase = base
        val frame = FrameLayout(this)
        frame.addView(w)
        frame.addView(TextView(this).apply {
            text = "⚙"
            textSize = 18f
            gravity = Gravity.CENTER
            setTextColor(Color.WHITE)
            contentDescription = "Novi app setup"
            background = GradientDrawable().apply {
                shape = GradientDrawable.OVAL
                setColor(Color.parseColor("#994F46E5"))
            }
            setOnClickListener { startActivity(Intent(this@MainActivity, SetupActivity::class.java)) }
            layoutParams = FrameLayout.LayoutParams(dp(40), dp(40), Gravity.BOTTOM or Gravity.START).apply {
                leftMargin = dp(10)
                bottomMargin = dp(90)
            }
        })
        setContentView(frame)
    }

    private fun jsString(s: String) = "'" + s.replace("\\", "\\\\").replace("'", "\\'") + "'"

    override fun onDestroy() {
        web?.destroy()
        web = null
        super.onDestroy()
    }
}
