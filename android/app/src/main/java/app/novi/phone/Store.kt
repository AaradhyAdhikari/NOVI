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

    val paired: Boolean get() = !base.isNullOrEmpty() && !token.isNullOrEmpty()

    fun forget() = prefs.edit().clear().apply()
}
