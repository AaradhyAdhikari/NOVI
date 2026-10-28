package app.novi.phone

import org.json.JSONObject

// Plain logic with no Android parts, so it is unit-tested on the laptop (LogicTest).

/** Where Novi is (https://host:port) and, from the pairing QR, the one-time code. */
data class PairLink(val base: String, val code: String?)

data class CardAction(val action: String, val title: String)

/** A waiting card as the server's cardAlert() builds it, plus the line Novi speaks. */
data class Card(
    val id: String,
    val title: String,
    val body: String = "",
    val actions: List<CardAction> = emptyList(),
    val proof: Boolean = false,
    val spoken: String = "",
)

private val HOST = Regex("""^[A-Za-z0-9.-]+(:\d{1,5})?$""")

/**
 * The QR link ("https://laptop.tail1234.ts.net:3001/#pair=482913"), the address alone, or just the
 * laptop's name ("laptop.tail1234.ts.net" → https, port 3001). Only https: Novi never serves plain http.
 */
fun parsePairLink(text: String): PairLink? {
    val t = text.trim()
    if (t.isEmpty()) return null
    val code = Regex("""#pair=(\d{6})""").find(t)?.groupValues?.get(1)
    val noHash = t.substringBefore('#')
    if (noHash.contains("://") && !noHash.startsWith("https://", ignoreCase = true)) return null
    val hostPort = noHash.substringAfter("://").substringBefore('/')
    if (!HOST.matches(hostPort) || !hostPort.contains('.')) return null
    val withPort = if (hostPort.contains(':')) hostPort else "$hostPort:3001"
    return PairLink("https://$withPort", code)
}

fun wsUrl(base: String): String = base.replaceFirst("https://", "wss://") + "/ws"

/**
 * A card from an `approval_added` message (`alert`), a snapshot `cards` entry (the card itself), or —
 * from an older Novi without `alert` — the bare approval with Approve / Deny.
 */
fun parseCard(msg: JSONObject): Card? {
    val alert = msg.optJSONObject("alert") ?: if (msg.has("approval")) null else msg
    if (alert != null) {
        val id = alert.optString("id")
        if (id.isEmpty() || !alert.has("title")) return null
        val list = alert.optJSONArray("actions")
        val actions = (0 until (list?.length() ?: 0)).mapNotNull { i ->
            list!!.optJSONObject(i)?.let { CardAction(it.optString("action"), it.optString("title")) }
        }
        return Card(id, alert.optString("title"), alert.optString("body"), actions, alert.optBoolean("proof"), alert.optString("spoken"))
    }
    val a = msg.optJSONObject("approval") ?: return null
    val id = a.optString("id")
    if (id.isEmpty()) return null
    val proof = a.optString("tier") == "high" || a.optBoolean("pin") || a.has("kind")
    val title = a.optString("title").ifEmpty { a.optString("prompt") }
    return Card(id, title, "", listOf(CardAction("approve", if (proof) "Approve (PIN)" else "Approve"), CardAction("deny", "Deny")), proof, a.optString("prompt"))
}

/** "01:AB:FF" — how a certificate's SHA-256 is shown at pairing. */
fun fingerprintText(bytes: ByteArray): String = bytes.joinToString(":") { "%02X".format(it.toInt() and 0xFF) }

/** The waiting cards, newest first; the newest is the one on screen. */
class CardList {
    private val cards = ArrayList<Card>()
    val size: Int get() = cards.size

    fun replace(list: List<Card>) {
        cards.clear()
        cards.addAll(list.reversed())
    }

    fun add(card: Card) {
        cards.removeAll { it.id == card.id }
        cards.add(0, card)
    }

    fun remove(id: String) {
        cards.removeAll { it.id == id }
    }

    fun top(): Card? = cards.firstOrNull()
    fun all(): List<Card> = cards.toList()
}

/** Reconnect waits: 1, 2, 5, 10, then every 30 s. */
class Backoff {
    private val steps = longArrayOf(1000, 2000, 5000, 10000, 30000)
    private var i = 0
    fun next(): Long = steps[minOf(i++, steps.size - 1)]
    fun reset() {
        i = 0
    }
}
