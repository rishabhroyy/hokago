package com.hokago.app

import android.os.Environment
import android.webkit.JavascriptInterface
import android.webkit.WebView
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.util.UUID
import java.util.concurrent.Executors

/**
 * The Android half of the bridge. Storage ops are synchronous (WebView's
 * addJavascriptInterface runs on the JS thread); downloads run on a
 * background executor and resolve the web-side promise via a CustomEvent.
 */
class NativeBridge(private val webView: WebView) {

    private val executor = Executors.newSingleThreadExecutor()

    val injectedScript: String by lazy {
        """
        (function () {
          if (window.__hokagoBridge || !window.androidBridge) return;
          window.__hokagoBridge = true;
          var pending = {};
          var nextId = 1;
          window.addEventListener("hokago-native", function (ev) {
            var d = ev.detail || {};
            if (d.type === "downloadResult") {
              var p = pending[d.id];
              if (!p) return;
              delete pending[d.id];
              if (d.ok) p.resolve({ localPath: d.localPath, sizeBytes: d.sizeBytes });
              else p.reject(new Error(d.error || "download failed"));
            } else if (d.type === "downloadListResult") {
              var p = pending[d.id];
              if (!p) return;
              delete pending[d.id];
              p.resolve(d.entries || []);
            } else if (d.type === "readTextResult") {
              var p = pending[d.id];
              if (!p) return;
              delete pending[d.id];
              if (d.ok) p.resolve(d.text);
              else p.reject(new Error(d.error || "could not read subtitle"));
            }
          });
          window.hokagoNative = {
            platform: window.androidBridge.platform(),
            appVersion: window.androidBridge.appVersion(),
            appBuild: window.androidBridge.appBuild(),
            clientKey: window.androidBridge.clientKey(),
            serverUrl: window.androidBridge.serverUrl(),
            storage: {
              get: function (k) { return window.androidBridge.storageGet(k); },
              set: function (k, v) { window.androidBridge.storageSet(k, v); },
              delete: function (k) { window.androidBridge.storageDelete(k); }
            },
            downloads: {
              save: function (url, filename) {
                var id = nextId++;
                return new Promise(function (resolve, reject) {
                  pending[id] = { resolve: resolve, reject: reject };
                  window.androidBridge.saveDownload(id, url, filename);
                });
              },
              list: function () {
                var id = nextId++;
                return new Promise(function (resolve, reject) {
                  pending[id] = { resolve: resolve, reject: reject };
                  window.androidBridge.downloadList(id);
                });
              },
              localUrl: function (localPath) {
                return "hokago-file://" + String(localPath).replace(/ /g, "%20");
              },
              readText: function (localPath) {
                var id = nextId++;
                return new Promise(function (resolve, reject) {
                  pending[id] = { resolve: resolve, reject: reject };
                  window.androidBridge.readText(id, localPath);
                });
              },
              open: function (path) { window.androidBridge.openPath(path); }
            }
          };
        })();
        """.trimIndent()
    }

    // ── Sync: version / identity / storage ────────────────────────────────
    @JavascriptInterface
    fun platform(): String = if (MainActivity.isTvForm) "androidtv" else "android"

    @JavascriptInterface
    fun appVersion(): String = BuildConfig.VERSION_NAME

    @JavascriptInterface
    fun appBuild(): String = BuildConfig.VERSION_CODE.toString()

    @JavascriptInterface
    fun clientKey(): String {
        val prefs = HokagoApp.instance.getSharedPreferences("hokago_config", 0)
        var key = prefs.getString("clientKey", null)
        if (key == null) {
            key = UUID.randomUUID().toString().replace("-", "")
            prefs.edit().putString("clientKey", key).apply()
        }
        return key
    }

    @JavascriptInterface
    fun serverUrl(): String? {
        val prefs = HokagoApp.instance.getSharedPreferences("hokago_config", 0)
        return prefs.getString("serverURL", null)
    }

    @JavascriptInterface
    fun storageGet(key: String): String? = SecureStore.get(key)

