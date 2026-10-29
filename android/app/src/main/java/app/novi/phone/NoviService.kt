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
    private lateinit var bubble: MicBubble
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
        // The lock-screen card: a full-screen notification (like a call or an alarm). Silent: the app
        // already buzzes, chimes and reads the card out.
        nm.createNotificationChannel(NotificationChannel("lockcard", "Cards on the lock screen", NotificationManager.IMPORTANCE_HIGH).apply {
            setSound(null, null)
            enableVibration(false)
        })
        ServiceCompat.startForeground(this, 1, connNotice("Connecting to Novi…"), ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
        overlay = CardOverlay(this)
        bubble = MicBubble(this) { bubbleListen() }
        tts = TextToSpeech(this) { }
        getSystemService(ConnectivityManager::class.java).registerDefaultNetworkCallback(netWatch)
        connect()
        bubbleUpdate()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int = START_STICKY

    override fun onDestroy() {
        stopped = true
        instance = null
        main.removeCallbacksAndMessages(null)
        runCatching { getSystemService(ConnectivityManager::class.java).unregisterNetworkCallback(netWatch) }
        socket?.close(1000, "bye")
        overlay.hide()
        bubble.remove()
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
            // The words heard for a card weren't an answer to it (or it was already answered).
            "card_voice" -> if (!msg.optBoolean("ok") && msg.optString("reason") == "unclear") {
                status(msg.optString("id"), "Didn't catch that: tap a button.")
            }
            "approval_resolved" -> {
                val id = msg.optString("id")
                if (listeningFor == id) stopListening = true
                cards.remove(id)
                answered(id)
                main.postDelayed({ showTop() }, 1500)
            }
            "approval_needs_proof" -> status(
                msg.optString("id"),
                when (msg.optString("need")) {
                    "pin" -> "PIN not accepted. Try again."
                    "no-pin" -> "Set a voice PIN in Novi Settings first."
                    "passkey" -> "This one needs your fingerprint: open Novi."
                    else -> "This one needs you at the laptop."
                },
            )
            // A step inside the app open on this phone (phone typing, plugins/phone-control).
            "phone_action" -> work.execute {
                val (ok, note) = runCatching { NoviAccess.instance?.perform(msg) }.getOrElse { false to "That didn't work on the phone." }
                    ?: (false to "Turn on Novi's typing on the phone: Settings → Accessibility → Novi.")
                socket?.send(JSONObject().put("type", "phone_action_result").put("id", msg.optString("id")).put("ok", ok).put("note", note).toString())
            }
            // Novi's spoken answer to something said through this app's mic.
            "speak" -> if (System.currentTimeMillis() - lastAsk < 30_000) say(msg.optString("text"))
        }
    }

    fun cardById(id: String): Card? = cards.all().find { it.id == id }

    /** A short line on the card, on the pop-up and on the lock-screen card alike. */
    private fun status(id: String, text: String) {
        overlay.status(id, text)
        LockCardActivity.current?.status(id, text)
    }

    private fun answered(id: String) {
        overlay.answered(id)
        LockCardActivity.current?.answered(id)
        getSystemService(NotificationManager::class.java).cancel(3)
    }

    /** Phone locked or screen off: the card opens over the lock screen and lights it up. */
    private fun lockCard(card: Card) {
        val open = android.content.Intent(this, LockCardActivity::class.java).putExtra("card", card.id)
            .addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK or android.content.Intent.FLAG_ACTIVITY_SINGLE_TOP)
        val pi = PendingIntent.getActivity(this, 3, open, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        val n = NotificationCompat.Builder(this, "lockcard").setSmallIcon(R.drawable.ic_novi).setContentTitle(card.title)
            .setContentText("Novi needs your answer").setPriority(NotificationCompat.PRIORITY_MAX)
            .setCategory(NotificationCompat.CATEGORY_CALL).setFullScreenIntent(pi, true).setContentIntent(pi).setOngoing(true).build()
        val nm = getSystemService(NotificationManager::class.java)
        nm.notify(3, n)
        // Without the full-screen permission: an app allowed over other apps may open it directly.
        if (android.os.Build.VERSION.SDK_INT >= 34 && !nm.canUseFullScreenIntent()) runCatching { startActivity(open) }
    }

    /** The app's Novi page opened (it shows the cards itself) or closed (waiting cards pop up again). */
    fun pageShown(on: Boolean) = main.post {
        if (on) overlay.hide() else showTop()
        bubbleUpdate()
    }

    /** The mic bubble: while Novi's typing (NoviAccess) is on and the Novi app isn't on screen. */
    fun bubbleUpdate() = main.post { bubble.update(NoviAccess.instance != null && !MainActivity.visible) }

    private fun showTop() {
        val top = cards.top()
        if (top == null) {
            overlay.hide()
            cancelCardNotice()
            return
        }
        if (MainActivity.visible) {
            overlay.hide()
            return
        }
        if (Settings.canDrawOverlays(this)) overlay.show(top, cards.size) else cardNotice(top)
    }

    /** Vibrate, a short chime, then Novi's line out loud; the screen wakes up if it was off. */
    @Suppress("DEPRECATION")
    private fun announce(card: Card) {
        // The Novi page is open in the app: it shows and reads the card itself.
        if (MainActivity.visible) return
        val pm = getSystemService(PowerManager::class.java)
        if (!pm.isInteractive || getSystemService(android.app.KeyguardManager::class.java).isKeyguardLocked) lockCard(card)
        if (!pm.isInteractive) {
            pm.newWakeLock(PowerManager.SCREEN_BRIGHT_WAKE_LOCK or PowerManager.ACQUIRE_CAUSES_WAKEUP, "novi:card").acquire(15_000)
        }
        getSystemService(Vibrator::class.java)?.vibrate(VibrationEffect.createWaveform(longArrayOf(0, 180, 120, 180), -1))
        runCatching { RingtoneManager.getRingtone(this, RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION))?.play() }
        // The video / music pauses while Novi reads the card out and listens for the answer.
        main.postDelayed({ speakAndListen(card) }, 900)
    }

    // ---- the answer by voice, right after the card is read out (user, 2026-10-28: "it should
    // automatically first check for my answer via voice, then if not I will tap the button") ----

    @Volatile private var listeningFor: String? = null
    @Volatile private var stopListening = false

    @Volatile private var speakingNow = false

    /**
     * Novi reads the card out with the mic already on (user, 2026-10-28: "keep the mic on in case I give an
     * immediate answer"). Call mode cancels Novi's own voice from the mic; when the user starts talking Novi
     * stops. After the read-out it keeps listening a little (10 s for Claude's questions, else 5 s).
     */
    private fun speakAndListen(card: Card) {
        val line = card.spoken.ifEmpty { card.title }
        val allowed = cards.top()?.id == card.id &&
            checkSelfPermission(android.Manifest.permission.RECORD_AUDIO) == android.content.pm.PackageManager.PERMISSION_GRANTED
        // Android lets a background app record only as a microphone foreground service.
        val micOk = allowed && runCatching {
            ServiceCompat.startForeground(this, 1, connNotice(stateText), ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE or ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE)
        }.isSuccess
        if (!micOk) {
            say(line, pause = true) { endListening() }
            if (allowed) status(card.id, "Tap a button to answer.")
            return
        }
        stopListening = false
        listeningFor = card.id
        speakingNow = true
        callMode(true)
        status(card.id, if (card.question != null) "Listening… say the option, or \"other, …\"." else "Listening… say yes, no or the option.")
        say(line, pause = true, call = true) { speakingNow = false }
        Thread {
            val over = { stopListening || listeningFor != card.id }
            // 1. While Novi reads (call mode): an answer that interrupts her. Ends with the read-out when
            //    nobody spoke.
            var barged = false
            val during = runCatching {
                Recorder.capture(
                    giveUpMs = Int.MAX_VALUE,
                    maxMs = if (card.question != null) 60000 else 30000,
                    echo = true,
                    speaking = { speakingNow },
                    onSpeech = {
                        barged = true
                        if (speakingNow) main.post { tts?.stop(); speakingNow = false }
                    },
                ) { over() || (!speakingNow && !barged) }
            }.getOrNull()
            callMode(false)
            if (over()) {
                main.post { endListening() }
                return@Thread
            }
            val early = if (barged && during != null && during.pcm.isNotEmpty()) heardText(during.pcm, line) else null
            if (early != null) {
                sendHeard(card, early)
                return@Thread
            }
            // 2. Nothing usable while she read (live 2026-10-28: on the S24+ call mode heard nothing): listen
            //    the plain way after the read-out, as before.
            main.post {
                if (speakingNow) tts?.stop()
                speakingNow = false
            }
            val after = runCatching {
                Recorder.capture(
                    giveUpMs = if (card.question != null) 10000 else 5000,
                    maxMs = if (card.question != null) 20000 else 8000,
                ) { over() }
            }.getOrNull()
            val stopped = over()
            main.post { endListening() }
            if (stopped) return@Thread
            when {
                after == null || after.blocked -> main.post { status(card.id, "Android didn't let me listen: tap a button.") }
                after.pcm.isEmpty() -> main.post { status(card.id, "Didn't hear an answer: tap a button.") }
                else -> {
                    main.post { status(card.id, "Got it…") }
                    val text = heardText(after.pcm, line)
                    if (text == null) main.post { status(card.id, "Didn't catch that: tap a button.") } else sendHeard(card, text)
                }
            }
        }.start()
    }

    /** Speech to text; null when nothing came back or it was only Novi's own voice (never an answer). */
    private fun heardText(pcm: ByteArray, line: String): String? {
        val text = runCatching { transcribe(Recorder.wav(pcm)) }.getOrNull().orEmpty().trim()
        return if (text.isEmpty() || echoOnly(text, line)) null else text
    }

    private fun sendHeard(card: Card, text: String) {
        main.post {
            endListening()
            status(card.id, "Got it…")
            lastAsk = System.currentTimeMillis()
            socket?.send(JSONObject().put("type", "card_voice").put("id", card.id).put("text", text).toString())
        }
    }

    /**
     * Call mode: the phone's echo cancelling then removes Novi's voice from the mic, like on a call. The
     * loudspeaker is used unless earphones / a headset are connected (then those).
     */
    private fun callMode(on: Boolean) {
        val am = getSystemService(AudioManager::class.java)
        runCatching {
            if (on) {
                am.mode = AudioManager.MODE_IN_COMMUNICATION
                if (android.os.Build.VERSION.SDK_INT >= 31) {
                    val devices = am.availableCommunicationDevices
                    val headset = devices.any { it.type in HEADSETS }
                    if (!headset) devices.firstOrNull { it.type == android.media.AudioDeviceInfo.TYPE_BUILTIN_SPEAKER }?.let { am.setCommunicationDevice(it) }
                } else {
                    @Suppress("DEPRECATION")
                    am.isSpeakerphoneOn = true
                }
            } else {
                if (android.os.Build.VERSION.SDK_INT >= 31) {
                    am.clearCommunicationDevice()
                } else {
                    @Suppress("DEPRECATION")
                    am.isSpeakerphoneOn = false
                }
                am.mode = AudioManager.MODE_NORMAL
            }
        }
    }

    private val HEADSETS = setOf(
        android.media.AudioDeviceInfo.TYPE_BLUETOOTH_SCO,
        android.media.AudioDeviceInfo.TYPE_WIRED_HEADSET,
        android.media.AudioDeviceInfo.TYPE_WIRED_HEADPHONES,
        android.media.AudioDeviceInfo.TYPE_USB_HEADSET,
        26, // TYPE_BLE_HEADSET (API 31)
    )

    /**
     * The mic bubble was tapped inside another app: hear one command and send it with that app's name
     * (`phoneApp`), so "type hi and send" happens there, not on the laptop. Novi's answer is spoken
     * (`lastAsk`). Recording from the background needs the microphone foreground service, like a card.
     */
    fun bubbleListen() {
        if (listeningFor != null) return
        val allowed = checkSelfPermission(android.Manifest.permission.RECORD_AUDIO) == android.content.pm.PackageManager.PERMISSION_GRANTED
        val micOk = allowed && runCatching {
            ServiceCompat.startForeground(this, 1, connNotice(stateText), ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE or ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE)
        }.isSuccess
        if (!micOk) {
            toast("Android didn't let Novi listen. Open the Novi app once and allow the microphone.")
            return
        }
        val app = NoviAccess.instance?.frontPackage().orEmpty()
        listeningFor = "bubble"
        stopListening = false
        bubble.listening(true)
        Thread {
            val heard = runCatching { Recorder.capture(giveUpMs = 5000, maxMs = 10000) { stopListening } }.getOrNull()
            main.post { endListening(); bubble.listening(false) }
            if (heard == null || heard.blocked || heard.pcm.isEmpty()) {
                main.post { toast(if (heard?.blocked == true) "Android didn't let Novi listen." else "Didn't hear anything.") }
                return@Thread
            }
            val text = runCatching { transcribe(Recorder.wav(heard.pcm)) }.getOrNull().orEmpty().trim()
            main.post {
                if (text.isEmpty()) { toast("Didn't catch that."); return@post }
                lastAsk = System.currentTimeMillis()
                val sent = socket?.send(JSONObject().put("type", "user_message").put("text", text).put("phoneApp", app).toString()) == true
                toast(if (sent) "“$text”" else "Not connected to Novi.")
            }
        }.start()
    }

    private fun toast(text: String) = android.widget.Toast.makeText(this, text, android.widget.Toast.LENGTH_SHORT).show()

    /** Back to the plain connection service (no mic), and the video / music plays again. */
    private fun endListening() {
        listeningFor = null
        runCatching { ServiceCompat.startForeground(this, 1, connNotice(stateText), ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE) }
        getSystemService(AudioManager::class.java).abandonAudioFocusRequest(pauseFocus)
    }

    private val speech = AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_ASSISTANT)
        .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build()
    private val callVoice = AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
        .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build()
    private val focus by lazy {
        AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK).setAudioAttributes(speech).build()
    }
    private val pauseFocus by lazy {
        AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT).setAudioAttributes(speech).build()
    }

    /**
     * Out loud, with the video or music turned down meanwhile — or paused (`pause`, a card: it stays
     * paused while the answer is listened for; `endListening` lets it play again). `then` runs after.
     */
    fun say(text: String, pause: Boolean = false, call: Boolean = false, then: (() -> Unit)? = null) {
        val t = tts
        if (t == null || text.isBlank()) {
            then?.invoke()
            return
        }
        val audio = getSystemService(AudioManager::class.java)
        audio.requestAudioFocus(if (pause) pauseFocus else focus)
        // In call mode Novi speaks as a call voice, so the echo cancelling knows it and removes it from the mic.
        t.setAudioAttributes(if (call) callVoice else speech)
        t.setOnUtteranceProgressListener(object : UtteranceProgressListener() {
            override fun onStart(id: String?) {}
            override fun onDone(id: String?) {
                if (!pause) audio.abandonAudioFocusRequest(focus)
                main.post { then?.invoke() }
            }

            @Deprecated("old API")
            override fun onError(id: String?) {
                if (!pause) audio.abandonAudioFocusRequest(focus)
                main.post { then?.invoke() }
            }
        })
        t.speak(text, TextToSpeech.QUEUE_FLUSH, null, "novi")
    }

    /** Without "Display over other apps": at least a loud notification that opens this app. */
    private fun cardNotice(card: Card) {
        val open = PendingIntent.getActivity(this, 1, Intent(this, SetupActivity::class.java), PendingIntent.FLAG_IMMUTABLE)
        val n = NotificationCompat.Builder(this, "cards").setSmallIcon(R.drawable.ic_novi).setContentTitle(card.title)
            .setContentText("Allow \"Display over other apps\" for Novi to answer here.").setContentIntent(open)
            .setPriority(NotificationCompat.PRIORITY_HIGH).setAutoCancel(true).build()
        getSystemService(NotificationManager::class.java).notify(2, n)
    }

    private fun cancelCardNotice() = getSystemService(NotificationManager::class.java).cancel(2)

    // ---- answers from the card ----

    /** A card button: approve / deny / opt:N / choice:ID, through the same route as the phone popups. */
    fun answer(card: Card, action: String) {
        stopListening = true
        val n = net ?: return
        status(card.id, "Sending…")
        work.execute {
            val result = runCatching { n.post("/api/card-answer", JSONObject().put("id", card.id).put("action", action)) }
            main.post {
                result.onFailure { status(card.id, it.message ?: "Couldn't reach Novi.") }
                result.onSuccess { r ->
                    when {
                        r.optBoolean("gone") -> {
                            cards.remove(card.id)
                            answered(card.id)
                            main.postDelayed({ showTop() }, 1200)
                        }
                        r.optBoolean("done") -> status(card.id, r.optString("text"))
                        r.optString("need") == "pin" -> askPin(card)
                        else -> overlay.needsNovi(card.id, r.optString("text").ifEmpty { "Open Novi to answer." })
                    }
                }
            }
        }
    }

    /** Claude's question answered on the card: the picked option(s) or your own words. */
    fun answerQuestion(card: Card, answer: String) {
        stopListening = true
        val msg = JSONObject().put("type", "approval").put("id", card.id).put("allow", true).put("answer", answer)
        status(card.id, if (socket?.send(msg.toString()) == true) "Sent: $answer" else "Not connected to Novi.")
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
        status(cardId, if (socket?.send(msg.toString()) == true) "Checking the PIN…" else "Not connected to Novi.")
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
