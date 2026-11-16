package app.novi.phone

import android.graphics.Bitmap
import android.graphics.Color
import android.graphics.PixelFormat
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.os.Handler
import android.os.Looper
import android.text.TextUtils
import android.view.ContextThemeWrapper
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.widget.Button
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView

/**
 * Novi Flick v2's small card over any app, high on the screen, never taking the focus:
 * after a screenshot ("Flick your phone to send it", Send to Novi button, gone after 6 s),
 * while a flick is about to go ("Flicking … tap to cancel", 1.5 s), and the result ("Landed on the laptop").
 */
class FlickOverlay(private val svc: NoviService) {
    private val ctx = ContextThemeWrapper(svc, android.R.style.Theme_Material)
    private val wm = svc.getSystemService(WindowManager::class.java)
    private val main = Handler(Looper.getMainLooper())
    private var view: View? = null
    private val hideLater = Runnable { hide() }

    private fun dp(v: Int) = (v * svc.resources.displayMetrics.density).toInt()

    fun screenshot(thumb: Bitmap?, onSend: () -> Unit) = show(6000) { row ->
        thumb?.let { row.addView(ImageView(ctx).apply { setImageBitmap(it); scaleType = ImageView.ScaleType.CENTER_CROP; layoutParams = LinearLayout.LayoutParams(dp(44), dp(64)).apply { rightMargin = dp(10) } }) }
        row.addView(words("Screenshot", "Flick your phone to send it to the laptop"))
        row.addView(button("Send to Novi") { hide(); onSend() })
        row.addView(button("✕") { hide() })
    }

    fun sending(what: String, onCancel: () -> Unit) = show(1700) { row ->
        row.addView(words("Flicking $what to the laptop…", "Tap to cancel"))
        row.addView(button("Cancel") { hide(); onCancel() })
    }

    /** After a landing: quick buttons for the AIs and a box for anywhere else ("Rahul", "Isha on WhatsApp"). */
    fun landed(onSend: (String) -> Unit, onShare: ((Boolean) -> Unit)? = null) {
        show(9000, vertical = true) { col ->
            col.addView(words("✓ Landed on the laptop", "Send it on to:"))
            val chips = LinearLayout(ctx).apply { orientation = LinearLayout.HORIZONTAL }
            for (name in listOf("ChatGPT", "Claude", "Gemini", "Google")) chips.addView(button(name) { hide(); onSend(name.lowercase()) })
            col.addView(android.widget.HorizontalScrollView(ctx).apply { isHorizontalScrollBarEnabled = false; addView(chips) })
            // Share from the phone too (user, 2026-11-16): WhatsApp's own picker (search, tap a contact) or Android's share sheet.
            if (onShare != null) col.addView(LinearLayout(ctx).apply {
                orientation = LinearLayout.HORIZONTAL
                addView(button("WhatsApp") { hide(); onShare(true) })
                addView(button("Share…") { hide(); onShare(false) })
            })
            val row = LinearLayout(ctx).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL }
            val box = android.widget.EditText(ctx).apply {
                hint = "or type: Rahul on WhatsApp…"
                textSize = 14f
                setSingleLine(true)
                setTextColor(Color.parseColor("#FFE8FBFF"))
                setHintTextColor(Color.parseColor("#FF8FC7D3"))
                imeOptions = android.view.inputmethod.EditorInfo.IME_ACTION_SEND
                layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
                // Typing needs the keyboard: the card takes the focus only once the box is tapped, and stays up.
                setOnFocusChangeListener { _, has -> if (has) main.removeCallbacks(hideLater) }
                setOnClickListener { focusable(true); requestFocus() }
            }
            val go = { val t = box.text.toString().trim(); if (t.isNotEmpty()) { hide(); onSend(t) } }
            box.setOnEditorActionListener { _, _, _ -> go(); true }
            row.addView(box)
            row.addView(button("Send") { go() })
            col.addView(row)
            col.addView(button("✕") { hide() })
        }
    }

    private fun focusable(on: Boolean) {
        val v = view ?: return
        val p = v.layoutParams as? WindowManager.LayoutParams ?: return
        p.flags = if (on) p.flags and WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE.inv() else p.flags or WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE
        runCatching { wm.updateViewLayout(v, p) }
        if (on) main.removeCallbacks(hideLater)
    }

    fun result(text: String, ok: Boolean) = show(2200) { row ->
        row.addView(words(if (ok) "✓ $text" else text, ""))
    }

    fun hide() {
        main.removeCallbacks(hideLater)
        view?.let { runCatching { wm.removeView(it) } }
        view = null
    }

    private fun show(ms: Long, vertical: Boolean = false, fill: (LinearLayout) -> Unit) {
        if (!android.provider.Settings.canDrawOverlays(svc)) return
        hide()
        val outer = LinearLayout(ctx).apply { setPadding(dp(12), 0, dp(12), 0) }
        val row = LinearLayout(ctx).apply {
            orientation = if (vertical) LinearLayout.VERTICAL else LinearLayout.HORIZONTAL
            gravity = if (vertical) Gravity.START else Gravity.CENTER_VERTICAL
            elevation = dp(8).toFloat()
            setPadding(dp(12), dp(8), dp(6), dp(8))
            background = GradientDrawable().apply { setColor(Color.parseColor("#F2061E26")); cornerRadius = dp(18).toFloat(); setStroke(dp(1), Color.parseColor("#FF3FE0FF")) }
            layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)
        }
        fill(row)
        outer.addView(row)
        val params = WindowManager.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT,
            WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN,
            PixelFormat.TRANSLUCENT,
        ).apply { gravity = Gravity.TOP or Gravity.CENTER_HORIZONTAL; y = dp(44) }
        runCatching { wm.addView(outer, params) }.onFailure { return }
        view = outer
        outer.translationY = -dp(120).toFloat()
        outer.animate().translationY(0f).setDuration(200).start()
        main.postDelayed(hideLater, ms)
    }

    private fun words(title: String, sub: String) = LinearLayout(ctx).apply {
        orientation = LinearLayout.VERTICAL
        layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
        addView(TextView(ctx).apply { text = title; textSize = 14f; setTextColor(Color.parseColor("#FFE8FBFF")); setTypeface(typeface, Typeface.BOLD); maxLines = 1; ellipsize = TextUtils.TruncateAt.END })
        if (sub.isNotBlank()) addView(TextView(ctx).apply { text = sub; textSize = 12.5f; setTextColor(Color.parseColor("#FF8FC7D3")); maxLines = 2 })
    }

    private fun button(label: String, onTap: () -> Unit) = Button(ctx).apply {
        text = label
        isAllCaps = false
        minWidth = dp(44); minimumWidth = dp(44)
        setOnClickListener { onTap() }
    }
}
