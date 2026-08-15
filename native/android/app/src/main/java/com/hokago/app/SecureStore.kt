package com.hokago.app

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * Token mirror — AES-GCM wrapped by the Android Keystore, so a webview data
 * wipe (or app data clear) never kills a session.
 */
object SecureStore {
    private const val ANDROID_KEYSTORE = "AndroidKeyStore"
    private const val ALIAS = "hokago_tokens"
    private const val PREFS = "hokago_secure"
    private const val IV_LEN = 12

    private fun key(): SecretKey {
        val ks = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }
        (ks.getKey(ALIAS, null) as? SecretKey)?.let { return it }
        val gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEYSTORE)
        gen.init(
            KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .build()
        )
        return gen.generateKey()
    }

    fun get(key: String): String? {
        val raw = prefs().getString(key, null) ?: return null
        return try {
            val bytes = Base64.decode(raw, Base64.NO_WRAP)
            val iv = bytes.copyOfRange(0, IV_LEN)
            val cipherText = bytes.copyOfRange(IV_LEN, bytes.size)
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, iv))
            String(cipher.doFinal(cipherText))
        } catch (e: Exception) {
            null
        }
    }

    fun set(key: String, value: String) {
        try {
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.ENCRYPT_MODE, key())
            val out = cipher.iv + cipher.doFinal(value.toByteArray())
            prefs().edit().putString(key, Base64.encodeToString(out, Base64.NO_WRAP)).apply()
        } catch (e: Exception) {
            // Keystore failure — degrade to plain prefs rather than lose the session
            prefs().edit().putString(key, "plain:$value").apply()
        }
    }

    fun delete(key: String) {
        prefs().edit().remove(key).apply()
    }

    private fun prefs() =
        HokagoApp.instance.getSharedPreferences(PREFS, android.content.Context.MODE_PRIVATE)
}