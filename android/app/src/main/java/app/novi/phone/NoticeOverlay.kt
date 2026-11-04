package app.novi.phone

import android.graphics.Color
import android.graphics.PixelFormat
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.text.TextUtils
import android.view.ContextThemeWrapper
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView

/**
 * A finished task, small, at the top of the screen: approval cards sit at the bottom, so it never covers
 * one. It only says what happened, so its one button is OK.
 */
class NoticeOverlay(private val svc: NoviService) {
    private val ctx = ContextThemeWrapper(svc, android.R.style.Theme_Material_Light)
    private val wm = svc.getSystemService(WindowManager::class.java)
    private var view: View? = null
    private var shown: Notice? = null

    private fun dp(v: Int) = (v * svc.resources.displayMetrics.density).toInt()

    fun show(notice: Notice, more: Int) {
        if (shown == notice && view != null) return
        hide()
        val v = card(notice, more)
        val params = WindowManager.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.WRAP_CONTENT,
            WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN,
            PixelFormat.TRANSLUCENT,
        ).apply {
            gravity = Gravity.TOP or Gravity.CENTER_HORIZONTAL
            y = dp(44)
        }
        wm.addView(v, params)
        view = v
        shown = notice
        v.translationY = -dp(120).toFloat()
        v.animate().translationY(0f).setDuration(220).start()
    }

    fun hide() {
        view?.let { runCatching { wm.removeView(it) } }
        view = null
        shown = null
    }

    private fun card(n: Notice, more: Int): View {
        val outer = LinearLayout(ctx).apply { setPadding(dp(12), 0, dp(12), 0) }
        val row = LinearLayout(ctx).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            elevation = dp(8).toFloat()
            setPadding(dp(14), dp(8), dp(8), dp(8))
            background = GradientDrawable().apply {
                setColor(Color.WHITE)
                cornerRadius = dp(16).toFloat()
                setStroke(dp(1), Color.parseColor("#FF0B8A4B"))
            }
            layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)
        }
        val words = LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
        }
        words.addView(TextView(ctx).apply {
            text = if (more > 0) "${n.title} (+$more)" else n.title
            textSize = 14f
            setTextColor(Color.BLACK)
            setTypeface(typeface, Typeface.BOLD)
            maxLines = 1
            ellipsize = TextUtils.TruncateAt.END
        })
        if (n.body.isNotBlank()) words.addView(TextView(ctx).apply {
            text = n.body
            textSize = 13f
            setTextColor(Color.DKGRAY)
            maxLines = 2
            ellipsize = TextUtils.TruncateAt.END
        })
        row.addView(words)
        row.addView(Button(ctx).apply {
            text = "OK"
            isAllCaps = false
            minWidth = dp(56)
            minimumWidth = dp(56)
            setOnClickListener { svc.noticeOk(n.id) }
        })
        outer.addView(row)
        return outer
    }
}
