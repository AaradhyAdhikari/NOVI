package app.novi.phone

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class PayModeTest {
    @Test fun lastsTenMinutesThenEnds() {
        PayMode.start(1_000)
        assertTrue(PayMode.on(1_000 + 9 * 60_000))
        assertFalse(PayMode.on(1_000 + 10 * 60_000))
        assertEquals(60_000L, PayMode.leftMs(1_000 + 9 * 60_000))
    }

    @Test fun openingNoviEndsIt() {
        PayMode.start()
        PayMode.end()
        assertFalse(PayMode.on())
    }

    @Test fun googlePayFirst() = assertEquals("com.google.android.apps.nbu.paisa.user", PAY_APPS.first())
}
