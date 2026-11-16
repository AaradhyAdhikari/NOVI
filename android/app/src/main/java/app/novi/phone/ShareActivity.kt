package app.novi.phone

import android.app.Activity
import android.content.Intent
import android.os.Bundle

/** "Flick to Novi" in Android's share menu: keeps what was shared and opens the flick screen in the app. */
class ShareActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        FlickInbox.take(this, intent)
        startActivity(Intent(this, MainActivity::class.java).apply {
            putExtra("page", "/?flick")
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        })
        finish()
    }
}
