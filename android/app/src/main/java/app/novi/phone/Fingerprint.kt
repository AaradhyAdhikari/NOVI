package app.novi.phone

import android.content.Context
import android.hardware.biometrics.BiometricManager
import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyPermanentlyInvalidatedException
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.PrivateKey
import java.security.Signature
import java.security.spec.ECGenParameterSpec

/**
 * Novi's fingerprint key (2026-11-11, instead of the PIN on risky cards). It lives in Android's keystore, only a
 * fingerprint unlocks it for each signature, and Android breaks it when a new fingerprint is added to the phone:
 * Android never says WHICH enrolled finger matched, so that is how "only my fingerprint" holds. Novi on the
 * laptop keeps the public half (server/fingerprint.js) and checks each signed approval.
 */
object Fingerprint {
    private const val ALIAS = "novi-approve"

    private fun store() = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }

    /** A fingerprint is enrolled and strong enough (Android 11+ for one signature per touch). */
    fun canUse(ctx: Context): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return false
        val bm = ctx.getSystemService(BiometricManager::class.java) ?: return false
        return bm.canAuthenticate(BiometricManager.Authenticators.BIOMETRIC_STRONG) == BiometricManager.BIOMETRIC_SUCCESS
    }

    fun has(): Boolean = runCatching { store().containsAlias(ALIAS) }.getOrDefault(false)

    fun remove() { runCatching { store().deleteEntry(ALIAS) } }

    /** Makes a new key (the old one goes) and returns its public half for Novi, base64 SPKI. */
    fun create(): String {
        remove()
        val spec = KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_SIGN)
            .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
            .setDigests(KeyProperties.DIGEST_SHA256)
            .setUserAuthenticationRequired(true)
            .setInvalidatedByBiometricEnrollment(true)
            .apply { if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) setUserAuthenticationParameters(0, KeyProperties.AUTH_BIOMETRIC_STRONG) }
            .build()
        val pair = KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, "AndroidKeyStore").apply { initialize(spec) }.generateKeyPair()
        return Base64.encodeToString(pair.public.encoded, Base64.NO_WRAP)
    }

    sealed class Ready {
        class Yes(val signature: Signature) : Ready()
        /** A new fingerprint was added to the phone (or the lock screen removed): the key is gone for good. */
        object Broken : Ready()
        object None : Ready()
    }

    /** A signature ready to be unlocked by a fingerprint touch. */
    fun prepare(): Ready {
        val key = runCatching { store().getKey(ALIAS, null) as? PrivateKey }.getOrNull() ?: return Ready.None
        return try {
            Ready.Yes(Signature.getInstance("SHA256withECDSA").apply { initSign(key) })
        } catch (e: KeyPermanentlyInvalidatedException) {
            remove()
            Ready.Broken
        }
    }

    /** What the phone signs for one card: the same text the laptop checks. */
    fun message(cardId: String, nonce: String) = "novi-approve:$cardId:$nonce"

    fun sign(signature: Signature, cardId: String, nonce: String): String {
        signature.update(message(cardId, nonce).toByteArray(Charsets.UTF_8))
        return Base64.encodeToString(signature.sign(), Base64.NO_WRAP)
    }
}
