package com.hokago.app

import android.annotation.SuppressLint
import android.net.Uri
import android.os.Bundle
import android.view.KeyEvent
import android.view.View
import android.view.ViewGroup
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
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import java.io.File
import java.io.FileInputStream

class MainActivity : AppCompatActivity() {

    private lateinit var root: FrameLayout
    private lateinit var webView: WebView
    private var bridge: NativeBridge? = null
    private var setupView: View? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        root = FrameLayout(this)
        setContentView(root)

        webView = WebView(this)
        root.addView(webView, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))

        configureWebView()

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
        if (BuildConfig.DEBUG) WebView.setWebContentsDebuggingEnabled(true)

        webView.webChromeClient = WebChromeClient()
        webView.webViewClient = object : WebViewClient() {
            private var offlineFallbackShown = false

            override fun onPageStarted(view: WebView, url: String?, favicon: android.graphics.Bitmap?) {
                super.onPageStarted(view, url, favicon)
                bridge?.let { view.evaluateJavascript(it.injectedScript) {} }
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
                val url = request.url.toString()
                if (url.startsWith("hokago-file://")) {
                    val path = Uri.decode(request.url.path ?: "")
                    val file = File(path)
                    if (file.exists()) {
                        return WebResourceResponse("video/mp4", null, FileInputStream(file))
                    }
                    return WebResourceResponse("text/plain", "utf-8", "not found".byteInputStream())
                }
                return super.shouldInterceptRequest(view, request)
            }
        }
        bridge = NativeBridge(webView)
        webView.addJavascriptInterface(bridge, "androidBridge")
    }

    /** Offline fallback: load the bundled SPA from assets when the server is down. */
    private fun loadBundledSpa() {
        webView.loadUrl("file:///android_asset/web-dist/index.html")
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

        val layout = FrameLayout(this).apply { addView(card) }
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
        val isTvForm: Boolean by lazy {
            // BuildConfig.FLAVOR == "tv"
            BuildConfig.FLAVOR == "tv"
        }
    }
}