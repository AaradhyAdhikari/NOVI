package app.novi.phone

import android.graphics.Color
import android.graphics.PixelFormat
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.view.ContextThemeWrapper
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.widget.Button
import android.widget.GridLayout
import android.widget.LinearLayout
import android.widget.TextView

/**
 * The card at the bottom of the screen, over any app (even a full-screen video). It never takes the
 * keyboard focus and stays until the card is answered; "Later" shrinks it to a small pill.
 */
class CardOverlay(private val svc: NoviService) {
    private val ctx = ContextThemeWrapper(svc, android.R.style.Theme_Material_Light)
    private val wm = svc.getSystemService(WindowManager::class.java)
    private var view: View? = null
    private var card: Card? = null
    private var count = 0
    private var collapsed = false
    private var statusView: TextView? = null
    private var pinArea: LinearLayout? = null
    private var buttons: LinearLayout? = null
    private var form: View? = null
    private var params: WindowManager.LayoutParams? = null

    private fun dp(v: Int) = (v * svc.resources.displayMetrics.density).toInt()

    fun show(top: Card, total: Int) {
        // Same card: keep the view as it is (a half-typed answer is never lost).
        val same = card?.id == top.id && view != null
        if (card?.id != top.id) collapsed = false
        card = top
        count = total
        if (!same) render(slide = view == null)
    }

    fun hide() {
        view?.let { runCatching { wm.removeView(it) } }
        view = null
        card = null
    }

    /** A short line under the card's title ("Sending…", "Approved", "PIN not accepted…"). */
    fun status(id: String, text: String) {
        if (card?.id != id) return
        statusView?.apply {
            this.text = text
            visibility = View.VISIBLE
        }
    }

    /** Answered here or anywhere else: say so for a moment, then the service shows the next card. */
    fun answered(id: String) {
        if (card?.id != id) return
        if (statusView?.visibility != View.VISIBLE) status(id, "Answered")
        buttons?.visibility = View.GONE
        pinArea?.visibility = View.GONE
        form?.visibility = View.GONE
        typing(false)
    }

    /** A card this phone can't approve by itself (fingerprint, at the laptop…): open Novi for it. */
    fun needsNovi(id: String, text: String) {
        status(id, text)
        val c = card ?: return
        buttons?.let { row ->
            row.removeAllViews()
            row.addView(button("Open Novi") { svc.openNovi(c.id) })
            row.addView(button("Deny") { svc.answer(c, "deny") })
        }
    }

    fun showPin(id: String, typed: Boolean) {
        val c = card ?: return
        if (c.id != id) return
        val area = pinArea ?: return
        area.removeAllViews()
        buttons?.visibility = View.GONE
        if (typed) {
            var digits = ""
            val shown = TextView(ctx).apply {
                textSize = 26f
                gravity = Gravity.CENTER
                letterSpacing = 0.3f
                text = "Type your PIN"
            }
            area.addView(shown)
            val grid = GridLayout(ctx).apply { columnCount = 3 }
            val keys = listOf("1", "2", "3", "4", "5", "6", "7", "8", "9", "⌫", "0", "OK")
            for (k in keys) {
                grid.addView(button(k) {
                    when (k) {
                        "⌫" -> digits = digits.dropLast(1)
                        "OK" -> if (digits.length >= 4) {
                            svc.sendPin(c.id, typed = digits)
                            digits = ""
                        }
                        else -> if (digits.length < 8) digits += k
                    }
                    shown.text = if (digits.isEmpty()) "Type your PIN" else "•".repeat(digits.length)
                }.apply {
                    layoutParams = GridLayout.LayoutParams().apply {
                        width = 0
                        columnSpec = GridLayout.spec(GridLayout.UNDEFINED, 1f)
                    }
                })
            }
            area.addView(grid)
        }
        val row = LinearLayout(ctx).apply { orientation = LinearLayout.HORIZONTAL }
        row.addView(button("🎤 Say PIN") { svc.listen(c.id, c.title, pin = true) })
        row.addView(button("Cancel") {
            area.visibility = View.GONE
            buttons?.visibility = View.VISIBLE
        })
        area.addView(row)
        area.visibility = View.VISIBLE
        status(id, if (typed) "Approving needs your PIN." else "Say your PIN to approve (typed PINs are off in Novi Settings).")
    }

