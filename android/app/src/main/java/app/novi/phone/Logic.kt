package app.novi.phone

import org.json.JSONObject

// Plain logic with no Android parts, so it is unit-tested on the laptop (LogicTest).

/** Where Novi is (https://host:port) and, from the pairing QR, the one-time code. */
data class PairLink(val base: String, val code: String?)

data class CardAction(val action: String, val title: String)

data class QuestionOption(val label: String, val description: String = "")

/** Claude's question (AskUserQuestion), whole: the phone shows every option and an "Other" box. */
data class Question(val text: String, val options: List<QuestionOption>, val multiSelect: Boolean = false)

/** A small card that only says something happened: one OK. */
data class Notice(val id: String, val title: String, val body: String = "", val repeat: Boolean = false)

private fun noticeFrom(n: JSONObject?): Notice? {
    val id = n?.optString("id").orEmpty()
    return if (id.isEmpty()) null else Notice(id, n!!.optString("title"), n.optString("body"), n.optBoolean("repeat"))
}

fun parseNotice(msg: JSONObject): Notice? = noticeFrom(msg.optJSONObject("notice"))

fun parseNotices(msg: JSONObject): List<Notice> {
    val list = msg.optJSONArray("notices") ?: return emptyList()
    return (0 until list.length()).mapNotNull { noticeFrom(list.optJSONObject(it)) }
}

/** A file on a commit card. added == null: not a text change (a picture). */
data class ChangedFile(val file: String, val added: Int? = null, val removed: Int? = null, val isNew: Boolean = false)

/** The commit card's list: the message and each file with its counts. */
data class Changes(val id: String, val message: String, val files: List<ChangedFile>, val more: Int = 0, val left: List<String> = emptyList())

/** One count beside a file. tone: 1 green, -1 red, 0 grey. */
data class CountPart(val text: String, val tone: Int)

fun countParts(f: ChangedFile): List<CountPart> {
    if (f.isNew) return listOf(CountPart("new", 1))
    val added = f.added ?: return listOf(CountPart("changed", 0))
    return listOfNotNull(
        CountPart("+$added", 1).takeIf { added > 0 },
        CountPart("−${f.removed ?: 0}", -1).takeIf { (f.removed ?: 0) > 0 },
    )
}

/** The lock screen has no room for a long list: its buttons must stay on screen. */
fun lockChanges(ch: Changes, keep: Int = 5): Changes =
    if (ch.files.size <= keep) ch else ch.copy(files = ch.files.take(keep), more = ch.more + ch.files.size - keep)

/** The page that opens one file of a commit card (the page checks it is really on that card). */
fun changesPage(id: String, file: String): String {
    fun enc(s: String) = java.net.URLEncoder.encode(s, "UTF-8").replace("+", "%20")
    return "/?changes=${enc(id)}&file=${enc(file)}"
}

/** MainActivity can be started by other apps: only a page of Novi's own, never another address. */
fun safePage(page: String?): String = if (page != null && page.startsWith("/?")) page else "/"

private fun parseChanges(c: JSONObject?): Changes? {
    if (c == null) return null
    val list = c.optJSONArray("files")
    val files = (0 until (list?.length() ?: 0)).mapNotNull { i ->
        list!!.optJSONObject(i)?.let {
            ChangedFile(it.optString("file"), if (it.has("added")) it.optInt("added") else null, if (it.has("removed")) it.optInt("removed") else null, it.optBoolean("isNew"))
        }
    }
    val left = c.optJSONArray("left")
    return Changes(c.optString("id"), c.optString("message"), files, c.optInt("more"), (0 until (left?.length() ?: 0)).map { left!!.optString(it) })
}

/** A waiting card as the server's cardAlert() builds it, plus the line Novi speaks. */
/** Claude's plan in short: its name, what you get, the real steps. */
data class Plan(val title: String, val summary: String, val steps: List<String>, val more: Int = 0)

fun planLines(p: Plan): List<String> =
    p.steps.mapIndexed { i, s -> "${i + 1}. $s" } + listOfNotNull("and ${p.more} more".takeIf { p.more > 0 })

