package app.novi.phone

import android.content.Context
import android.content.SharedPreferences
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKeys

/** Where Novi is, this phone's token and (for a self-signed laptop) the certificate pinned at pairing. */
class Store(context: Context) {
    private val prefs: SharedPreferences = EncryptedSharedPreferences.create(
        "novi",
        MasterKeys.getOrCreate(MasterKeys.AES256_GCM_SPEC),
        context,
        EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
        EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
    )

    var base: String?
        get() = prefs.getString("base", null)
        set(v) = prefs.edit().putString("base", v).apply()
    var token: String?
        get() = prefs.getString("token", null)
        set(v) = prefs.edit().putString("token", v).apply()
    /** SHA-256 of the laptop's certificate (hex), only when Android does not trust it by itself. */
    var pin: String?
        get() = prefs.getString("pin", null)
        set(v) = prefs.edit().putString("pin", v).apply()

    /** Novi's voice, 10 to 100. Starts at half: full was too loud with people around (2026-11-07). */
    var voicePercent: Int
        get() = prefs.getInt("voicePercent", 50)
        set(v) = prefs.edit().putInt("voicePercent", v).apply()

    /** Reads only the short version of a card (user, 2026-11-07). */
    var shortReadOuts: Boolean
        get() = prefs.getBoolean("shortReadOuts", true)
        set(v) = prefs.edit().putBoolean("shortReadOuts", v).apply()
    /** Speaks only through earbuds or headphones, never the phone's speaker. */
    var earbudsOnly: Boolean
        get() = prefs.getBoolean("earbudsOnly", true)
        set(v) = prefs.edit().putBoolean("earbudsOnly", v).apply()

    val paired: Boolean get() = !base.isNullOrEmpty() && !token.isNullOrEmpty()

    fun forget() = prefs.edit().clear().apply()
}
