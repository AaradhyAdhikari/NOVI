package app.novi.phone

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.assertFalse
import org.junit.Test

class FlickTest {
    @Test fun firstLinkFromSharedText() {
        assertEquals("https://youtu.be/abc?t=30", firstLink("Watch this https://youtu.be/abc?t=30 now"))
        assertEquals("https://chatgpt.com/share/1", firstLink("https://chatgpt.com/share/1"))
        assertNull(firstLink("no link here"))
        assertNull(firstLink("javascript:alert(1)"))
    }

    @Test fun onlyOtherAppsSharedFiles() {
        assertTrue(allowedShare("content", "com.google.android.apps.photos.contentprovider", "app.novi.phone"))
        assertFalse(allowedShare("file", null, "app.novi.phone"))
        assertFalse(allowedShare("content", "app.novi.phone", "app.novi.phone"))
        assertFalse(allowedShare("content", "app.novi.phone.fileprovider", "app.novi.phone"))
        assertFalse(allowedShare("content", "", "app.novi.phone"))
    }
}
