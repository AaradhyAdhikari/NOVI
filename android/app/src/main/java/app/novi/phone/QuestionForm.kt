package app.novi.phone

import android.content.Context
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.text.InputType
import android.view.View
import android.view.ViewGroup
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView

/**
 * Claude's question as Claude Code shows it (user, 2026-10-28, with a screenshot): the question, every
 * option with its description, "Other" for your own words, then Skip / Submit. No mic button (user, 2026-10-28):
 * the card listens by itself — "option 2", "skip", or "in other, I want …" — and the box is for typing.
 * Used by the pop-up card and the lock-screen card alike.
 */
class QuestionForm(
    private val ctx: Context,
    private val q: Question,
    private val dark: Boolean,
    private val onSubmit: (String) -> Unit,
    private val onSkip: () -> Unit,
    private val onTyping: (Boolean) -> Unit = {},
) {
    private val picked = HashSet<Int>()
    private val rows = ArrayList<View>()
    private var otherOn = false
    private lateinit var otherRow: View
    private lateinit var otherBox: LinearLayout
    private lateinit var edit: EditText

    private val accent = Color.parseColor("#FF4F46E5")
    private val text = if (dark) Color.WHITE else Color.BLACK
    private val soft = if (dark) Color.parseColor("#FFB0B7C3") else Color.DKGRAY

    private fun dp(v: Int) = (v * ctx.resources.displayMetrics.density).toInt()

    private fun box(on: Boolean) = GradientDrawable().apply {
        cornerRadius = dp(12).toFloat()
        setColor(if (on) Color.parseColor(if (dark) "#334F46E5" else "#1A4F46E5") else Color.TRANSPARENT)
        setStroke(dp(if (on) 2 else 1), if (on) accent else Color.parseColor(if (dark) "#FF374151" else "#FFD1D5DB"))
    }

    private fun row(label: String, description: String, onTap: () -> Unit): View = LinearLayout(ctx).apply {
        orientation = LinearLayout.VERTICAL
        setPadding(dp(14), dp(10), dp(14), dp(10))
        background = box(false)
        layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { bottomMargin = dp(8) }
        addView(TextView(ctx).apply {
            this.text = label
            setTextColor(this@QuestionForm.text)
            textSize = 16f
            setTypeface(typeface, Typeface.BOLD)
        })
        if (description.isNotBlank()) addView(TextView(ctx).apply {
            this.text = description
            setTextColor(soft)
            textSize = 13f
        })
        setOnClickListener { onTap() }
    }

    private fun refresh() {
        rows.forEachIndexed { i, r -> r.background = box(i in picked) }
        otherRow.background = box(otherOn)
        otherBox.visibility = if (otherOn) View.VISIBLE else View.GONE
    }

    val view: View = LinearLayout(ctx).apply {
        orientation = LinearLayout.VERTICAL
        addView(TextView(ctx).apply {
            this.text = q.text
            setTextColor(this@QuestionForm.text)
            textSize = 18f
            setTypeface(typeface, Typeface.BOLD)
            setPadding(0, dp(4), 0, dp(2))
        })
        addView(TextView(ctx).apply {
            this.text = if (q.multiSelect) "Pick any, or write your own." else "Pick one, or write your own."
            setTextColor(soft)
            textSize = 13f
            setPadding(0, 0, 0, dp(10))
        })
        q.options.forEachIndexed { i, o ->
            val r = row("${i + 1}. ${o.label}", o.description) {
                if (q.multiSelect) {
                    if (!picked.remove(i)) picked.add(i)
                } else {
                    picked.clear()
                    picked.add(i)
                }
                otherOn = false
                refresh()
            }
            rows.add(r)
            addView(r)
        }
        otherRow = row("Other", "Type your own answer, or say \"other, …\".") {
            otherOn = true
            if (!q.multiSelect) picked.clear()
            refresh()
            edit.requestFocus()
        }
        addView(otherRow)
        otherBox = LinearLayout(ctx).apply {
            orientation = LinearLayout.HORIZONTAL
            visibility = View.GONE
            setPadding(0, 0, 0, dp(8))
        }
        edit = EditText(ctx).apply {
            hint = "Your answer"
            setTextColor(this@QuestionForm.text)
            setHintTextColor(soft)
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_MULTI_LINE or InputType.TYPE_TEXT_FLAG_CAP_SENTENCES
            maxLines = 4
            layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
            setOnFocusChangeListener { _, has -> onTyping(has) }
        }
        otherBox.addView(edit)
        addView(otherBox)
        val buttons = LinearLayout(ctx).apply { orientation = LinearLayout.HORIZONTAL }
        buttons.addView(Button(ctx).apply {
            this.text = "Skip"
            isAllCaps = false
            layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f).apply { marginEnd = dp(8) }
            setOnClickListener {
                onTyping(false)
                onSkip()
            }
        })
        buttons.addView(Button(ctx).apply {
            this.text = "Submit"
            isAllCaps = false
            layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
            setOnClickListener {
                val answer = questionAnswer(q.options, picked, if (otherOn) edit.text.toString() else "")
                if (answer != null) {
                    onTyping(false)
                    onSubmit(answer)
                }
            }
        })
        addView(buttons)
    }
}
