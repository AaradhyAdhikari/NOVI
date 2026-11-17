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
    // A slim bar at the top (user, 2026-11-17: the big card "not looking good… a quick slide bar at top"): one row of small
    // chips that slides sideways; the type box only opens from ⌨.
    fun landed(onSend: (String) -> Unit, onShare: ((Boolean) -> Unit)? = null) {
        show(7000, vertical = true, slim = true) { col ->
            val chips = LinearLayout(ctx).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL }
            chips.addView(TextView(ctx).apply { text = "✓ Sent"; textSize = 13f; setTextColor(Color.parseColor("#FF6FE7B0")); setTypeface(typeface, Typeface.BOLD); setPadding(dp(4), 0, dp(8), 0) })
            // WhatsApp = WhatsApp's own picker on the phone (search, tap a contact), Share = Android's share sheet.
            if (onShare != null) chips.addView(chip("WhatsApp") { hide(); onShare(true) })
            for (name in listOf("ChatGPT", "Claude", "Gemini", "Google")) chips.addView(chip(name) { hide(); onSend(name.lowercase()) })
            if (onShare != null) chips.addView(chip("Share") { hide(); onShare(false) })
            val row = LinearLayout(ctx).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL; visibility = View.GONE }
            chips.addView(chip("⌨") { row.visibility = View.VISIBLE; main.removeCallbacks(hideLater) })
            chips.addView(chip("✕") { hide() })
            col.addView(android.widget.HorizontalScrollView(ctx).apply { isHorizontalScrollBarEnabled = false; addView(chips) })
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
            row.addView(chip("Send") { go() })
            col.addView(row)
        }
    }

    private fun chip(label: String, onTap: () -> Unit) = TextView(ctx).apply {
        text = label
        textSize = 13f
        setTextColor(Color.parseColor("#FFE8FBFF"))
        setPadding(dp(12), dp(6), dp(12), dp(6))
        background = GradientDrawable().apply { setColor(Color.parseColor("#FF12343D")); cornerRadius = dp(14).toFloat() }
        layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { rightMargin = dp(6) }
        setOnClickListener { onTap() }
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

    private fun show(ms: Long, vertical: Boolean = false, slim: Boolean = false, fill: (LinearLayout) -> Unit) {
        if (!android.provider.Settings.canDrawOverlays(svc)) return
        hide()
        val outer = LinearLayout(ctx).apply { setPadding(dp(12), 0, dp(12), 0) }
        val row = LinearLayout(ctx).apply {
            orientation = if (vertical) LinearLayout.VERTICAL else LinearLayout.HORIZONTAL
            gravity = if (vertical) Gravity.START else Gravity.CENTER_VERTICAL
            elevation = dp(8).toFloat()
            if (slim) setPadding(dp(8), dp(5), dp(4), dp(5)) else setPadding(dp(12), dp(8), dp(6), dp(8))
            background = GradientDrawable().apply { setColor(Color.parseColor("#F2061E26")); cornerRadius = dp(if (slim) 22 else 18).toFloat(); setStroke(dp(1), Color.parseColor(if (slim) "#663FE0FF" else "#FF3FE0FF")) }
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
