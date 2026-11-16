package app.novi.phone

import kotlin.math.abs

/**
 * Novi Flick v2: the real flick, a quick forward flick of the wrist toward the laptop. The same rules as the page
 * (src/lib/flickGesture.js): within 300 ms the phone both jolts (≥ 14 m/s², gravity removed) and pitches hard
 * (≥ 240°/s, mostly about its short side, x), right after being held fairly still (300 ms under 4 m/s²).
 * Walking, a bump on the table, a twist and an ongoing shake don't count; one flick per 1.5 s.
 */
class FlickDetector(
    private val minAcc: Float = 14f,
    private val minRot: Float = 240f,
    private val axisRatio: Float = 1.4f,
    private val calmAcc: Float = 4f,
    private val calmMs: Long = 300,
    private val windowMs: Long = 300,
    private val cooldownMs: Long = 1500,
) {
    private data class S(val t: Long, val acc: Float, val rx: Float, val ry: Float, val rz: Float)
    private val buf = ArrayDeque<S>()
    private var last = Long.MIN_VALUE / 2

    /** One sample: t in ms, acc in m/s² (gravity removed), rotation in degrees/s. True = a flick. */
    fun feed(t: Long, acc: Float, rx: Float, ry: Float, rz: Float): Boolean {
        buf.addLast(S(t, abs(acc), abs(rx), abs(ry), abs(rz)))
        while (buf.isNotEmpty() && t - buf.first().t > windowMs + calmMs + 200) buf.removeFirst()
        if (t - last < cooldownMs) return false
        var jolt = 0f; var pitch = 0f; var other = 0f
        var before = 0; var calm = true
        for (s in buf) {
            val age = t - s.t
            if (age <= windowMs) {
                if (s.acc > jolt) jolt = s.acc
                if (s.rx > pitch) pitch = s.rx
                other = maxOf(other, s.ry, s.rz)
            } else if (age <= windowMs + calmMs) {
                before++
                if (s.acc >= calmAcc) calm = false
            }
        }
        if (jolt >= minAcc && pitch >= minRot && pitch >= axisRatio * other && calm && before >= 3) {
            last = t
            buf.clear()
            return true
        }
        return false
    }
}

/** What a flick sends when Novi's own flick screen isn't open. */
enum class FlickSend { PAGE, SCREENSHOT, LINK, SCREEN, PRIVATE, NEED_ACCESS, NOTHING }

/**
 * The order (user, 2026-11-16: "whenever I do that gesture it works"): Novi's flick screen open → its top card;
 * a screenshot just taken (90 s) → that screenshot; a browser with a readable address → the link; anything else →
 * a picture of the screen (needs Novi typing, the Accessibility service). Never a picture of a bank / UPI /
 * password app or of a screen showing a password box.
 */
fun flickChoice(noviOpen: Boolean, shotAgeMs: Long?, accessOn: Boolean, frontPkg: String, passwordShown: Boolean, link: String?, canShoot: Boolean, locked: Boolean = false): FlickSend = when {
    locked -> FlickSend.NOTHING // never from the lock screen (notifications, codes)
    noviOpen -> FlickSend.PAGE
    // A bank / UPI / password app in front, or a password box: nothing goes, not even an earlier screenshot.
    accessOn && (blockedApp(frontPkg) || passwordShown) -> FlickSend.PRIVATE
    shotAgeMs != null && shotAgeMs in 0..90_000 -> FlickSend.SCREENSHOT
    !accessOn -> FlickSend.NEED_ACCESS
    !link.isNullOrBlank() -> FlickSend.LINK
    // Messages apps show one-time codes: a link from them is fine, a picture of them isn't.
    otpApp(frontPkg) -> FlickSend.PRIVATE
    canShoot -> FlickSend.SCREEN
    else -> FlickSend.NOTHING
}

private val OTP_APPS = listOf("com.google.android.apps.messaging", "com.samsung.android.messaging", "com.android.mms", "com.truecaller", "com.microsoft.android.smsorganizer")
fun otpApp(pkg: String): Boolean = OTP_APPS.any { pkg.startsWith(it) }

/** A screenshot file by where Android saved it (Samsung: DCIM/Screenshots/, Pixel: Pictures/Screenshots/). */
fun isScreenshot(relativePath: String?, name: String?): Boolean =
    Regex("screen ?shots?", RegexOption.IGNORE_CASE).containsMatchIn(relativePath.orEmpty()) ||
        Regex("^screenshot", RegexOption.IGNORE_CASE).containsMatchIn(name.orEmpty())

/** The browser bar's text as a link: "youtube.com/watch?v=x" → https://…; a search or an empty bar → null. */
fun browserAddress(text: String?): String? {
    val t = text?.trim().orEmpty()
    if (t.isEmpty() || t.contains(' ')) return null
    if (Regex("^https?://", RegexOption.IGNORE_CASE).containsMatchIn(t)) return t
    if (Regex("""^[a-z0-9-]+(\.[a-z0-9-]+)+(/\S*)?$""", RegexOption.IGNORE_CASE).matches(t)) return "https://$t"
    return null
}