    private fun button(label: String, onTap: () -> Unit) = Button(ctx).apply {
        text = label
        isAllCaps = false
        setOnClickListener { onTap() }
        layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f).apply { marginEnd = dp(4) }
    }

    private fun render(slide: Boolean) {
        val c = card ?: return
        view?.let { runCatching { wm.removeView(it) } }
        val v = if (collapsed) pill(c) else full(c)
        val params = WindowManager.LayoutParams(
            if (collapsed) ViewGroup.LayoutParams.WRAP_CONTENT else ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.WRAP_CONTENT,
            WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN,
            PixelFormat.TRANSLUCENT,
        ).apply {
            gravity = Gravity.BOTTOM or if (collapsed) Gravity.END else Gravity.CENTER_HORIZONTAL
            y = dp(24)
            x = if (collapsed) dp(12) else 0
        }
        wm.addView(v, params)
        this.params = params
        view = v
        if (slide) {
            v.translationY = dp(400).toFloat()
            v.animate().translationY(0f).setDuration(280).start()
        }
    }

    private fun box() = GradientDrawable().apply {
        setColor(Color.WHITE)
        cornerRadius = dp(20).toFloat()
        setStroke(dp(1), Color.parseColor("#FF4F46E5"))
    }

    private fun pill(c: Card): View = TextView(ctx).apply {
        text = if (count > 1) "Novi · $count cards" else "Novi · 1 card"
        setTextColor(Color.WHITE)
        background = GradientDrawable().apply {
            setColor(Color.parseColor("#FF4F46E5"))
            cornerRadius = dp(24).toFloat()
        }
        setPadding(dp(18), dp(10), dp(18), dp(10))
        elevation = dp(8).toFloat()
        setOnClickListener {
            collapsed = false
            render(slide = true)
        }
        contentDescription = c.title
    }

    private fun full(c: Card): View {
        val outer = LinearLayout(ctx).apply { setPadding(dp(12), 0, dp(12), 0) }
        val root = LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            background = box()
            elevation = dp(10).toFloat()
            setPadding(dp(16), dp(12), dp(16), dp(12))
            layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)
        }
        outer.addView(root)

        val head = LinearLayout(ctx).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
        }
        head.addView(TextView(ctx).apply {
            text = if (count > 1) "NOVI · 1 of $count" else "NOVI"
            setTextColor(Color.parseColor("#FF4F46E5"))
            textSize = 12f
            setTypeface(typeface, Typeface.BOLD)
            layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
        })
        head.addView(TextView(ctx).apply {
            text = "Later"
            setTextColor(Color.GRAY)
            setPadding(dp(12), dp(4), dp(4), dp(4))
            setOnClickListener {
                collapsed = true
                render(slide = false)
            }
        })
        root.addView(head)

        root.addView(TextView(ctx).apply {
            text = if (c.question != null) "Claude asks" else c.title
            textSize = 17f
            setTextColor(Color.BLACK)
            setTypeface(typeface, Typeface.BOLD)
            setPadding(0, dp(4), 0, dp(2))
        })
        if (c.body.isNotBlank() && c.question == null) {
            root.addView(TextView(ctx).apply {
                text = c.body.replace("Tap to open Novi.", "").replace("Tap to answer in Novi.", "").trim()
                textSize = 14f
                setTextColor(Color.DKGRAY)
                visibility = if (text.isNullOrBlank()) View.GONE else View.VISIBLE
            })
        }
        statusView = TextView(ctx).apply {
            textSize = 14f
            setTextColor(Color.parseColor("#FF4F46E5"))
            setPadding(0, dp(4), 0, 0)
            visibility = View.GONE
        }
        root.addView(statusView)

        // Claude's question: the whole form (every option, "Other"), scrolling when it is long.
        c.question?.let { q ->
            val f = QuestionForm(ctx, q, dark = false, onSubmit = { svc.answerQuestion(c, it) }, onSkip = { svc.answer(c, "deny") }, onTyping = ::typing).view
            val scroll = MaxScroll(ctx, (svc.resources.displayMetrics.heightPixels * 0.6).toInt())
            scroll.addView(f)
            form = scroll
            buttons = null
            root.addView(scroll)
            return outer
        }
        form = null

        val row = LinearLayout(ctx).apply {
            orientation = LinearLayout.HORIZONTAL
            setPadding(0, dp(8), 0, 0)
        }
        for (a in c.actions) row.addView(button(a.title) { svc.answer(c, a.action) })
        // Claude's question with more options than fit, or a card with no buttons: open Novi for the rest.
        if (c.actions.isEmpty() || c.actions.none { it.action == "deny" }) row.addView(button("More…") { svc.openNovi(c.id) })
        // No mic button: the card listens for the answer by itself right after it is read out.
        buttons = row
        root.addView(row)

        pinArea = LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            visibility = View.GONE
        }
        root.addView(pinArea)
        return outer
    }

    /**
     * Typing an "Other" answer: the card takes the keyboard for a moment (it never does otherwise) and moves
     * to the top of the screen, so the keyboard doesn't cover it.
     */
    private fun typing(on: Boolean) {
        val v = view ?: return
        val p = params ?: return
        val focusable = p.flags and WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE == 0
        if (focusable == on) return
        p.flags = if (on) p.flags and WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE.inv() else p.flags or WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE
        p.gravity = (if (on) Gravity.TOP else Gravity.BOTTOM) or Gravity.CENTER_HORIZONTAL
        p.y = dp(if (on) 48 else 24)
        p.softInputMode = WindowManager.LayoutParams.SOFT_INPUT_STATE_VISIBLE
        runCatching { wm.updateViewLayout(v, p) }
        val imm = svc.getSystemService(android.view.inputmethod.InputMethodManager::class.java)
        if (on) v.postDelayed({ v.findFocus()?.let { imm.showSoftInput(it, 0) } }, 150)
        else imm.hideSoftInputFromWindow(v.windowToken, 0)
    }
}

/** A ScrollView that stops growing at `max` pixels (a long list of options scrolls inside the card). */
private class MaxScroll(ctx: android.content.Context, private val max: Int) : android.widget.ScrollView(ctx) {
    override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) =
        super.onMeasure(widthMeasureSpec, View.MeasureSpec.makeMeasureSpec(max, View.MeasureSpec.AT_MOST))
}
