package app.novi.phone

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class LogicTest {
    @Test fun pairLinkFromTheQr() {
        val link = parsePairLink("https://laptop.tail1234.ts.net:3001/#pair=482913")!!
        assertEquals("https://laptop.tail1234.ts.net:3001", link.base)
        assertEquals("482913", link.code)
    }

    @Test fun pairLinkFromJustTheName() {
        assertEquals(PairLink("https://laptop.tail1234.ts.net:3001", null), parsePairLink(" laptop.tail1234.ts.net "))
        assertEquals(PairLink("https://192.168.1.5:3001", null), parsePairLink("https://192.168.1.5:3001/"))
        assertNull(parsePairLink(""))
        assertNull(parsePairLink("http://laptop:3001"))
        assertNull(parsePairLink("not a link at all"))
    }

    @Test fun socketAddress() {
        assertEquals("wss://laptop.ts.net:3001/ws", wsUrl("https://laptop.ts.net:3001"))
    }

    @Test fun cardFromTheServer() {
        val c = parseCard(JSONObject("""{"id":"a1","title":"High risk: Delete logs","body":"Approving needs your PIN.","proof":true,"spoken":"Say your PIN to approve, or say no.","actions":[{"action":"approve","title":"Approve (PIN)"},{"action":"deny","title":"Deny"}]}"""))!!
        assertEquals("a1", c.id)
        assertTrue(c.proof)
        assertEquals(listOf("approve", "deny"), c.actions.map { it.action })
        assertEquals("Say your PIN to approve, or say no.", c.spoken)
    }

    @Test fun cardWithoutAlertFallsBackToTheApproval() {
        val c = parseCard(JSONObject("""{"approval":{"id":"b2","title":"Start the site?","tier":"medium"}}"""))!!
        assertEquals("b2", c.id)
        assertEquals("Start the site?", c.title)
        assertEquals(listOf("approve", "deny"), c.actions.map { it.action })
        assertNull(parseCard(JSONObject("""{"title":"no id"}""")))
    }

    @Test fun cardListKeepsNewestOnTopAndDropsAnswered() {
        val cards = CardList()
        cards.replace(listOf(Card("a", "A"), Card("b", "B")))
        cards.add(Card("c", "C"))
        cards.add(Card("a", "A again"))
        assertEquals(listOf("a", "c", "b"), cards.all().map { it.id })
        assertEquals("A again", cards.top()!!.title)
        cards.remove("a")
        assertEquals("c", cards.top()!!.id)
        cards.remove("nope")
        assertEquals(2, cards.size)
    }

    @Test fun backoffGrowsAndResets() {
        val b = Backoff()
        assertEquals(listOf(1000L, 2000L, 5000L, 10000L, 30000L, 30000L), List(6) { b.next() })
        b.reset()
        assertEquals(1000L, b.next())
    }

    @Test fun novisOwnVoiceIsNotAnAnswer() {
        val spoken = "Claude asks: Which voice system? One, BHASHINI. Two, Whisper. Three, Both. Or say other, and your answer."
        assertTrue(echoOnly("Which voice system? One Bhashini, two whisper", spoken))
        assertEquals(false, echoOnly("option two", spoken))
        assertEquals(false, echoOnly("Whisper", spoken))
        assertEquals(false, echoOnly("in other I want IndicConformer for Indian languages", spoken))
    }

    @Test fun claudesQuestionArrivesWhole() {
        val c = parseCard(JSONObject("""{"alert":{"id":"q1","title":"Claude asks: Which voice?","actions":[],"question":{"text":"Which voice?","multiSelect":false,"options":[{"label":"BHASHINI","description":"Indian languages"},{"label":"Whisper","description":""}]}}}"""))!!
        assertEquals("Which voice?", c.question!!.text)
        assertEquals(listOf("BHASHINI", "Whisper"), c.question!!.options.map { it.label })
        assertEquals("Indian languages", c.question!!.options[0].description)
        assertNull(parseCard(JSONObject("""{"alert":{"id":"a","title":"Start?","actions":[]}}"""))!!.question)
    }

    @Test fun questionAnswerIsTheOptionOrYourOwnWords() {
        val opts = listOf(QuestionOption("Light"), QuestionOption("Dark"), QuestionOption("Auto"))
        assertEquals("Dark", questionAnswer(opts, setOf(1), ""))
        assertEquals("Light, Auto", questionAnswer(opts, setOf(2, 0), ""))
        assertEquals("Use the system theme", questionAnswer(opts, setOf(1), "  Use the system theme "))
        assertNull(questionAnswer(opts, emptySet(), " "))
    }

    @Test fun lockScreenNeverApprovesAPinCard() {
        val pin = Card("a", "Delete logs", actions = listOf(CardAction("approve", "Approve (PIN)"), CardAction("deny", "Deny")), proof = true)
        assertEquals(listOf("unlock", "deny"), lockScreenActions(pin).map { it.action })
        assertEquals("Unlock to approve", lockScreenActions(pin)[0].title)
        val plain = Card("b", "Start the site?", actions = listOf(CardAction("approve", "Approve"), CardAction("deny", "Deny")))
        assertEquals(listOf("approve", "deny"), lockScreenActions(plain).map { it.action })
    }

    @Test fun blockedMicRecordsOnlyZeros() {
        assertTrue(isSilent(ByteArray(3200)))
        assertTrue(isSilent(byteArrayOf(1, 0, -1, -1)))
        assertEquals(false, isSilent(byteArrayOf(0, 0, 0x40, 0x10)))
        assertTrue(isSilent(ByteArray(0)))
    }

    @Test fun fingerprintLooksLikeColonHex() {
        assertEquals("01:AB:FF", fingerprintText(byteArrayOf(1, 0xAB.toByte(), 0xFF.toByte())))
    }
}
