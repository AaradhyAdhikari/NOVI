package app.novi.phone

/**
 * Paying (user, 2026-11-19: "the payment thing is not working"): for a few minutes Novi draws nothing over other apps
 * (cards, small cards, the flick bar, the mic bubble, lock-screen cards). Payment apps refuse while another app
 * draws over them, and Accessibility alone being off was not enough. Ends by itself, or when the Novi app opens.
 */
object PayMode {
    const val MINUTES = 10
    @Volatile private var until = 0L

    fun start(now: Long = System.currentTimeMillis()) { until = now + MINUTES * 60_000L }
    fun end() { until = 0L }
    fun on(now: Long = System.currentTimeMillis()) = now < until
    fun leftMs(now: Long = System.currentTimeMillis()) = (until - now).coerceAtLeast(0L)
}

/** Payment apps Novi can open for you, in order of choice. */
val PAY_APPS = listOf(
    "com.google.android.apps.nbu.paisa.user",
    "com.phonepe.app",
    "net.one97.paytm",
)
