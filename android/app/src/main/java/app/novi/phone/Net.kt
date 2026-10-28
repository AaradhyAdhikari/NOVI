package app.novi.phone

import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject
import java.security.KeyStore
import java.security.MessageDigest
import java.security.cert.CertificateException
import java.security.cert.X509Certificate
import java.util.concurrent.TimeUnit
import javax.net.ssl.HttpsURLConnection
import javax.net.ssl.SSLContext
import javax.net.ssl.TrustManagerFactory
import javax.net.ssl.X509TrustManager

private fun sha256(cert: X509Certificate): ByteArray = MessageDigest.getInstance("SHA-256").digest(cert.encoded)
private fun hex(b: ByteArray) = b.joinToString("") { "%02x".format(it.toInt() and 0xFF) }

private fun systemTrust(): X509TrustManager {
    val f = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm())
    f.init(null as KeyStore?)
    return f.trustManagers.filterIsInstance<X509TrustManager>().first()
}

/**
 * Android's own trust first (the Tailscale ts.net certificate is a real one). A laptop with Novi's
 * self-signed certificate (LAN address) is trusted only if it is exactly the certificate the user
 * accepted at pairing: never "trust everything".
 */
private class PinnedTrust(private val pin: String?) : X509TrustManager {
    private val system = systemTrust()
    override fun checkClientTrusted(chain: Array<X509Certificate>, authType: String) = system.checkClientTrusted(chain, authType)
    override fun checkServerTrusted(chain: Array<X509Certificate>, authType: String) {
        try {
            system.checkServerTrusted(chain, authType)
        } catch (e: CertificateException) {
            if (pin == null || chain.isEmpty() || hex(sha256(chain[0])) != pin) throw e
        }
    }
    override fun getAcceptedIssuers(): Array<X509Certificate> = system.acceptedIssuers
}

private val JSON = "application/json".toMediaType()

class NoviError(message: String, val code: Int) : Exception(message)

class Net(private val base: String, private val token: String?, pin: String?) {
    val client: OkHttpClient = run {
        val trust = PinnedTrust(pin)
        val ssl = SSLContext.getInstance("TLS").apply { init(null, arrayOf(trust), null) }
        val defaultHosts = HttpsURLConnection.getDefaultHostnameVerifier()
        OkHttpClient.Builder()
            .sslSocketFactory(ssl.socketFactory, trust)
            .hostnameVerifier { host, session ->
                defaultHosts.verify(host, session) ||
                    (pin != null && (session.peerCertificates.firstOrNull() as? X509Certificate)?.let { hex(sha256(it)) == pin } == true)
            }
            .connectTimeout(10, TimeUnit.SECONDS)
            .readTimeout(30, TimeUnit.SECONDS)
            .pingInterval(25, TimeUnit.SECONDS)
            .build()
    }

    private fun request(path: String) = Request.Builder().url(base + path).also { b -> token?.let { b.header("Authorization", "Bearer $it") } }

    private fun call(req: Request): JSONObject = client.newCall(req).execute().use { res ->
        val text = res.body?.string().orEmpty()
        val json = runCatching { JSONObject(text) }.getOrDefault(JSONObject())
        if (!res.isSuccessful) throw NoviError(json.optString("error").ifEmpty { "Novi answered ${res.code}." }, res.code)
        json
    }

    fun post(path: String, body: JSONObject = JSONObject()): JSONObject = call(request(path).post(body.toString().toRequestBody(JSON)).build())
    fun get(path: String): JSONObject = call(request(path).get().build())

    /** Speech to text on the laptop (same as the web talk button). */
    fun stt(wav: ByteArray): String = call(request("/api/stt").post(wav.toRequestBody("audio/wav".toMediaType())).build()).optString("text")

    fun socket(listener: WebSocketListener): WebSocket = client.newWebSocket(Request.Builder().url(wsUrl(base)).build(), listener)

    companion object {
        /**
         * Before pairing: null when Android already trusts the laptop (Tailscale certificate), else the
         * SHA-256 of its certificate (hex + "AB:CD:..." to show), for the user to accept once.
         */
        fun probe(base: String): Pair<String, String>? {
            val plain = OkHttpClient.Builder().connectTimeout(10, TimeUnit.SECONDS).build()
            val trusted = runCatching { plain.newCall(Request.Builder().url("$base/api/push/key").head().build()).execute().close() }
            if (trusted.isSuccess) return null
            var seen: X509Certificate? = null
            val look = object : X509TrustManager {
                override fun checkClientTrusted(chain: Array<X509Certificate>, authType: String) {}
                override fun checkServerTrusted(chain: Array<X509Certificate>, authType: String) {
                    seen = chain.firstOrNull()
                }
                override fun getAcceptedIssuers(): Array<X509Certificate> = arrayOf()
            }
            val ssl = SSLContext.getInstance("TLS").apply { init(null, arrayOf(look), null) }
            // Only the handshake matters here (to read the certificate); nothing is sent that needs trust.
            val c = OkHttpClient.Builder().sslSocketFactory(ssl.socketFactory, look).hostnameVerifier { _, _ -> true }
                .connectTimeout(10, TimeUnit.SECONDS).build()
            runCatching { c.newCall(Request.Builder().url("$base/api/push/key").head().build()).execute().close() }
            val cert = seen ?: throw NoviError("Couldn't reach Novi at $base. Is the laptop on, and Tailscale on here?", 0)
            val digest = sha256(cert)
            return hex(digest) to fingerprintText(digest)
        }
    }
}
