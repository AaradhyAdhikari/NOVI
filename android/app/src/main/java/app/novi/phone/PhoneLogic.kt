package app.novi.phone

// Phone typing (user, 2026-10-29: "Yes, build phone typing"): the rules NoviAccess follows, with no
// Android parts so they are unit-tested on the laptop (PhoneLogicTest). Same rules as the laptop's
// Screen Mode (plugins/screen/mode.js): the box with the cursor, else a chat's message box / a search
// box / the biggest; search boxes replaced, drafts kept; payments, banks, passwords never.

const val PHONE_SENSITIVE = "This looks sensitive. Please do this part yourself."

/** Payment, bank, password-manager, authenticator, Settings and installer apps: Novi keeps her hands off. */
private val BLOCKED = listOf(
    "com.google.android.apps.nbu.paisa", "com.phonepe", "net.one97.paytm", "in.org.npci.upiapp", "in.amazon.mshop.android.shopping.pay",
    "com.mobikwik", "com.freecharge", "com.sbi", "com.snapwork.hdfc", "com.hdfc", "com.csam.icici", "com.icici", "com.axis",
    "com.msf.kbank", "com.kotak", "com.bankofbaroda", "com.pnb", "com.canarabank", "com.unionbank", "com.idbi", "com.yesbank",
    "com.indusind", "com.fss.", "com.infrasofttech", "com.google.android.apps.authenticator", "com.azure.authenticator",
    "com.x8bit.bitwarden", "com.lastpass", "com.onepassword", "com.agilebits", "com.dashlane", "com.android.settings",
    "com.samsung.android.settings", "com.android.packageinstaller", "com.google.android.packageinstaller",
    "com.android.vending", "com.samsung.android.spay", "com.samsung.android.samsungpass",
)
fun blockedApp(pkg: String): Boolean {
    val p = pkg.lowercase()
    return BLOCKED.any { p.startsWith(it) } || Regex("""(^|\.)(bank|banking|upi|wallet|pay)(\.|$)""").containsMatchIn(p)
}

private val CHATS = listOf("com.whatsapp", "org.telegram", "org.thunderdog.challegram", "com.instagram", "com.facebook.orca",
    "org.thoughtcrime.securesms", "com.google.android.gm", "com.google.android.apps.messaging", "com.samsung.android.messaging",
    "com.discord", "com.Slack", "com.microsoft.teams", "com.snapchat")
fun chatPackage(pkg: String): Boolean = CHATS.any { pkg.startsWith(it) }

/** An editable box on screen: its hint / name, its text, whether it has the cursor, its size. */
data class Field(val hint: String, val text: String, val focused: Boolean = false, val area: Int = 0, val hintShown: Boolean = false)

private val SEARCH = Regex("""search|address|query|\bfind\b|\burl\b""", RegexOption.IGNORE_CASE)
private val MESSAGE = Regex("""message|type a|write|reply|comment|compose|\bask\b|\bchat\b""", RegexOption.IGNORE_CASE)
fun isSearch(f: Field) = SEARCH.containsMatchIn(f.hint)

/** Which box to type into: index, or -1 when there's none. */
fun pickField(fields: List<Field>, chat: Boolean): Int {
    if (fields.isEmpty()) return -1
    fields.indexOfFirst { it.focused }.let { if (it >= 0) return it }
    val message = { f: Field -> MESSAGE.containsMatchIn(f.hint) && !isSearch(f) }
    val search = { f: Field -> isSearch(f) }
    val order = if (chat) listOf(message, search) else listOf(search, message)
    for (fits in order) fields.indexOfFirst(fits).let { if (it >= 0) return it }
    return fields.indices.maxBy { fields[it].area }
}

/** The box's text after typing: a search is replaced, a message draft goes on ("Hi" + "there"). */
fun newText(f: Field, typed: String): String {
    if (isSearch(f) || f.hintShown || f.text.isBlank()) return typed
    return f.text.trimEnd() + " " + typed
}

/** The label a spoken target means: every word in it (login = Log in / Sign in), shortest first; -1 = none. */
fun matchLabel(labels: List<String>, target: String): Int {
    val filler = setOf("the", "a", "an", "on", "in", "button", "link", "icon", "tap", "click", "my", "this", "that")
    val words = target.lowercase().split(Regex("""[^\p{L}\p{N}]+""")).filter { it.isNotBlank() && it !in filler }
    if (words.isEmpty()) return -1
    val alias = when (words.joinToString("")) {
        "login", "signin" -> Regex("""\b(log ?in|sign ?in)\b""", RegexOption.IGNORE_CASE)
        "logout", "signout" -> Regex("""\b(log ?out|sign ?out)\b""", RegexOption.IGNORE_CASE)
        else -> null
    }
    val hits = labels.indices.filter { i -> alias?.containsMatchIn(labels[i]) ?: words.all { labels[i].lowercase().contains(it) } }
    return hits.minByOrNull { labels[it].length } ?: -1
}

private val MONEY_OR_DELETE = Regex("""\b(pay|payment|buy|purchase|place (your |the )?order|checkout|check out|transfer|send money|donate|upi|delete|remove|uninstall|erase|wipe|reset|format)\b""", RegexOption.IGNORE_CASE)
/** A tap on this would pay or delete: the user does that part (no PIN on the phone yet). */
fun tapRefusal(label: String): String? = if (MONEY_OR_DELETE.containsMatchIn(label)) PHONE_SENSITIVE else null
