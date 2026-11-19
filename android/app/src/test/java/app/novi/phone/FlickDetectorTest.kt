package app.novi.phone

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.math.PI
import kotlin.math.sign
import kotlin.math.sin

/** The same motion shapes as tests/server/flickGesture.test.js, 20 ms apart. */
class FlickDetectorTest {
    private data class P(val acc: Float, val rx: Float, val ry: Float, val rz: Float)
    private fun shape(vararg parts: Pair<Int, (Double) -> P>): List<Pair<Long, P>> {
        val out = mutableListOf<Pair<Long, P>>()
        var t = 0L
        for ((ms, f) in parts) { var i = 0; while (i < ms) { out.add(t to f(i.toDouble() / ms)); i += 20; t += 20 } }
        return out
    }
    private fun fires(s: List<Pair<Long, P>>, d: FlickDetector = FlickDetector()) = s.count { (t, p) -> d.feed(t, p.acc, p.rx, p.ry, p.rz) }
    private val still: Pair<Int, (Double) -> P> = 400 to { _ -> P(0.4f, 4f, 3f, 2f) }
    private fun bell(p: Double, k: Double) = (k * sin(PI * p)).toFloat()

    // Flick up (top tipped away) vs flick down (top pulled towards you) — user, 2026-11-18.
    @Test fun upAndDownAreToldApart() {
        val d = FlickDetector()
        assertEquals(1, fires(shape(still, 160 to { p -> P(bell(p, 22.0), -bell(p, 380.0), 60f, 40f) }, 400 to { _ -> P(1f, 10f, 5f, 5f) }), d))
        assertEquals(-1, d.lastDirection)
        val e = FlickDetector()
        assertEquals(1, fires(shape(still, 160 to { p -> P(bell(p, 22.0), bell(p, 380.0), 60f, 40f) }, 400 to { _ -> P(1f, 10f, 5f, 5f) }), e))
        assertEquals(1, e.lastDirection)
    }

    // A circle in the air: the sideways push turns all the way round. A shake back and forth is not a circle.
    // Live 2026-11-19: a flick up whose snap back turns faster than the flick still sends, never pulls.
    @Test fun aSnapBackIsNotAPull() {
        val d = FlickDetector()
        assertEquals(1, fires(shape(still, 100 to { p -> P(bell(p, 18.0), -bell(p, 300.0), 40f, 30f) }, 100 to { p -> P(bell(p, 22.0), bell(p, 420.0), 40f, 30f) }, 400 to { _ -> P(1f, 10f, 5f, 5f) }), d))
        assertEquals(-1, d.lastDirection)
    }

    @Test fun circleInTheAir() {
        val c = CircleDetector()
        var fired = 0
        var t = 0L
        while (t < 1200) { val a = 2 * PI * t / 1000.0; if (c.feed(t, (5 * kotlin.math.cos(a)).toFloat(), (5 * sin(a)).toFloat())) fired++; t += 20 }
        assertEquals(1, fired)
        val s = CircleDetector()
        var shook = 0
        t = 0
        while (t < 1500) { val x = if ((t / 120) % 2 == 0L) 6f else -6f; if (s.feed(t, x, 0.5f)) shook++; t += 20 }
        assertEquals(0, shook)
        val w = CircleDetector()
        var weak = 0
        t = 0
        while (t < 1500) { val a = 2 * PI * t / 1000.0; if (w.feed(t, (2 * kotlin.math.cos(a)).toFloat(), (2 * sin(a)).toFloat())) weak++; t += 20 }
        assertEquals(0, weak)
    }

    @Test fun aForwardFlickFiresOnce() {
        assertEquals(1, fires(shape(still, 160 to { p -> P(bell(p, 22.0), -bell(p, 380.0), 60f, 40f) }, 400 to { _ -> P(1f, 10f, 5f, 5f) })))
    }

