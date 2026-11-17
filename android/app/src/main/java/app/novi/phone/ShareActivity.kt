package app.novi.phone

import android.app.Activity
import android.content.Intent
import android.os.Bundle

/** "Flick to Novi" in Android's share menu: keeps what was shared and opens the flick screen in the app. */
class ShareActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        FlickInbox.take(this, intent)
        // Straight to the laptop, whole files and all (user, 2026-11-17: "it is sending a screenshot, not the file").
        NoviService.instance?.let { svc ->
            if (svc.netOrNull() != null) {
                android.widget.Toast.makeText(this, "Sending to the laptop…", android.widget.Toast.LENGTH_SHORT).show()
                svc.flickInbox(); finish(); return
            }
        }
        android.widget.Toast.makeText(this, "Novi isn't connected yet: opening it…", android.widget.Toast.LENGTH_SHORT).show()
        startActivity(Intent(this, MainActivity::class.java).apply {
            putExtra("page", "/?flick")
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        })
        finish()
    }
}
