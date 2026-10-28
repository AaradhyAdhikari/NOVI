package app.novi.phone

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/** After a restart (or an app update) Novi connects again by itself. */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (runCatching { Store(context).paired }.getOrDefault(false)) NoviService.start(context)
    }
}
