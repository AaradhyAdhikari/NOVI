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
enum class FlickSend { PAGE, TEXT, COPY, FILE, PICTURE, SCREENSHOT, LINK, YOUTUBE, APP, SCREEN, PRIVATE, NEED_ACCESS, NOTHING }

/** Photo viewers: a flick there sends the picture on screen, cut out of it (Android never says which file is open). */
private val GALLERIES = listOf("com.sec.android.gallery3d", "com.google.android.apps.photos", "com.miui.gallery", "com.coloros.gallery3d",
    "com.oneplus.gallery", "com.vivo.gallery", "com.android.gallery3d", "com.motorola.gallery", "com.simplemobiletools.gallery")
/** File managers and document viewers: a flick there sends the real file (found by its name), not a picture. */
private val FILE_APPS = listOf("com.sec.android.app.myfiles", "com.google.android.apps.nbu.files", "com.android.documentsui", "com.google.android.documentsui",
    "com.google.android.apps.docs", "com.adobe.reader", "com.google.android.apps.pdfviewer", "cn.wps.moffice_eng", "com.microsoft.office",
    "com.microsoft.skydrive", "com.mi.android.globalFileexplorer", "com.coloros.filemanager", "com.samsung.android.app.notes")
fun fileApp(pkg: String): Boolean = FILE_APPS.any { pkg == it || pkg.startsWith("$it.") }

private val FILE_NAME = Regex("""^[^\\/:*?"<>|\n]{1,150}\.(pdf|docx?|xlsx?|pptx?|txt|md|csv|rtf|odt|zip|rar|7z|apk|mp4|mkv|mov|webm|mp3|m4a|wav|ogg|jpe?g|png|gif|webp|heic|json|html?)$""", RegexOption.IGNORE_CASE)
/** Words on screen that look like file names ("Resume 2026.pdf"), selected ones first, at most 10. */
fun fileNames(selected: List<String>, shown: List<String>): List<String> =
    (selected + shown).map { it.trim() }.filter { FILE_NAME.matches(it) }.distinct().take(10)

fun galleryApp(pkg: String): Boolean = GALLERIES.any { pkg == it || pkg.startsWith("$it.") }

/**
 * The picture inside a screen picture: the box with the dark edges (a photo viewer's black background) trimmed off.
 * dark(x, y) says if a pixel is near black. Looks every `step` pixels. Returns [left, top, right, bottom] (right/bottom
 * exclusive), or the whole picture when nothing much would be cut.
 */
fun trimDark(w: Int, h: Int, step: Int = 6, dark: (Int, Int) -> Boolean): IntArray {
    // A line counts as background when at least 80 % of it is near black: a status bar or a toolbar is white
    // icons and words on black (live 2026-11-16: 84-96 % dark), a photo almost never is.
    fun rowBg(y: Int, l: Int, r: Int): Boolean { var x = l; var n = 0; var d = 0; while (x < r) { n++; if (dark(x, y)) d++; x += step }; return n == 0 || d >= n * 0.8 }
    fun colBg(x: Int, t: Int, b: Int): Boolean { var y = t; var n = 0; var d = 0; while (y < b) { n++; if (dark(x, y)) d++; y += step }; return n == 0 || d >= n * 0.8 }
    // The longest run of picture lines; short dark stripes inside a photo (≤ 1/30 of the side) don't break it.
    fun longestRun(len: Int, bg: (Int) -> Boolean): IntArray? {
        val gap = maxOf(step * 2, len / 30)
        var best: IntArray? = null; var start = -1; var lastContent = -1; var i = 0
        while (i < len) {
            if (!bg(i)) {
                if (start < 0 || i - lastContent > gap) start = i
                lastContent = i
                if (best == null || lastContent - start > best[1] - best[0]) best = intArrayOf(start, lastContent + 1)
            }
            i += step
        }
        return best
    }
    val whole = intArrayOf(0, 0, w, h)
    val rows = longestRun(h) { rowBg(it, 0, w) } ?: return whole
    val cols = longestRun(w) { colBg(it, rows[0], rows[1]) } ?: return whole
    val box = intArrayOf(cols[0].coerceIn(0, w - 1), rows[0].coerceIn(0, h - 1), cols[1].coerceIn(1, w), rows[1].coerceIn(1, h))
    if (box[2] <= box[0] || box[3] <= box[1]) return whole
    // A tiny piece (a lone icon) or almost nothing cut: keep the whole picture.
    val area = (box[2] - box[0]).toLong() * (box[3] - box[1])
    return if (area < w.toLong() * h / 12 || area > w.toLong() * h * 97 / 100) whole else box
}

