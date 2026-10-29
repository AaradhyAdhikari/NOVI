package app.novi.phone

import android.content.Context
import android.graphics.PixelFormat
import android.graphics.drawable.GradientDrawable
import android.provider.Settings
import android.view.Gravity
import android.view.MotionEvent
import android.view.WindowManager
import android.widget.ImageView
import kotlin.math.abs

/**
 * Phone typing (2026-10-29): a small Novi mic over every app while Novi's typing (NoviAccess) is on, so
 * the user can speak inside WhatsApp, Chrome… ("type hi and send"). Tap = listen; drag = move it. Never
 * focusable, so the app underneath keeps its text box and cursor. Hidden while the Novi app is open.
 */
class MicBubble(private val context: Context, private val onTap: () -> Unit) {
    private val wm = context.getSystemService(WindowManager::class.java)
    private var view: ImageView? = null
    private val size = (56 * context.resources.displayMetrics.density).toInt()
    private val params = WindowManager.LayoutParams(
        size, size,
        WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
        WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN,
        PixelFormat.TRANSLUCENT,
    ).apply {
        gravity = Gravity.END or Gravity.CENTER_VERTICAL
        x = (8 * context.resources.displayMetrics.density).toInt()
    }

    /** Shown when typing is on, the overlay is allowed and the Novi app isn't on screen. */
    fun update(wanted: Boolean) {
        val show = wanted && Settings.canDrawOverlays(context)
        if (show && view == null) add() else if (!show) remove()
    }

    fun listening(on: Boolean) {
        (view?.background as? GradientDrawable)?.setColor(if (on) 0xFFE5484D.toInt() else 0xFF6E56CF.toInt())
    }

    private fun add() {
        val v = ImageView(context).apply {
            setImageResource(R.drawable.ic_novi)
            setColorFilter(0xFFFFFFFF.toInt())
            val pad = size / 4
            setPadding(pad, pad, pad, pad)
            background = GradientDrawable().apply { shape = GradientDrawable.OVAL; setColor(0xFF6E56CF.toInt()) }
            elevation = 8f
            contentDescription = "Talk to Novi"
        }
        var downY = 0f
        var startY = 0
        var moved = false
        v.setOnTouchListener { _, e ->
            when (e.action) {
                MotionEvent.ACTION_DOWN -> { downY = e.rawY; startY = params.y; moved = false }
                MotionEvent.ACTION_MOVE -> {
                    val dy = (e.rawY - downY).toInt()
                    if (abs(dy) > 12) moved = true
                    if (moved) { params.y = startY + dy; runCatching { wm.updateViewLayout(v, params) } }
                }
                MotionEvent.ACTION_UP -> if (!moved) onTap()
            }
            true
        }
        runCatching { wm.addView(v, params) }.onSuccess { view = v }
    }

    fun remove() {
        view?.let { runCatching { wm.removeView(it) } }
        view = null
    }
}
