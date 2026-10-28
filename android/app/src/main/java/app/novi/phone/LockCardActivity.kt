package app.novi.phone

import android.app.Activity
import android.app.KeyguardManager
import android.graphics.Color
import android.graphics.Typeface
import android.os.Bundle
import android.view.Gravity
import android.view.ViewGroup
import android.view.WindowManager
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView

/**
 * The card on the lock screen (user, 2026-10-28: "a small screen that opens over the lock screen, with
 * the same buttons and voice answer"). Opened by NoviService's full-screen notification when the phone is
 * locked or its screen is off; it lights the screen up. Novi reads the card out and listens as usual.
 */
class LockCardActivity : Activity() {
    companion object {
        @Volatile var current: LockCardActivity? = null
    }

    private var cardId: String? = null
    private lateinit var status: TextView
    private lateinit var buttons: LinearLayout

    private fun dp(v: Int) = (v * resources.displayMetrics.density).toInt()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setShowWhenLocked(true)
        setTurnScreenOn(true)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        current = this
        show()
    }

    override fun onNewIntent(intent: android.content.Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        show()
    }

    override fun onDestroy() {
        if (current == this) current = null
        super.onDestroy()
    }

    private fun show() {
        val svc = NoviService.instance
        val card = intent.getStringExtra("card")?.let { svc?.cardById(it) }
        if (svc == null || card == null) return finish()
        cardId = card.id
        val col = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER_VERTICAL
            setBackgroundColor(Color.parseColor("#FF111827"))
            setPadding(dp(24), dp(48), dp(24), dp(48))
        }
        col.addView(TextView(this).apply {
            text = "NOVI"
            setTextColor(Color.parseColor("#FF818CF8"))
            textSize = 14f
            setTypeface(typeface, Typeface.BOLD)
        })
        col.addView(TextView(this).apply {
            text = if (card.question != null) "Claude asks" else card.title
            setTextColor(Color.WHITE)
            textSize = 24f
            setTypeface(typeface, Typeface.BOLD)
            setPadding(0, dp(8), 0, dp(8))
        })
        status = TextView(this).apply {
            setTextColor(Color.parseColor("#FFA5B4FC"))
            textSize = 16f
            setPadding(0, 0, 0, dp(24))
        }
        col.addView(status)
        buttons = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        // Claude's question: every option and "Other", like on the pop-up.
        card.question?.let { q ->
            buttons.addView(QuestionForm(this, q, dark = true, onSubmit = { svc.answerQuestion(card, it) }, onSkip = { svc.answer(card, "deny") }).view)
        }
        for (a in if (card.question != null) emptyList() else lockScreenActions(card)) {
            buttons.addView(Button(this).apply {
                text = a.title
                isAllCaps = false
                textSize = 18f
                layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(64)).apply { bottomMargin = dp(12) }
                setOnClickListener {
                    if (a.action == "unlock") unlock() else svc.answer(card, a.action)
                }
            })
        }
        buttons.addView(Button(this).apply {
            text = "Later"
            isAllCaps = false
            layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(56))
            // The card stays waiting: it is on screen as the pop-up once the phone is unlocked.
            setOnClickListener { finish() }
        })
        col.addView(buttons)
        // Long questions scroll.
        setContentView(android.widget.ScrollView(this).apply {
            isFillViewport = true
            setBackgroundColor(Color.parseColor("#FF111827"))
            addView(col)
        })
    }

    /** Opens the phone (PIN / fingerprint); the pop-up card is there afterwards for the Novi PIN. */
    private fun unlock() {
        getSystemService(KeyguardManager::class.java).requestDismissKeyguard(this, object : KeyguardManager.KeyguardDismissCallback() {
            override fun onDismissSucceeded() = finish()
        })
    }

    fun status(id: String, text: String) {
        if (id == cardId) status.text = text
    }

    /** Answered here or anywhere else: say so for a moment, then the lock screen comes back. */
    fun answered(id: String) {
        if (id != cardId) return
        if (status.text.isNullOrBlank()) status.text = "Answered"
        buttons.removeAllViews()
        status.postDelayed({ finish() }, 1500)
    }
}