private fun parsePlan(p: JSONObject?): Plan? {
    if (p == null) return null
    val list = p.optJSONArray("steps")
    val steps = (0 until (list?.length() ?: 0)).map { list!!.optString(it) }.filter { it.isNotBlank() }
    return Plan(p.optString("title"), p.optString("summary"), steps, p.optInt("more"))
}

data class Card(
    val id: String,
    val title: String,
    val body: String = "",
    val actions: List<CardAction> = emptyList(),
    val proof: Boolean = false,
    val spoken: String = "",
    val question: Question? = null,
    val changes: Changes? = null,
    val plan: Plan? = null,
)

/** Submit is only for picking several, or your own typed words; otherwise one tap on an option sends it. */
fun showSubmit(multiSelect: Boolean, typingOwn: Boolean): Boolean = multiSelect || typingOwn

/** The answer sent for Claude's question: your own words win, else the picked labels (", " like the laptop). */
fun questionAnswer(options: List<QuestionOption>, picked: Set<Int>, other: String): String? {
    if (other.isNotBlank()) return other.trim()
    val labels = picked.sorted().mapNotNull { options.getOrNull(it)?.label }
    return labels.joinToString(", ").ifEmpty { null }
}

private fun parseQuestion(q: JSONObject?): Question? {
    if (q == null) return null
    val list = q.optJSONArray("options")
    val options = (0 until (list?.length() ?: 0)).mapNotNull { i ->
        list!!.optJSONObject(i)?.let { QuestionOption(it.optString("label"), it.optString("description")) }
    }
    return Question(q.optString("text"), options, q.optBoolean("multiSelect"))
}

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
        return Card(id, alert.optString("title"), alert.optString("body"), actions, alert.optBoolean("proof"), alert.optString("spoken"), parseQuestion(alert.optJSONObject("question")), parseChanges(alert.optJSONObject("changes")), parsePlan(alert.optJSONObject("plan")))
    }
    val a = msg.optJSONObject("approval") ?: return null
    val id = a.optString("id")
    if (id.isEmpty()) return null
    val proof = a.optString("tier") == "high" || a.optBoolean("pin") || a.has("kind")
    val title = a.optString("title").ifEmpty { a.optString("prompt") }
    return Card(id, title, "", listOf(CardAction("approve", if (proof) "Approve (PIN)" else "Approve"), CardAction("deny", "Deny")), proof, a.optString("prompt"))
}

/**
 * The buttons on the lock-screen card. A card that needs the PIN is never approved from the lock screen
 * (that would get round the phone's own lock): "Unlock to approve" opens the phone, the pop-up takes over.
 */
fun lockScreenActions(card: Card): List<CardAction> =
    card.actions.map { if (card.proof && it.action == "approve") CardAction("unlock", "Unlock to approve") else it }

private fun words(s: String) = s.lowercase().split(Regex("[^\\p{L}\\p{N}]+")).filter { it.isNotEmpty() }

/**
 * What the mic heard is only Novi's own voice reading the card (the echo got through): 4+ words, nearly
 * all of them from the line Novi spoke. A short answer ("Whisper", "option two") is never judged echo.
 */
fun echoOnly(heard: String, spoken: String): Boolean {
    val h = words(heard)
    if (h.size < 4) return false
    val said = words(spoken).toSet()
    return h.count { it in said } >= h.size * 0.8
}

/** 16-bit little-endian audio that is all (near) zero: Android blocked the mic, nobody was just quiet. */
fun isSilent(pcm: ByteArray): Boolean {
    var i = 0
    while (i + 1 < pcm.size) {
        val s = (pcm[i].toInt() and 0xFF) or (pcm[i + 1].toInt() shl 8)
        if (s > 2 || s < -2) return false
        i += 2
    }
    return true
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

    /** New words for a card already here, in its place. False: not one of ours. */
    fun update(card: Card): Boolean {
        val at = cards.indexOfFirst { it.id == card.id }
        if (at < 0) return false
        cards[at] = card
        return true
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
