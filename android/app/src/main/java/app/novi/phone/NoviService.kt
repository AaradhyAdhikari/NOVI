package app.novi.phone

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.media.RingtoneManager
import android.net.ConnectivityManager
import android.net.Network
import android.net.Uri
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import android.os.VibrationEffect
import android.os.Vibrator
import android.provider.Settings
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject
import java.util.concurrent.Executors

/**
 * Keeps one WebSocket to Novi on the laptop (over Tailscale) and puts every waiting card on screen,
 * over any app, until it is answered here, on the laptop or anywhere else.
 */
class NoviService : Service() {
    companion object {
        @Volatile var instance: NoviService? = null
        /** What the app screen shows ("Connected to Novi", "Connecting…"). */
        @Volatile var stateText: String = "Not started"
        var onState: (() -> Unit)? = null

        fun start(context: Context) = ContextCompat.startForegroundService(context, Intent(context, NoviService::class.java))
        fun stop(context: Context) = context.stopService(Intent(context, NoviService::class.java))
    }

    private val main = Handler(Looper.getMainLooper())
    private val work = Executors.newSingleThreadExecutor()
    private lateinit var store: Store
    private var net: Net? = null
    private var socket: WebSocket? = null
    private var connected = false
    private var stopped = false
    private val backoff = Backoff()
    private val cards = CardList()
    private val announced = HashSet<String>()
    private lateinit var overlay: CardOverlay
    private var tts: TextToSpeech? = null
    private var lastAsk = 0L
    private val reconnect = Runnable { connect() }
    private val netWatch = object : ConnectivityManager.NetworkCallback() {
        override fun onAvailable(network: Network) {
            main.post {
                if (!connected && !stopped) {
                    main.removeCallbacks(reconnect)
                    backoff.reset()
                    connect()
                }
            }
        }
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        instance = this
        store = Store(this)
        val nm = getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(NotificationChannel("conn", "Connection to Novi", NotificationManager.IMPORTANCE_LOW))
        nm.createNotificationChannel(NotificationChannel("cards", "Novi cards", NotificationManager.IMPORTANCE_HIGH))
        ServiceCompat.startForeground(this, 1, connNotice("Connecting to Novi…"), ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
        overlay = CardOverlay(this)
        tts = TextToSpeech(this) { }
        getSystemService(ConnectivityManager::class.java).registerDefaultNetworkCallback(netWatch)
        connect()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int = START_STICKY

    override fun onDestroy() {
        stopped = true
        instance = null
        main.removeCallbacksAndMessages(null)
        runCatching { getSystemService(ConnectivityManager::class.java).unregisterNetworkCallback(netWatch) }
        socket?.close(1000, "bye")
        overlay.hide()
        tts?.shutdown()
        stateText = "Not running"
        onState?.invoke()
        super.onDestroy()
    }

    private fun connNotice(text: String): Notification {
        val open = PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE)
        return NotificationCompat.Builder(this, "conn").setSmallIcon(R.drawable.ic_novi).setContentTitle(text)
            .setOngoing(true).setContentIntent(open).setPriority(NotificationCompat.PRIORITY_LOW).build()
    }

    private fun setState(text: String) {
        stateText = text
        if (!stopped) getSystemService(NotificationManager::class.java).notify(1, connNotice(text))
        main.post { onState?.invoke() }
    }

    private fun connect() {
        if (stopped) return
        val base = store.base
        val token = store.token
        if (base == null || token == null) {
            setState("Not paired: open the Novi app")
            stopSelf()
            return
        }
        setState("Connecting to Novi…")
        val n = Net(base, token, store.pin)
        net = n
        socket?.cancel()
        socket = n.socket(object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                webSocket.send(JSONObject().put("type", "hello").put("token", token).toString())
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                val msg = runCatching { JSONObject(text) }.getOrNull() ?: return
                main.post { if (webSocket == socket) handle(msg) }
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                main.post { if (webSocket == socket) lost(code) }
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                main.post { if (webSocket == socket) lost(0) }
            }
        })
    }

    private fun lost(code: Int) {
        connected = false
        if (stopped) return
        if (code == 4001) {
            setState("Novi removed this phone: open the app to pair again")
            return
        }
        val wait = backoff.next()
        setState("Novi isn't reachable: trying again in ${wait / 1000} s")
        main.removeCallbacks(reconnect)
        main.postDelayed(reconnect, wait)
    }

    private fun handle(msg: JSONObject) {
        when (msg.optString("type")) {
            "snapshot" -> {
                if (!connected) {
                    connected = true
                    backoff.reset()
                    setState("Connected to Novi")
                }
                val list = msg.optJSONArray("cards") ?: return
                cards.replace((0 until list.length()).mapNotNull { list.optJSONObject(it)?.let(::parseCard) })
                cards.all().reversed().filter { announced.add(it.id) }.forEach(::announce)
                showTop()
            }
            "approval_added" -> parseCard(msg)?.let { card ->
                cards.add(card)
                if (announced.add(card.id)) announce(card)
                showTop()
            }
            "approval_resolved" -> {
                val id = msg.optString("id")
                cards.remove(id)
                overlay.answered(id)
                main.postDelayed({ showTop() }, 1500)
            }
            "approval_needs_proof" -> overlay.status(
                msg.optString("id"),
                when (msg.optString("need")) {
                    "pin" -> "PIN not accepted. Try again."
                    "no-pin" -> "Set a voice PIN in Novi Settings first."
                    "passkey" -> "This one needs your fingerprint: open Novi."
                    else -> "This one needs you at the laptop."
                },
            )
            // Novi's spoken answer to something said through this app's mic.
            "speak" -> if (System.currentTimeMillis() - lastAsk < 30_000) say(msg.optString("text"))
        }
    }

    private fun showTop() {
        val top = cards.top()
        if (top == null) {
            overlay.hide()
            cancelCardNotice()
            return
        }
        if (Settings.canDrawOverlays(this)) overlay.show(top, cards.size) else cardNotice(top)
    }

    /** Vibrate, a short chime, then Novi's line out loud; the screen wakes up if it was off. */
    @Suppress("DEPRECATION")
    private fun announce(card: Card) {
        val pm = getSystemService(PowerManager::class.java)
        if (!pm.isInteractive) {
            pm.newWakeLock(PowerManager.SCREEN_BRIGHT_WAKE_LOCK or PowerManager.ACQUIRE_CAUSES_WAKEUP, "novi:card").acquire(15_000)
        }
        getSystemService(Vibrator::class.java)?.vibrate(VibrationEffect.createWaveform(longArrayOf(0, 180, 120, 180), -1))
        runCatching { RingtoneManager.getRingtone(this, RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION))?.play() }
        main.postDelayed({ say(card.spoken.ifEmpty { card.title }) }, 900)
    }

    private val speech = AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_ASSISTANT)
        .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build()
    private val focus by lazy {
        AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK).setAudioAttributes(speech).build()
    }

    /** Out loud, with the video or music turned down meanwhile. */
    fun say(text: String) {
        val t = tts ?: return
        if (text.isBlank()) return
        val audio = getSystemService(AudioManager::class.java)
        audio.requestAudioFocus(focus)
        t.setAudioAttributes(speech)
        t.setOnUtteranceProgressListener(object : UtteranceProgressListener() {
            override fun onStart(id: String?) {}
            override fun onDone(id: String?) {
                audio.abandonAudioFocusRequest(focus)
            }

            @Deprecated("old API")
            override fun onError(id: String?) {
                audio.abandonAudioFocusRequest(focus)
            }
        })
        t.speak(text, TextToSpeech.QUEUE_FLUSH, null, "novi")
    }

    /** Without "Display over other apps": at least a loud notification that opens this app. */
    private fun cardNotice(card: Card) {
        val open = PendingIntent.getActivity(this, 1, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE)
        val n = NotificationCompat.Builder(this, "cards").setSmallIcon(R.drawable.ic_novi).setContentTitle(card.title)
            .setContentText("Allow \"Display over other apps\" for Novi to answer here.").setContentIntent(open)
            .setPriority(NotificationCompat.PRIORITY_HIGH).setAutoCancel(true).build()
        getSystemService(NotificationManager::class.java).notify(2, n)
    }

    private fun cancelCardNotice() = getSystemService(NotificationManager::class.java).cancel(2)

    // ---- answers from the card ----

    /** A card button: approve / deny / opt:N / choice:ID, through the same route as the phone popups. */
    fun answer(card: Card, action: String) {
        val n = net ?: return
        overlay.status(card.id, "Sending…")
        work.execute {
            val result = runCatching { n.post("/api/card-answer", JSONObject().put("id", card.id).put("action", action)) }
            main.post {
                result.onFailure { overlay.status(card.id, it.message ?: "Couldn't reach Novi.") }
                result.onSuccess { r ->
                    when {
                        r.optBoolean("gone") -> {
                            cards.remove(card.id)
                            overlay.answered(card.id)
                            main.postDelayed({ showTop() }, 1200)
                        }
                        r.optBoolean("done") -> overlay.status(card.id, r.optString("text"))
                        r.optString("need") == "pin" -> askPin(card)
                        else -> overlay.needsNovi(card.id, r.optString("text").ifEmpty { "Open Novi to answer." })
                    }
                }
            }
        }
    }

    /** The PIN pad when typed PINs are allowed in Novi Settings, else only "say your PIN". */
    private fun askPin(card: Card) {
        val n = net ?: return
        work.execute {
            val typed = runCatching { n.get("/api/remote-pin").optString("pinInput") == "voice-or-typed" }.getOrDefault(false)
            main.post { overlay.showPin(card.id, typed) }
        }
    }

    fun sendPin(cardId: String, typed: String? = null, spoken: String? = null) {
        val msg = JSONObject().put("type", "approval").put("id", cardId).put("allow", true)
        if (typed != null) msg.put("pinTyped", typed)
        if (spoken != null) msg.put("pinSpoken", spoken)
        overlay.status(cardId, if (socket?.send(msg.toString()) == true) "Checking the PIN…" else "Not connected to Novi.")
    }

    /** Words said through the mic button: Novi reads them like any request ("option 2", "yes, but…"). */
    fun sendText(text: String): Boolean {
        lastAsk = System.currentTimeMillis()
        return socket?.send(JSONObject().put("type", "user_message").put("text", text).toString()) == true
    }

    /** Speech to text on the laptop (the mic dialog calls this off the main thread). */
    fun transcribe(wav: ByteArray): String = net?.stt(wav) ?: throw NoviError("Not connected to Novi.", 0)

    fun listen(cardId: String, title: String, pin: Boolean) {
        startActivity(
            Intent(this, MicActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                .putExtra("card", cardId).putExtra("title", title).putExtra("pin", pin),
        )
    }

    fun openNovi(cardId: String) {
        val base = store.base ?: return
        startActivity(Intent(Intent.ACTION_VIEW, Uri.parse("$base/?card=$cardId")).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    }

    /** "Send a test card" on the app screen. */
    fun testCard(done: (String) -> Unit) {
        val n = net ?: return done("Not connected to Novi yet.")
        work.execute {
            val r = runCatching { n.post("/api/test-card") }
            main.post { done(r.fold({ "Test card sent." }, { it.message ?: "Couldn't reach Novi." })) }
        }
    }
}
