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
        assertEquals(FlickSend.SCREEN, flickChoice(false, null, true, "com.google.android.apps.photos", false, null, true))
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
