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

    @Test fun fingerprintLooksLikeColonHex() {
        assertEquals("01:AB:FF", fingerprintText(byteArrayOf(1, 0xAB.toByte(), 0xFF.toByte())))
    }
}
