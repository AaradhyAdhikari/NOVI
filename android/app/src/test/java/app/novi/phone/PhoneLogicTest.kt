package app.novi.phone

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

// Phone typing (user, 2026-10-29): the rules the Accessibility service follows, tested without Android.
class PhoneLogicTest {
    @Test fun paymentBankAndSettingsAppsAreHandsOff() {
        assertTrue(blockedApp("com.google.android.apps.nbu.paisa.user")) // Google Pay
        assertTrue(blockedApp("com.phonepe.app"))
        assertTrue(blockedApp("net.one97.paytm"))
        assertTrue(blockedApp("com.sbi.lotusintouch"))
        assertTrue(blockedApp("com.csam.icici.bank.imobile"))
        assertTrue(blockedApp("com.android.settings"))
        assertTrue(blockedApp("com.x8bit.bitwarden"))
        assertFalse(blockedApp("com.whatsapp"))
        assertFalse(blockedApp("com.android.chrome"))
    }

    @Test fun picksTheBoxLikeTheLaptopDoes() {
        val wa = listOf(Field("Search", "", focused = false, area = 100), Field("Message", "", focused = false, area = 300))
        assertEquals(1, pickField(wa, chat = true)) // a chat: its message box
        assertEquals(0, pickField(wa, chat = false)) // elsewhere: the search box
        val focused = listOf(Field("Search", "", focused = false, area = 100), Field("Note", "", focused = true, area = 50))
        assertEquals(1, pickField(focused, chat = false)) // the one with the cursor first
        assertEquals(-1, pickField(emptyList(), chat = false))
        assertEquals(1, pickField(listOf(Field("", "", area = 10), Field("", "", area = 90)), chat = false)) // else the biggest
    }

    @Test fun searchBoxesAreReplacedMessageDraftsKept() {
        assertEquals("pizza", newText(Field("Search", "old search"), "pizza"))
        assertEquals("Hi there", newText(Field("Message", "Hi"), "there"))
        assertEquals("there", newText(Field("Message", "", hintShown = true), "there"))
    }

    @Test fun tapFindsTheButtonByItsWords() {
        val labels = listOf("Sign in to continue reading", "Sign in", "Search")
        assertEquals(1, matchLabel(labels, "login"))
        assertEquals(2, matchLabel(labels, "the search button"))
        assertEquals(-1, matchLabel(labels, "settings"))
    }

    @Test fun moneyAndDeletingTapsAreTheUsersToDo() {
        assertEquals(PHONE_SENSITIVE, tapRefusal("Pay ₹500"))
        assertEquals(PHONE_SENSITIVE, tapRefusal("Place order"))
        assertEquals(PHONE_SENSITIVE, tapRefusal("Delete chat"))
        assertNull(tapRefusal("Send"))
        assertNull(tapRefusal("Search"))
    }

    @Test fun chatsAreKnown() {
        assertTrue(chatPackage("com.whatsapp"))
        assertTrue(chatPackage("org.telegram.messenger"))
        assertFalse(chatPackage("com.android.chrome"))
    }
}
