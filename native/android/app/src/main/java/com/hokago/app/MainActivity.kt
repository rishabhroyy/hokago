package com.hokago.app

import android.annotation.SuppressLint
import android.content.pm.ActivityInfo
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.view.Gravity
import android.view.KeyEvent
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import java.io.File
import java.io.FileInputStream
import kotlin.math.roundToInt

class MainActivity : AppCompatActivity() {

    private lateinit var root: FrameLayout
    private lateinit var webView: WebView
    private var bridge: NativeBridge? = null
    private var setupView: View? = null

    /** Route-driven cinema mode (player routes hide the system bars). */
    private var cinematic = false

    /** HTML5 fullscreen custom view is active (WebChromeClient). */
    private var customViewActive = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // Edge-to-edge on every API level (enforced on 35+): the web app
        // pads itself via --hokago-safe-* (injected from the insets below).
        WindowCompat.setDecorFitsSystemWindows(window, false)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            // Let content sit behind the display cutout (short edges only) —
            // landscape playback extends under a punch-hole camera, and the
            // cutout inset still lands in the safe-area CSS vars.
            window.attributes.layoutInDisplayCutoutMode =
                WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES
        }

        root = FrameLayout(this)
        setContentView(root)

        webView = WebView(this)
        root.addView(webView, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))

        configureWebView()

        // Forward system-bar + cutout insets to the page as CSS variables.
        // Modern Chrome-based WebViews also resolve env(safe-area-inset-*)
        // directly (M136+), but older engines report 0 — the inline
        // --hokago-safe-* override makes every device consistent.
        ViewCompat.setOnApplyWindowInsetsListener(root) { _, insets ->
            val bars = insets.getInsets(
                WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout()
            )
            injectSafeArea(bars.top, bars.right, bars.bottom, bars.left)
            insets
        }

        val savedUrl = prefs().getString("serverURL", null)
        if (savedUrl.isNullOrEmpty()) showSetup() else load(savedUrl)
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun configureWebView() {
        val settings = webView.settings
        settings.javaScriptEnabled = true
        settings.domStorageEnabled = true
        settings.databaseEnabled = true
        settings.mediaPlaybackRequiresUserGesture = false
        settings.allowFileAccess = false
        settings.loadWithOverviewMode = true
        settings.useWideViewPort = true
        settings.mixedContentMode = WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE
        // App feel: no pinch/double-tap zoom chrome, no overscroll glow.
        settings.setSupportZoom(false)
        settings.displayZoomControls = false
        webView.overScrollMode = View.OVER_SCROLL_NEVER
        if (BuildConfig.DEBUG) WebView.setWebContentsDebuggingEnabled(true)

        webView.webChromeClient = HokagoChromeClient()
        webView.webViewClient = object : WebViewClient() {
            private var offlineFallbackShown = false

            override fun onPageStarted(view: WebView, url: String?, favicon: android.graphics.Bitmap?) {
                super.onPageStarted(view, url, favicon)
                bridge?.let { view.evaluateJavascript(it.injectedScript) {} }
                // The old page's insets are gone with it — re-seed the vars.
                applyCurrentInsets()
            }

            override fun onPageFinished(view: WebView, url: String?) {
                super.onPageFinished(view, url)
                applyCurrentInsets()
            }

            override fun onReceivedError(
                view: WebView,
                request: WebResourceRequest?,
                error: WebResourceError?,
            ) {
                super.onReceivedError(view, request, error)
                // Server unreachable (main-frame load failed) → bundled SPA offline mode.
                val isMainFrame = request?.isForMainFrame == true
                val isNetwork = error?.errorCode == ERROR_HOST_LOOKUP || error?.errorCode == ERROR_CONNECT || error?.errorCode == ERROR_TIMEOUT
                if (isMainFrame && isNetwork && !offlineFallbackShown) {
                    offlineFallbackShown = true
                    loadBundledSpa()
                }
            }

            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
                val uri = request.url
                // Offline SPA origin: served from app assets. file:// would
                // break the SPA's absolute asset paths (/assets/...), its
                // history router (needs a root path) and allowFileAccess=false,
                // so a real-looking origin is intercepted instead. http:// (not
                // https) so media/sync back to an http:// server isn't mixed content.
                if (uri.host == OFFLINE_HOST) {
                    return serveOfflineAsset(uri.path ?: "/")
                }
                if (uri.scheme == "hokago-file") {
                    return serveLocalFile(uri, request.requestHeaders?.get("Range"))
                }
                return super.shouldInterceptRequest(view, request)
            }
        }
        val b = NativeBridge(webView, this)
        bridge = b
        webView.addJavascriptInterface(b, "androidBridge")
    }

    // ── Safe areas ─────────────────────────────────────────────────────────
    private fun applyCurrentInsets() {
        val insets = ViewCompat.getRootWindowInsets(root)
            ?: return
        val bars = insets.getInsets(
            WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout()
        )
        injectSafeArea(bars.top, bars.right, bars.bottom, bars.left)
    }

    /** Pushes the current system-inset values into the page's CSS variables
     *  (--hokago-safe-top/right/bottom/left, in CSS px = dp at full zoom). */
    private fun injectSafeArea(top: Int, right: Int, bottom: Int, left: Int) {
        val d = resources.displayMetrics.density
        fun css(v: Int): Int = (v / d).roundToInt().coerceAtLeast(0)
        val js = "var s=document.documentElement.style;" +
            "s.setProperty('--hokago-safe-top','${css(top)}px');" +
            "s.setProperty('--hokago-safe-right','${css(right)}px');" +
            "s.setProperty('--hokago-safe-bottom','${css(bottom)}px');" +
            "s.setProperty('--hokago-safe-left','${css(left)}px');"
        webView.evaluateJavascript(js) {}
    }

    // ── Cinema mode (system bars) ──────────────────────────────────────────
    /** Called from the bridge whenever the SPA route enters/leaves the player. */
    fun setPlayerRoute(onPlayer: Boolean) {
        cinematic = onPlayer && !isTvForm
        applySystemUi()
    }

    private fun applySystemUi() {
        val hidden = cinematic || customViewActive
        val controller = WindowCompat.getInsetsController(window, webView)
        if (hidden) {
            controller.hide(WindowInsetsCompat.Type.systemBars())
            controller.systemBarsBehavior =
                WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        } else {
            controller.show(WindowInsetsCompat.Type.systemBars())
        }
    }

    /** WebChromeClient with native fullscreen: the vidstack fullscreen button
     *  drives onShowCustomView (the HTML fullscreen element hosts in a
     *  dedicated view), system bars drop out, and phones lock to landscape —
     *  the native-player feel, on top of the same in-webview renderer. */
    private inner class HokagoChromeClient : WebChromeClient() {
        private var customView: View? = null
        private var customViewCallback: CustomViewCallback? = null
        private var priorOrientation = ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED

        override fun onShowCustomView(view: View, callback: CustomViewCallback) {
            if (customView != null) {
                callback.onCustomViewHidden()
                return
            }
            customView = view
            customViewCallback = callback
            root.addView(view, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
            // Phones: fullscreen playback is landscape (sensors — follow the
            // device tilt, never force a single side).
            if (!isTvForm) {
                priorOrientation = requestedOrientation
                requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE
            }
            customViewActive = true
            applySystemUi()
        }

        override fun onHideCustomView() {
            val view = customView ?: return
            root.removeView(view)
            customViewCallback?.onCustomViewHidden()
            customView = null
            customViewCallback = null
            if (!isTvForm) requestedOrientation = priorOrientation
            customViewActive = false
            applySystemUi()
        }
    }

    // ── Offline fallback ───────────────────────────────────────────────────
    /** Offline fallback: serve the bundled SPA from the fake origin
     *  http://$OFFLINE_HOST/ (intercepted by shouldInterceptRequest). */
    private fun loadBundledSpa() {
        webView.loadUrl("http://$OFFLINE_HOST/")
    }

    /** Serves web-dist from app assets; route fallback to index.html so SPA
     *  deep links work. */
    private fun serveOfflineAsset(path: String): WebResourceResponse {
        val rel = path.trimStart('/').ifEmpty { "index.html" }
            // No path traversal out of web-dist.
            .split('/').filter { it.isNotEmpty() && it != "." && it != ".." }.joinToString("/")
        val candidates = listOf(rel, "$rel/index.html", "index.html")
        for (candidate in candidates) {
            val assetPath = "web-dist/$candidate"
            try {
                val stream = applicationContext.assets.open(assetPath)
                return WebResourceResponse(mime(assetPath), null, stream).apply {
                    responseHeaders = mapOf(
                        "Cross-Origin-Resource-Policy" to "cross-origin",
                        "Cross-Origin-Opener-Policy" to "same-origin",
                        "Cross-Origin-Embedder-Policy" to "require-corp",
                    )
                }
            } catch (_: Exception) { /* next candidate */ }
        }
        return WebResourceResponse("text/plain", "utf-8", "not found".byteInputStream())
    }

    /** Serves a downloaded file with Range support so <video> can seek. */
    private fun serveLocalFile(uri: Uri, rangeHeader: String?): WebResourceResponse {
        val path = Uri.decode(uri.path ?: "")
        val file = File(path)
        if (!file.isFile) return WebResourceResponse("text/plain", "utf-8", "not found".byteInputStream())
        val len = file.length()
        val start: Long
        val partial: Boolean
        if (rangeHeader != null && rangeHeader.startsWith("bytes=") && len > 0) {
            val spec = rangeHeader.removePrefix("bytes=").substringBefore("-")
            val suffix = rangeHeader.removePrefix("bytes=").substringAfter("-", "")
            start = when {
                spec.isEmpty() -> (len - (suffix.toLongOrNull() ?: 0)).coerceAtLeast(0)
                else -> (spec.toLongOrNull() ?: 0).coerceIn(0, len - 1)
            }
            partial = true
        } else {
            start = 0
            partial = false
        }
        val stream = FileInputStream(file).apply { skip(start) }
        return WebResourceResponse(mime(path), null, stream).apply {
            if (partial) {
                setStatusCodeAndReasonPhrase(206, "Partial Content")
                responseHeaders = mapOf(
                    "Content-Range" to "bytes $start-${len - 1}/$len",
                    "Accept-Ranges" to "bytes",
                    "Cross-Origin-Resource-Policy" to "cross-origin",
                )
            } else {
                responseHeaders = mapOf(
                    "Accept-Ranges" to "bytes",
                    "Cross-Origin-Resource-Policy" to "cross-origin",
                )
            }
        }
    }

    private fun mime(path: String): String {
        return when (path.substringAfterLast('.', "").lowercase()) {
            "html" -> "text/html"
            "js", "mjs" -> "text/javascript"
            "css" -> "text/css"
            "svg" -> "image/svg+xml"
            "png" -> "image/png"
            "jpg", "jpeg" -> "image/jpeg"
            "webp" -> "image/webp"
            "avif" -> "image/avif"
            "gif" -> "image/gif"
            "woff2" -> "font/woff2"
            "woff" -> "font/woff"
            "ttf" -> "font/ttf"
            "wasm" -> "application/wasm"
            "json", "map" -> "application/json"
            "ico" -> "image/x-icon"
            "mp4", "m4v" -> "video/mp4"
            "mkv" -> "video/x-matroska"
            "webm" -> "video/webm"
            "mov" -> "video/quicktime"
            "ts", "m2ts" -> "video/mp2t"
            "mp3" -> "audio/mpeg"
            "flac" -> "audio/flac"
            "ogg", "opus" -> "audio/ogg"
            "ass", "ssa", "srt", "vtt", "txt" -> "text/plain; charset=utf-8"
            else -> "application/octet-stream"
        }
    }

    private fun load(url: String) {
        setupView?.let { root.removeView(it) }
        setupView = null
        webView.visibility = View.VISIBLE
        webView.loadUrl(url)
    }

    private fun showSetup() {
        webView.visibility = View.GONE
        val card = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(48, 48, 48, 48)
            setBackgroundColor(0xFF0D0F13.toInt())
        }
        card.addView(TextView(this).apply {
            text = "Connect to your server"
            setTextColor(0xFFFFFFFF.toInt())
            textSize = 24f
            typeface = android.graphics.Typeface.DEFAULT_BOLD
        })
        card.addView(TextView(this).apply {
            text = "Enter the URL of your hokago instance — e.g. http://192.168.1.20:3000"
            setTextColor(0xFF9AA3B2.toInt())
            textSize = 14f
            setPadding(0, 12, 0, 24)
        })
        val field = EditText(this).apply {
            hint = "https://hokago.example.com"
            inputType = android.text.InputType.TYPE_TEXT_VARIATION_URI
            setTextColor(0xFFFFFFFF.toInt())
            setHintTextColor(0xFF6B7480.toInt())
            background = android.graphics.drawable.ColorDrawable(0xFF15181F.toInt())
            setPadding(24, 16, 24, 16)
        }
        card.addView(field, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        val error = TextView(this).apply {
            setTextColor(0xFFFF6B6B.toInt())
            textSize = 13f
            setPadding(0, 12, 0, 0)
        }
        card.addView(error)
        card.addView(Button(this).apply {
            text = "Connect"
            setTextColor(0xFFFFFFFF.toInt())
            setOnClickListener {
                var url = field.text.toString().trim()
                if (url.isEmpty()) { error.text = "Enter a server URL."; return@setOnClickListener }
                if (!url.startsWith("http://") && !url.startsWith("https://")) url = "http://$url"
                prefs().edit().putString("serverURL", url).apply()
                load(url)
            }
        }, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
            topMargin = 24
        })

        // Scrollable so the keyboard (adjustResize) can't cover the field;
        // the column centers vertically when there's room, scrolls otherwise.
        val layout = FrameLayout(this).apply {
            addView(ScrollView(this@MainActivity).apply {
                isFillViewport = true
                addView(LinearLayout(this@MainActivity).apply {
                    orientation = LinearLayout.VERTICAL
                    gravity = Gravity.CENTER
                    addView(card, LinearLayout.LayoutParams(
                        ViewGroup.LayoutParams.MATCH_PARENT,
                        ViewGroup.LayoutParams.WRAP_CONTENT,
                    ))
                }, ScrollView.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
            }, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        }
        root.addView(layout, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        setupView = layout
    }

    override fun onKeyDown(keyCode: Int, event: KeyEvent?): Boolean {
        if (keyCode == KeyEvent.KEYCODE_BACK) {
            if (webView.canGoBack()) {
                webView.goBack()
                return true
            }
            // root of the SPA — let the app's router handle "back" first
            webView.evaluateJavascript(
                "window.dispatchEvent(new CustomEvent('hokago-native', { detail: { type: 'back' } }));"
            ) { }
            return true
        }
        return super.onKeyDown(keyCode, event)
    }

    override fun onDestroy() {
        webView.destroy()
        super.onDestroy()
    }

    private fun prefs() = getSharedPreferences("hokago_config", 0)

    companion object {
        /** Fake origin the bundled SPA is served from (offline mode). */
        const val OFFLINE_HOST = "hokago-app.local"
        val isTvForm: Boolean by lazy {
            // BuildConfig.FLAVOR == "tv"
            BuildConfig.FLAVOR == "tv"
        }
    }
}