/**
 * Apps whose website the laptop can open when they're flicked (user, 2026-11-16: "if I did that, Instagram should
 * start running on my laptop"). The app can't say which post is open, so the site opens and a screenshot of the
 * phone screen lands too.
 */
private val APP_SITES = mapOf(
    "com.instagram.android" to "https://www.instagram.com/",
    "com.twitter.android" to "https://x.com/",
    "com.reddit.frontpage" to "https://www.reddit.com/",
    "com.linkedin.android" to "https://www.linkedin.com/",
    "com.spotify.music" to "https://open.spotify.com/",
    "com.facebook.katana" to "https://www.facebook.com/",
    "com.instagram.barcelona" to "https://www.threads.net/",
    "com.pinterest" to "https://www.pinterest.com/",
    "com.netflix.mediaclient" to "https://www.netflix.com/",
    "com.amazon.avod.thirdpartyclient" to "https://www.primevideo.com/",
    "in.startv.hotstar" to "https://www.hotstar.com/",
    "com.google.android.apps.youtube.music" to "https://music.youtube.com/",
    "com.github.android" to "https://github.com/",
    "com.discord" to "https://discord.com/app",
    "com.openai.chatgpt" to "https://chatgpt.com/",
    "com.anthropic.claude" to "https://claude.ai/",
    "com.google.android.apps.bard" to "https://gemini.google.com/app",
    "ai.perplexity.app.android" to "https://www.perplexity.ai/",
)
fun appSite(pkg: String): String? = APP_SITES.entries.firstOrNull { pkg == it.key || pkg.startsWith(it.key + ".") }?.value
const val YOUTUBE_PKG = "com.google.android.youtube"

/**
 * The order (user, 2026-11-16: "whenever I do that gesture it works"): Novi's flick screen open → its top card;
 * a screenshot just taken (90 s) → that screenshot; a browser with a readable address → the link; anything else →
 * a picture of the screen (needs Novi typing, the Accessibility service). Never a picture of a bank / UPI /
 * password app or of a screen showing a password box.
 */
fun flickChoice(noviOpen: Boolean, shotAgeMs: Long?, accessOn: Boolean, frontPkg: String, passwordShown: Boolean, link: String?, canShoot: Boolean, locked: Boolean = false, youtubeTitle: String? = null, selection: String? = null, copyShown: Boolean = false, filesOk: Boolean = false): FlickSend = when {
    locked -> FlickSend.NOTHING // never from the lock screen (notifications, codes)
    noviOpen -> FlickSend.PAGE
    // A bank / UPI / password app in front, or a password box: nothing goes, not even an earlier screenshot.
    accessOn && (blockedApp(frontPkg) || passwordShown) -> FlickSend.PRIVATE
    // Text you selected is the clearest ask of all (user, 2026-11-16): a selected link goes as a link, else the words.
    !selection.isNullOrBlank() -> if (browserAddress(selection) != null) FlickSend.LINK else FlickSend.TEXT
    // Text is selected but the app doesn't say what: press its Copy and send what was copied.
    copyShown -> FlickSend.COPY
    // A file manager or document viewer: the real file (needs "All files access").
    accessOn && filesOk && fileApp(frontPkg) -> FlickSend.FILE
    // A photo open in a gallery: just that picture, not the whole screen.
    accessOn && canShoot && galleryApp(frontPkg) -> FlickSend.PICTURE
    shotAgeMs != null && shotAgeMs in 0..90_000 -> FlickSend.SCREENSHOT
    !accessOn -> FlickSend.NEED_ACCESS
    !link.isNullOrBlank() -> FlickSend.LINK
    // A video in the YouTube app: the laptop plays it on YouTube (by its title).
    frontPkg == YOUTUBE_PKG && !youtubeTitle.isNullOrBlank() -> FlickSend.YOUTUBE
    appSite(frontPkg) != null -> FlickSend.APP
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
