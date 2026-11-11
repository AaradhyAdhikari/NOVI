package app.novi.phone

import android.app.Activity
import android.hardware.biometrics.BiometricManager
import android.hardware.biometrics.BiometricPrompt
import android.os.Build
import android.os.Bundle
import android.os.CancellationSignal
import android.text.InputType
import android.view.Gravity
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView
import org.json.JSONObject
import kotlin.concurrent.thread

/**
 * Fingerprint instead of the PIN (2026-11-11). Two jobs:
 *  - setup ("setup" extra): your PIN once proves it is you, then a new fingerprint key is made and Novi on the
 *    laptop keeps its public half. Needed again after a new fingerprint is added to the phone.
 *  - approve ("card" extra): Novi gives a one-time challenge for that card, your fingerprint unlocks the key, the
 *    signature goes back with the approval, and the laptop checks it.
 * A small window in front, since Android shows the fingerprint prompt only for a visible app.
 */
class FingerprintActivity : Activity() {
    private lateinit var line: TextView
    private val cancel = CancellationSignal()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setFinishOnTouchOutside(false)
        val pad = (16 * resources.displayMetrics.density).toInt()
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(pad, pad, pad, pad)
        }
        line = TextView(this).apply {
            textSize = 17f
            gravity = Gravity.CENTER
            setPadding(0, 0, 0, pad)
        }
        root.addView(line)
        setContentView(root)
        when {
            !Fingerprint.canUse(this) -> done("Add a fingerprint in the phone's Settings first (Android 11 or newer).")
            intent.getBooleanExtra("setup", false) -> setup(root)
            else -> approve(intent.getStringExtra("card").orEmpty(), intent.getStringExtra("title").orEmpty())
        }
    }

    private fun setup(root: LinearLayout) {
        line.text = "Novi will trust the fingerprints on this phone now. Remove anyone else's fingerprints from the phone first: if a new one is added later, you'll set this up again.\n\nYour Novi PIN:"
        val pin = EditText(this).apply {
            inputType = InputType.TYPE_CLASS_NUMBER or InputType.TYPE_NUMBER_VARIATION_PASSWORD
            hint = "PIN"
        }
        root.addView(pin)
        val row = LinearLayout(this)
        row.addView(Button(this).apply {
            text = "Set up"
            setOnClickListener {
                isEnabled = false
                register(pin.text.toString())
            }
        })
        row.addView(Button(this).apply {
            text = "Cancel"
            setOnClickListener { finish() }
        })
        root.addView(row)
    }

    private fun register(pin: String) {
        val net = NoviService.instance?.netOrNull() ?: return done("Not connected to Novi.")
        line.text = "Setting up…"
        thread {
            val result = runCatching {
                val key = Fingerprint.create()
                net.post("/api/fingerprint", JSONObject().put("publicKey", key).put("pin", pin))
            }
            runOnUiThread {
                result.onSuccess { done("Fingerprint is set up. Risky cards from this phone now need your fingerprint. The PIN stays for the laptop.") }
                result.onFailure {
                    Fingerprint.remove()
                    done(it.message ?: "That didn't work.")
                }
            }
        }
    }

    private fun approve(cardId: String, title: String) {
        val svc = NoviService.instance ?: return done("Not connected to Novi.")
        val net = svc.netOrNull() ?: return done("Not connected to Novi.")
        val ready = Fingerprint.prepare()
        if (ready is Fingerprint.Ready.Broken) return done("A new fingerprint was added to this phone, so Novi stopped trusting fingerprints. Set it up again in ⚙ with your PIN, then approve.", cardId)
        if (ready !is Fingerprint.Ready.Yes) return done("Set up fingerprint in ⚙ first.", cardId)
        line.text = title.ifEmpty { "Approve with your fingerprint" }
        thread {
            val nonce = runCatching { net.get("/api/fingerprint/challenge?id=${java.net.URLEncoder.encode(cardId, "UTF-8")}").optString("nonce") }.getOrNull()
            runOnUiThread {
                if (nonce.isNullOrEmpty()) return@runOnUiThread done("That card was already answered.", cardId)
                prompt(ready, cardId, nonce, title, svc)
            }
        }
    }

    private fun prompt(ready: Fingerprint.Ready.Yes, cardId: String, nonce: String, title: String, svc: NoviService) {
        val builder = BiometricPrompt.Builder(this)
            .setTitle("Approve with your fingerprint")
            .setSubtitle(title.take(80))
            .setNegativeButton("Cancel", mainExecutor) { _, _ -> done("Not approved.", cardId) }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) builder.setAllowedAuthenticators(BiometricManager.Authenticators.BIOMETRIC_STRONG)
        builder.build().authenticate(BiometricPrompt.CryptoObject(ready.signature), cancel, mainExecutor, object : BiometricPrompt.AuthenticationCallback() {
            override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
                val sig = runCatching { Fingerprint.sign(result.cryptoObject!!.signature!!, cardId, nonce) }.getOrNull()
                    ?: return done("The fingerprint key didn't sign. Try again.", cardId)
                svc.sendFingerprint(cardId, nonce, sig)
                finish()
            }
            override fun onAuthenticationError(errorCode: Int, errString: CharSequence) = done(errString.toString(), cardId)
        })
    }

    private fun done(text: String, cardId: String? = null) {
        if (cardId != null && cardId.isNotEmpty()) NoviService.instance?.showStatus(cardId, text)
        line.text = text
        line.postDelayed({ if (!isFinishing) finish() }, 2500)
    }

    override fun onDestroy() {
        cancel.cancel()
        super.onDestroy()
    }
}
