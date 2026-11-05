package app.novi.phone

import android.content.Context
import android.graphics.Color
import android.graphics.Typeface
import android.view.View
import android.widget.LinearLayout
import android.widget.TextView

/**
 * Claude's plan on the pop-up (light) and the lock screen (dark): its name, what you get, then the numbered
 * steps, so a yes means something (user, 2026-11-05: "How would I know what are the 30 steps").
 */
fun planView(ctx: Context, plan: Plan, dark: Boolean): View {
    fun dp(v: Int) = (v * ctx.resources.displayMetrics.density).toInt()
    val main = if (dark) Color.WHITE else Color.BLACK
    val soft = if (dark) Color.parseColor("#FFD1D5DB") else Color.DKGRAY
    val list = LinearLayout(ctx).apply {
        orientation = LinearLayout.VERTICAL
        setPadding(0, 0, 0, dp(10))
    }
    fun line(words: String, size: Float, color: Int, bold: Boolean = false, gap: Int = 6) = list.addView(TextView(ctx).apply {
        text = words
        textSize = size
        setTextColor(color)
        if (bold) setTypeface(typeface, Typeface.BOLD)
        setPadding(0, 0, 0, dp(gap))
    })
    if (plan.title.isNotBlank()) line(plan.title, if (dark) 17f else 15f, main, bold = true)
    if (plan.summary.isNotBlank()) line(plan.summary, if (dark) 15f else 13f, soft, gap = 8)
    for (text in planLines(plan)) line(text, if (dark) 15f else 13f, main)
    return list
}