    @Test fun walkingBumpTwistShakeDoNot() {
        assertEquals(0, fires(shape(3000 to { p -> P((3.5 + 3.5 * sin(p * 2 * PI * 6)).toFloat(), (70 * sin(p * 2 * PI * 6)).toFloat(), 40f, 30f) })))
        assertEquals(0, fires(shape(still, 60 to { _ -> P(28f, 35f, 20f, 15f) }, still)))
        assertEquals(0, fires(shape(still, 200 to { p -> P(bell(p, 16.0), 90f, 60f, bell(p, 420.0)) }, still)))
        assertTrue(fires(shape(still, 2000 to { p -> P(18f, (320 * sign(sin(p * 2 * PI * 8))).toFloat(), 50f, 50f) })) <= 1)
    }

    @Test fun cooldownBetweenFlicks() {
        val one = 160 to { p: Double -> P(bell(p, 22.0), bell(p, 380.0), 0f, 0f) }
        assertEquals(1, fires(shape(still, one, still, one)))
        assertEquals(2, fires(shape(still, one, 1600 to { _ -> P(0.4f, 2f, 2f, 2f) }, still, one)))
    }

    @Test fun whatAFlickSends() {
        assertEquals(FlickSend.PAGE, flickChoice(true, 1000, true, "com.x", false, null, true))
        assertEquals(FlickSend.SCREENSHOT, flickChoice(false, 30_000, false, "com.x", false, null, false))
        assertEquals(FlickSend.NEED_ACCESS, flickChoice(false, 200_000, false, "com.x", false, null, true))
        assertEquals(FlickSend.PRIVATE, flickChoice(false, null, true, "com.phonepe.app", false, null, true))
        assertEquals(FlickSend.PRIVATE, flickChoice(false, null, true, "com.instagram.android", true, null, true))
        assertEquals(FlickSend.LINK, flickChoice(false, null, true, "com.android.chrome", false, "https://x.com", true))
        assertEquals(FlickSend.SCREEN, flickChoice(false, null, true, "com.example.reader", false, null, true))
        assertEquals(FlickSend.NOTHING, flickChoice(false, null, true, "com.google.android.apps.photos", false, null, false))
        // Review fixes: never from the lock screen; an earlier screenshot never goes from a bank app; no picture of a messages app.
        assertEquals(FlickSend.NOTHING, flickChoice(false, 1000, true, "com.x", false, null, true, locked = true))
        assertEquals(FlickSend.PRIVATE, flickChoice(false, 1000, true, "com.phonepe.app", false, null, true))
        assertEquals(FlickSend.PRIVATE, flickChoice(false, null, true, "com.google.android.apps.messaging", false, null, true))
    }

    @Test fun videosAndApps() {
        assertEquals(FlickSend.YOUTUBE, flickChoice(false, null, true, YOUTUBE_PKG, false, null, true, youtubeTitle = "Lofi beats"))
        assertEquals(FlickSend.SCREEN, flickChoice(false, null, true, YOUTUBE_PKG, false, null, true, youtubeTitle = null))
        assertEquals(FlickSend.APP, flickChoice(false, null, true, "com.instagram.android", false, null, true))
        assertEquals("https://www.instagram.com/", appSite("com.instagram.android"))
        assertEquals(null, appSite("com.instagram.androidx.evil"))
    }

    @Test fun selectionAndGallery() {
        assertEquals(FlickSend.TEXT, flickChoice(false, 1000, true, "com.whatsapp", false, null, true, selection = "meet at 5"))
        assertEquals(FlickSend.LINK, flickChoice(false, null, true, "com.whatsapp", false, null, true, selection = "https://x.com/a"))
        assertEquals(FlickSend.PRIVATE, flickChoice(false, null, true, "com.phonepe.app", false, null, true, selection = "1234"))
        assertEquals(FlickSend.PICTURE, flickChoice(false, 1000, true, "com.sec.android.gallery3d", false, null, true))
        assertEquals(FlickSend.SCREENSHOT, flickChoice(false, 1000, true, "com.whatsapp", false, null, true))
    }