    @JavascriptInterface
    fun storageSet(key: String, value: String) = SecureStore.set(key, value)

    @JavascriptInterface
    fun storageDelete(key: String) = SecureStore.delete(key)

    // ── Async: downloads ───────────────────────────────────────────────────
    @JavascriptInterface
    fun saveDownload(id: Int, url: String, filename: String) {
        executor.execute {
            val result = download(id, url, filename)
            postEvent("downloadResult", result)
        }
    }

    @JavascriptInterface
    fun downloadList(id: Int) {
        executor.execute {
            val dir = File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS), "hokago")
            val entries = JSONArray()
            dir.listFiles()?.forEach { f ->
                if (f.isFile && !f.name.startsWith(".")) {
                    val o = JSONObject()
                    o.put("localPath", f.absolutePath)
                    o.put("sizeBytes", f.length())
                    entries.put(o)
                }
            }
            val payload = JSONObject()
            payload.put("id", id)
            payload.put("entries", entries)
            postEvent("downloadListResult", payload.toString())
        }
    }

    @JavascriptInterface
    fun readText(id: Int, localPath: String) {
        executor.execute {
            try {
                val text = File(localPath).readText()
                postEvent("readTextResult", "{\"id\":$id,\"ok\":true,\"text\":${JSONObject.quote(text)}}")
            } catch (e: Exception) {
                postEvent("readTextResult", "{\"id\":$id,\"ok\":false,\"error\":${JSONObject.quote(e.message ?: "could not read subtitle")}}")
            }
        }
    }

    private fun download(id: Int, url: String, filename: String): String {
        val token = SecureStore.get("hokago_access_token")
            ?: return resultJson(id, ok = false, error = "no session — sign in first")

        var connection: HttpURLConnection? = null
        try {
            connection = URL(url).openConnection() as HttpURLConnection
            connection.setRequestProperty("Authorization", "Bearer $token")
            connection.connectTimeout = 30_000
            connection.readTimeout = 60_000
            val code = connection.responseCode
            if (code == 401) return resultJson(id, false, error = "session expired — reopen hokago to refresh")
            if (code !in 200..299) return resultJson(id, false, error = "the server answered $code")

            val dir = File(
                Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS),
                "hokago"
            ).apply { mkdirs() }
            val safe = filename.map { if (it.isLetterOrDigit() || it == '.' || it == '-' || it == '_' || it == ' ') it else '_' }.joinToString("")
            val dest = File(dir, safe)
            connection.inputStream.use { input ->
                dest.outputStream().use { output -> input.copyTo(output) }
            }
            return resultJson(id, true, dest.absolutePath, dest.length())
        } catch (e: Exception) {
            return resultJson(id, false, error = e.message ?: "download failed")
        } finally {
            connection?.disconnect()
        }
    }

    private fun resultJson(id: Int, ok: Boolean, localPath: String? = null, sizeBytes: Long? = null, error: String? = null): String {
        val o = JSONObject()
        o.put("id", id)
        o.put("ok", ok)
        o.put("localPath", localPath ?: "")
        o.put("sizeBytes", sizeBytes ?: 0)
        o.put("error", error ?: "")
        return o.toString()
    }

    private fun postEvent(type: String, payload: String) {
        webView.post {
            webView.evaluateJavascript(
                "window.dispatchEvent(new CustomEvent('hokago-native', { detail: Object.assign({type: '$type'}, $payload) }));"
            ) {}
        }
    }

    @JavascriptInterface
    fun openPath(path: String) {
        webView.post {
            val context = webView.context
            val uri = androidx.core.content.FileProvider.getUriForFile(context, "${context.packageName}.fileprovider", File(path))
            val intent = android.content.Intent(android.content.Intent.ACTION_VIEW).apply {
                setDataAndType(uri, "video/mp4")
                addFlags(android.content.Intent.FLAG_GRANT_READ_URI_PERMISSION)
            }
            context.startActivity(intent)
        }
    }
}