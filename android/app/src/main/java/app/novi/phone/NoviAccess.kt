package app.novi.phone

import android.accessibilityservice.AccessibilityService
import android.content.Intent
import android.graphics.Rect
import android.os.Build
import android.os.Bundle
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo

/**
 * Phone typing (user, 2026-10-29: "Yes, build phone typing"): types, sends, taps, goes back / home and
 * scrolls inside the app open on the phone, when the user asks Novi (the laptop's phone_action arrives
 * through NoviService). Switched on by the user in Android Settings → Accessibility → Novi. The rules
 * (which box, which button, which apps never) are in PhoneLogic.kt.
 */
class NoviAccess : AccessibilityService() {
    companion object {
        @Volatile var instance: NoviAccess? = null
    }

    override fun onServiceConnected() {
        instance = this
        NoviService.instance?.bubbleUpdate()
    }

    override fun onUnbind(intent: Intent?): Boolean {
        instance = null
        NoviService.instance?.bubbleUpdate()
        return super.onUnbind(intent)
    }

    override fun onDestroy() {
        instance = null
        super.onDestroy()
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {}
    override fun onInterrupt() {}

    /** The app in front (the mic bubble never takes the focus, so it's the app the user is in). */
    fun frontPackage(): String = rootInActiveWindow?.packageName?.toString().orEmpty()

    /** One step from the laptop's phone_action: (done, what to say). */
    fun perform(step: org.json.JSONObject): Pair<Boolean, String> {
        val root = rootInActiveWindow ?: return false to "I can't see the phone screen right now."
        val pkg = root.packageName?.toString().orEmpty()
        val what = step.optString("do")
        if (what == "back") return performGlobalAction(GLOBAL_ACTION_BACK) to "Went back."
        if (what == "home") return performGlobalAction(GLOBAL_ACTION_HOME) to "Home screen."
        if (pkg == packageName) return false to "Novi is open on the phone. Open the app you want first, then use the Novi bubble."
        if (blockedApp(pkg)) return false to PHONE_SENSITIVE
        if (what == "scroll") return scroll(root, step.optString("dir") == "up", step.optInt("times", 1))
        // A password, card or code box on screen: no typing, sending or tapping here (laptop rule too).
        if (nodes(root).any { it.isPassword && it.isVisibleToUser }) return false to PHONE_SENSITIVE
        return when (what) {
            "type" -> type(root, pkg, step.optString("text"), step.optBoolean("enter"))
            "enter" -> enter(root, pkg)
            "tap" -> tap(root, step.optString("target"))
            else -> false to "I can't do that on the phone yet."
        }
    }

    private fun nodes(root: AccessibilityNodeInfo): List<AccessibilityNodeInfo> {
        val out = ArrayList<AccessibilityNodeInfo>()
        val queue = ArrayDeque<AccessibilityNodeInfo>().apply { add(root) }
        while (queue.isNotEmpty() && out.size < 3000) {
            val n = queue.removeFirst()
            out.add(n)
            for (i in 0 until n.childCount) n.getChild(i)?.let(queue::add)
        }
        return out
    }

    private fun area(n: AccessibilityNodeInfo): Int = Rect().also(n::getBoundsInScreen).let { it.width() * it.height() }

    private fun field(n: AccessibilityNodeInfo): Field {
        val hint = listOf(n.hintText, n.contentDescription, n.viewIdResourceName?.substringAfterLast('/')?.replace('_', ' '))
            .firstOrNull { !it.isNullOrBlank() }?.toString().orEmpty()
        return Field(hint, n.text?.toString().orEmpty(), focused = n.isFocused, area = area(n), hintShown = n.isShowingHintText)
    }

    private fun type(root: AccessibilityNodeInfo, pkg: String, text: String, enter: Boolean): Pair<Boolean, String> {
        if (text.isBlank()) return false to "There's nothing to type."
        val boxes = nodes(root).filter { it.isEditable && it.isVisibleToUser }
        val fields = boxes.map(::field)
        val i = pickField(fields, chatPackage(pkg))
        if (i < 0) return false to "I don't see a text box on the phone screen."
        val box = boxes[i]
        box.performAction(AccessibilityNodeInfo.ACTION_FOCUS)
        val args = Bundle().apply { putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, newText(fields[i], text)) }
        if (!box.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args)) return false to "That box didn't take the text."
        val search = isSearch(fields[i]) && !chatPackage(pkg)
        if (!enter && !search) return true to "Typed it."
        if (!pressEnter(box)) return true to "Typed it, but I couldn't find the send button. Tap it, or say \"tap send\"."
        return true to when {
            search -> "Searched for “$text”."
            chatPackage(pkg) -> "Sent."
            else -> "Typed it and pressed Enter."
        }
    }

    /** "Send it": Enter on the box with the cursor, else the screen's Send / Search button. */
    private fun enter(root: AccessibilityNodeInfo, pkg: String): Pair<Boolean, String> {
        val box = root.findFocus(AccessibilityNodeInfo.FOCUS_INPUT) ?: nodes(root).firstOrNull { it.isEditable && it.isFocused }
        val ok = if (box != null) pressEnter(box) else clickLabelled(Regex("""^(send|search|go|done|post)$""", RegexOption.IGNORE_CASE))
        return if (ok) true to (if (chatPackage(pkg)) "Sent." else "Pressed Enter.") else false to "I couldn't find a send button on the phone screen."
    }

    private fun pressEnter(box: AccessibilityNodeInfo): Boolean {
        if (Build.VERSION.SDK_INT >= 30 && box.performAction(AccessibilityNodeInfo.AccessibilityAction.ACTION_IME_ENTER.id)) return true
        Thread.sleep(150) // the app's Send button appears once there is text
        return clickLabelled(Regex("""^(send|search|go|done|post)$""", RegexOption.IGNORE_CASE))
    }

    private fun clickLabelled(label: Regex): Boolean {
        val root = rootInActiveWindow ?: return false
        val n = nodes(root).firstOrNull { it.isVisibleToUser && label.matches((it.contentDescription ?: it.text)?.toString()?.trim().orEmpty()) } ?: return false
        return clickable(n)?.performAction(AccessibilityNodeInfo.ACTION_CLICK) == true
    }

    private fun clickable(n: AccessibilityNodeInfo): AccessibilityNodeInfo? {
        var c: AccessibilityNodeInfo? = n
        var hops = 0
        while (c != null && !c.isClickable && hops < 6) { c = c.parent; hops++ }
        return c?.takeIf { it.isClickable }
    }

    private fun tap(root: AccessibilityNodeInfo, target: String): Pair<Boolean, String> {
        val labelled = nodes(root).filter { it.isVisibleToUser && !(it.text ?: it.contentDescription).isNullOrBlank() }
        val labels = labelled.map { (it.text ?: it.contentDescription).toString().replace(Regex("""\s+"""), " ").trim() }
        val i = matchLabel(labels, target)
        if (i < 0) return false to "I couldn't find “$target” on the phone screen."
        tapRefusal(labels[i])?.let { return false to it }
        val node = clickable(labelled[i]) ?: return false to "“${labels[i]}” can't be tapped."
        return if (node.performAction(AccessibilityNodeInfo.ACTION_CLICK)) true to "Tapped ${labels[i]}." else false to "The tap didn't work."
    }

    private fun scroll(root: AccessibilityNodeInfo, up: Boolean, times: Int): Pair<Boolean, String> {
        val list = nodes(root).filter { it.isScrollable && it.isVisibleToUser }.maxByOrNull(::area)
            ?: return false to "Nothing on the phone screen scrolls."
        val action = if (up) AccessibilityNodeInfo.ACTION_SCROLL_BACKWARD else AccessibilityNodeInfo.ACTION_SCROLL_FORWARD
        repeat(times.coerceIn(1, 10)) { list.performAction(action) }
        return true to if (up) "Scrolled up." else "Scrolled down."
    }
}
