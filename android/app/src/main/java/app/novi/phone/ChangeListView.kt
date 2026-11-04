package app.novi.phone

import android.content.Context
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.text.TextUtils
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.LinearLayout
import android.widget.TextView

/**
 * The commit card's list, on the pop-up (light) and the lock screen (dark): the message, then each file
 * with green and red counts. Tapping a file calls onFile.
 */
fun changeListView(ctx: Context, ch: Changes, dark: Boolean, onFile: (String) -> Unit): View {
    fun dp(v: Int) = (v * ctx.resources.displayMetrics.density).toInt()
    fun color(s: String) = Color.parseColor(s)
    val list = LinearLayout(ctx).apply { orientation = LinearLayout.VERTICAL }
    if (ch.message.isNotBlank()) list.addView(TextView(ctx).apply {
        text = ch.message
        textSize = if (dark) 16f else 14f
        setTextColor(if (dark) color("#FFD1D5DB") else Color.DKGRAY)
        setPadding(0, 0, 0, dp(6))
    })
    for (f in ch.files) list.addView(LinearLayout(ctx).apply {
        orientation = LinearLayout.HORIZONTAL
        gravity = Gravity.CENTER_VERTICAL
        minimumHeight = dp(40)
        setPadding(dp(8), dp(4), dp(8), dp(4))
        background = GradientDrawable().apply {
            setColor(color(if (dark) "#FF1F2937" else "#FFF3F4F8"))
            cornerRadius = dp(8).toFloat()
        }
        layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { bottomMargin = dp(3) }
        setOnClickListener { onFile(f.file) }
        addView(TextView(ctx).apply {
            text = f.file
            textSize = 13f
            typeface = Typeface.MONOSPACE
            setTextColor(if (dark) Color.WHITE else Color.BLACK)
            maxLines = 1
            ellipsize = TextUtils.TruncateAt.START
            layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
        })
        for (part in countParts(f)) addView(TextView(ctx).apply {
            text = part.text
            textSize = 13f
            typeface = Typeface.MONOSPACE
            setTextColor(color(when {
                part.tone > 0 -> if (dark) "#FF34D399" else "#FF0B8A4B"
                part.tone < 0 -> if (dark) "#FFF87171" else "#FFD32F2F"
                else -> "#FF888888"
            }))
            setPadding(dp(8), 0, 0, 0)
        })
    })
    val extra = listOfNotNull(
        "and ${ch.more} more".takeIf { ch.more > 0 },
        "Left out: ${ch.left.joinToString(", ")}".takeIf { ch.left.isNotEmpty() },
    )
    if (extra.isNotEmpty()) list.addView(TextView(ctx).apply {
        text = extra.joinToString("\n")
        textSize = 12f
        setTextColor(if (dark) color("#FF9CA3AF") else Color.GRAY)
    })
    return list
}