    @Test fun galleryDateAndTime() {
        val now = java.util.Calendar.getInstance().apply { set(2026, 10, 17, 9, 0, 0); set(java.util.Calendar.MILLISECOND, 0) }
        fun at(y: Int, mo: Int, d: Int, h: Int, mi: Int) = java.util.Calendar.getInstance().apply { set(y, mo, d, h, mi, 0); set(java.util.Calendar.MILLISECOND, 0) }.timeInMillis
        val r = shownWhen(listOf("16 November 2026", "10:23 PM", "Pune"), now)!!
        assertTrue(at(2026, 10, 16, 22, 23) in r && at(2026, 10, 16, 22, 30) !in r)
        assertTrue(at(2026, 10, 16, 22, 23) in shownWhen(listOf("Nov 16, 2026 • 22:23"), now)!!)
        assertTrue(at(2026, 10, 16, 15, 0) in shownWhen(listOf("Yesterday"), now)!!)
        assertTrue(at(2026, 10, 17, 8, 5) in shownWhen(listOf("Today", "8:05 am"), now)!!)
        assertEquals(null, shownWhen(listOf("Share", "Edit", "Delete"), now))
    }

    @Test fun copyAndFiles() {
        assertEquals(FlickSend.COPY, flickChoice(false, null, true, "com.whatsapp", false, null, true, copyShown = true))
        assertEquals(FlickSend.TEXT, flickChoice(false, null, true, "com.whatsapp", false, null, true, selection = "hi", copyShown = true))
        assertEquals(FlickSend.FILE, flickChoice(false, null, true, "com.sec.android.app.myfiles", false, null, true, filesOk = true))
        assertEquals(FlickSend.SCREEN, flickChoice(false, null, true, "com.sec.android.app.myfiles", false, null, true, filesOk = false))
        assertEquals(listOf("Resume 2026.pdf", "notes.txt"), fileNames(listOf("Resume 2026.pdf"), listOf("Downloads", "notes.txt", "Resume 2026.pdf", "3 items")))
        assertTrue(fileNames(emptyList(), listOf("a/b.pdf", "Hello there")).isEmpty())
    }

    @Test fun picturesLoseTheirBlackEdges() {
        // A 100x200 screen: black above y=50 and below y=150, the photo in between (x 10..90).
        val box = trimDark(100, 200, step = 2) { x, y -> y < 50 || y >= 150 || x < 10 || x >= 90 }
        assertTrue(box[1] in 48..52 && box[3] in 148..152 && box[0] in 8..12 && box[2] in 88..92)
        // Live 2026-11-16: white icons and words on black at the top (status bar + gallery buttons) and the bottom,
        // a dark gap, then the photo. Only the photo is kept.
        val photo = trimDark(100, 200, step = 1) { x, y -> when { y < 30 -> x % 10 != 0; y < 40 -> true; y < 160 -> false; y < 190 -> true; else -> x % 10 != 0 } }
        assertTrue("got " + photo.toList(), photo[1] in 38..42 && photo[3] in 158..162)
        // A dark photo that fills the screen stays whole.
        assertTrue(trimDark(100, 200, step = 2) { _, _ -> true }.contentEquals(intArrayOf(0, 0, 100, 200)))
        // Nothing dark: nothing cut.
        assertTrue(trimDark(100, 200, step = 2) { _, _ -> false }.contentEquals(intArrayOf(0, 0, 100, 200)))
    }

    @Test fun browserBarToLink() {
        org.junit.Assert.assertEquals("https://youtube.com/watch?v=x", browserAddress("youtube.com/watch?v=x"))
        org.junit.Assert.assertEquals("https://a.com/b", browserAddress("https://a.com/b"))
        org.junit.Assert.assertNull(browserAddress("best pizza near me"))
        org.junit.Assert.assertNull(browserAddress(""))
        org.junit.Assert.assertNull(browserAddress("javascript:alert(1)"))
    }

    @Test fun screenshotsByFolderOrName() {
        assertTrue(isScreenshot("DCIM/Screenshots/", "Screenshot_20261116_171200_Chrome.jpg"))
        assertTrue(isScreenshot("Pictures/Screenshots/", "x.png"))
        assertFalse(isScreenshot("DCIM/Camera/", "20261116_171200.jpg"))
    }
}
