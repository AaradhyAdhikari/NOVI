package app.novi.phone

import android.app.Activity
import android.app.NotificationManager
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.Gravity
import android.view.ViewGroup
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView

/**
 * A finished task over the lock screen, opened the same way as the approval card because Android lets an
 * activity light the screen up where a wake lock is ignored (live 2026-11-05). Small, with one OK. Unanswered
 * it steps aside after a while: the card still waits as the notification, and as the pop-up after unlocking.
 */
class LockNoticeActivity : Activity() {
    companion object {
        @Volatile var current: LockNoticeActivity? = null
        private const val SHOW_MS = 20_000L
    }

    private val main = Handler(Looper.getMainLooper())
    private var noticeId: String? = null

    private fun dp(v: Int) = (v * resources.displayMetrics.density).toInt()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setShowWhenLocked(true)
        setTurnScreenOn(true)
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
        main.removeCallbacksAndMessages(null)
        getSystemService(NotificationManager::class.java).cancel(LOCK_NOTICE_ID)
        super.onDestroy()
    }

    /** OK came from somewhere else. */
    fun gone(id: String) {
        if (id == noticeId) finish()
    }

    private fun show() {
        val id = intent.getStringExtra("id") ?: return finish()
        noticeId = id
        main.removeCallbacksAndMessages(null)
        main.postDelayed({ finish() }, SHOW_MS)
        val page = LinearLayout(this).apply {
            gravity = Gravity.CENTER
            setBackgroundColor(Color.parseColor("#FF111827"))
            setPadding(dp(20), 0, dp(20), 0)
        }
        val card = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(16), dp(12), dp(10), dp(12))
            background = GradientDrawable().apply {
                setColor(Color.parseColor("#FF1F2937"))
                cornerRadius = dp(16).toFloat()
                setStroke(dp(1), Color.parseColor("#FF34D399"))
            }
            layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)
        }
        val words = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
        }
        words.addView(TextView(this).apply {
            text = intent.getStringExtra("title").orEmpty()
            textSize = 16f
            setTextColor(Color.WHITE)
            setTypeface(typeface, Typeface.BOLD)
        })
        val body = intent.getStringExtra("body").orEmpty()
        if (body.isNotBlank()) words.addView(TextView(this).apply {
            text = body
            textSize = 14f
            setTextColor(Color.parseColor("#FFD1D5DB"))
            maxLines = 3
        })
        card.addView(words)
        card.addView(Button(this).apply {
            text = "OK"
            isAllCaps = false
            setOnClickListener {
                NoviService.instance?.noticeOk(id)
                finish()
            }
        })
        page.addView(card)
        setContentView(page)
    }
}
