package kr.ac.roi.viewer

import android.Manifest
import android.app.Activity
import android.app.AlertDialog
import android.content.Intent
import android.content.pm.PackageManager
import android.content.res.Configuration
import android.graphics.Color
import android.net.Uri
import android.net.http.SslError
import android.os.Build
import android.os.Bundle
import android.provider.OpenableColumns
import android.provider.Settings
import android.text.InputType
import android.util.Base64
import android.util.JsonReader
import android.view.View
import android.view.WindowInsets
import android.view.WindowInsetsController
import android.view.WindowManager
import android.webkit.*
import android.widget.*
import androidx.webkit.JavaScriptReplyProxy
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import org.json.JSONObject
import java.io.ByteArrayInputStream
import java.io.File
import java.io.OutputStream
import java.net.URI
import java.util.UUID
import java.util.concurrent.Executors

@Suppress("DEPRECATION")
class MainActivity : Activity() {
    private lateinit var root: FrameLayout
    private var browser: WebView? = null
    @Volatile private var selected: URI? = null
    private var resumed = false
    private var barsVisible = false
    private var imeVisible = false
    private var requiredRotation: Int? = null
    private var pageReady = false
    private var sessionActive = false
    private var wantsAwake = false
    private var lastEnvironment = ""
    private var loading: TextView? = null
    private var cameraRequest: PermissionRequest? = null
    private var requestingCamera = false
    private var fileCallback: ValueCallback<Array<Uri>>? = null
    private var fileExtension = ""
    private var exportFile: File? = null
    private var exportStream: OutputStream? = null
    private var exportName = ""
    private var exportSize = 0L
    private var exportReply: JavaScriptReplyProxy? = null
    private var exportRid = 0
    private var saving = false
    private val disk = Executors.newSingleThreadExecutor()
    private val preferences by lazy { getSharedPreferences("roi", MODE_PRIVATE) }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.setDecorFitsSystemWindows(false)
        root = FrameLayout(this)
        setContentView(root)
        root.setOnApplyWindowInsetsListener { _, insets ->
            barsVisible = insets.isVisible(WindowInsets.Type.statusBars()) || insets.isVisible(WindowInsets.Type.navigationBars())
            imeVisible = insets.isVisible(WindowInsets.Type.ime())
            val cutout = insets.getInsets(WindowInsets.Type.displayCutout())
            val keyboard = insets.getInsets(WindowInsets.Type.ime())
            root.setPadding(cutout.left, cutout.top, cutout.right, maxOf(cutout.bottom, keyboard.bottom))
            sendEnvironment()
            insets
        }
        val unfinished = preferences.getString("unfinished", null)
        showConnection(if (unfinished == null) "" else "이전 세션이 완료되지 않았을 수 있습니다. PC 저장 로그를 확인하고 새 세션으로 시작하세요.")
        immersive()
    }

    private fun immersive() {
        window.insetsController?.apply {
            systemBarsBehavior = WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
            hide(WindowInsets.Type.systemBars())
        }
    }

    private fun showConnection(message: String = "") {
        cameraRequest?.deny(); cameraRequest = null
        fileCallback?.onReceiveValue(null); fileCallback = null
        browser?.let { root.removeView(it); it.destroy() }
        browser = null; selected = null; pageReady = false; sessionActive = false; wantsAwake = false
        loading = null; lastEnvironment = ""; root.removeAllViews(); updateAwake()
        val form = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(40), dp(24), dp(40), dp(24))
            setBackgroundColor(Color.rgb(238, 243, 242))
        }
        fun label(value: String, size: Float = 16f) = TextView(this).apply {
            text = value; textSize = size; setTextColor(Color.rgb(25, 45, 50)); setPadding(0, dp(8), 0, dp(8))
            form.addView(this)
        }
        label("ROI · 상품 관찰 실험", 26f)
        label("연구용 PC에서 서버를 실행한 뒤, 출력된 연결 링크 전체를 붙여넣어 주세요.")
        val field = EditText(this).apply {
            hint = "https://PC주소:8443/#연결토큰"
            contentDescription = "PC 연결 링크"
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI
            isSingleLine = true; isSaveEnabled = false
            importantForAutofill = View.IMPORTANT_FOR_AUTOFILL_NO_EXCLUDE_DESCENDANTS
            minHeight = dp(52)
            setText(preferences.getString("origin", "")?.let { if (it.isEmpty()) "" else "$it/#" })
            form.addView(this, LinearLayout.LayoutParams(-1, -2))
        }
        val error = label(message)
        form.addView(Button(this).apply {
            text = "PC에 연결"; minHeight = dp(48)
            setOnClickListener {
                try {
                    val link = ConnectionPolicy.parseLink(field.text.toString())
                    field.text.clear() // The token is only retained in this running WebView.
                    window.insetsController?.hide(WindowInsets.Type.ime())
                    openViewer(link)
                } catch (failure: IllegalArgumentException) { error.text = failure.message }
            }
        })
        label("처음 연결할 때는 PC의 roi-ca.crt 인증서를 태블릿에 설치해야 합니다. 같은 네트워크를 사용하세요.")
        label("ROI Viewer ${BuildConfig.VERSION_NAME} · Android ${Build.VERSION.RELEASE}", 13f)
        root.addView(ScrollView(this).apply { isFillViewport = true; addView(form) }, FrameLayout.LayoutParams(-1, -1))
        immersive()
    }

    private fun openViewer(link: URI) {
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            showConnection("Android System WebView를 업데이트한 뒤 다시 연결하세요."); return
        }
        selected = link
        preferences.edit().putString("origin", ConnectionPolicy.origin(link)).apply()
        root.removeAllViews(); pageReady = false; lastEnvironment = ""
        val web = WebView(this)
        browser = web
        web.settings.apply {
            javaScriptEnabled = true; domStorageEnabled = true
            allowFileAccess = false; allowContentAccess = true
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            setSupportZoom(false); builtInZoomControls = false; displayZoomControls = false
            setSupportMultipleWindows(true); javaScriptCanOpenWindowsAutomatically = false
            mediaPlaybackRequiresUserGesture = false
            userAgentString = "$userAgentString ROIViewer/${BuildConfig.VERSION_NAME}"
        }
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)
        CookieManager.getInstance().setAcceptThirdPartyCookies(web, false)
        web.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean =
                (pageReady && request.isForMainFrame) || !ConnectionPolicy.sameOrigin(selected, request.url.toString())

            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
                val url = request.url.toString()
                if (ConnectionPolicy.sameOrigin(selected, url) || url.startsWith("blob:${ConnectionPolicy.origin(link)}/")) return null
                return WebResourceResponse("text/plain", "UTF-8", 403, "Blocked", emptyMap(), ByteArrayInputStream(ByteArray(0)))
            }

            override fun onReceivedSslError(view: WebView, handler: SslErrorHandler, error: SslError) {
                handler.cancel()
                failLoad("인증서 확인에 실패했습니다. roi-ca.crt 설치, PC 주소, 기기 시각과 인증서 유효기간을 확인하세요.")
            }

            override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
                if (request.isForMainFrame) failLoad("PC에 연결할 수 없습니다. 서버 실행, 같은 네트워크와 방화벽 설정을 확인하세요.")
            }

            override fun onReceivedHttpError(view: WebView, request: WebResourceRequest, response: WebResourceResponse) {
                if (request.isForMainFrame) failLoad("PC가 실험 화면을 제공하지 못했습니다. 서버 주소를 확인하세요.")
            }

            override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
                showConnection("뷰어가 종료되었습니다. PC에 저장된 로그를 확인하세요. 미저장 데이터가 있을 수 있습니다.")
                return true
            }
        }
        web.webChromeClient = object : WebChromeClient() {
            override fun onPermissionRequest(request: PermissionRequest) {
                if (!ConnectionPolicy.sameOrigin(selected, request.origin.toString()) ||
                    !request.resources.contains(PermissionRequest.RESOURCE_VIDEO_CAPTURE) || !resumed) { request.deny(); return }
                cameraRequest?.deny(); cameraRequest = request
                if (checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
                    if (!requestingCamera) {
                        requestingCamera = true
                        requestPermissions(arrayOf(Manifest.permission.CAMERA), CAMERA)
                    }
                } else grantCamera()
            }
            override fun onPermissionRequestCanceled(request: PermissionRequest) { if (cameraRequest === request) cameraRequest = null }
            override fun onCreateWindow(view: WebView, dialog: Boolean, gesture: Boolean, message: android.os.Message) = false
            override fun onJsConfirm(view: WebView, url: String, message: String, result: JsResult): Boolean {
                if (!ConnectionPolicy.sameOrigin(selected, url)) { result.cancel(); return true }
                AlertDialog.Builder(this@MainActivity).setMessage(message)
                    .setPositiveButton("확인") { _, _ -> result.confirm() }
                    .setNegativeButton("취소") { _, _ -> result.cancel() }
                    .setOnCancelListener { result.cancel() }.show()
                return true
            }
            override fun onShowFileChooser(view: WebView, callback: ValueCallback<Array<Uri>>, params: FileChooserParams): Boolean {
                fileCallback?.onReceiveValue(null)
                if (!ConnectionPolicy.sameOrigin(selected, view.url) || params.mode != FileChooserParams.MODE_OPEN) {
                    callback.onReceiveValue(null); return true
                }
                fileCallback = callback
                fileExtension = if (params.acceptTypes.any { it.contains("json") }) ".json" else ".ply"
                try {
                    startActivityForResult(Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
                        addCategory(Intent.CATEGORY_OPENABLE); type = "*/*"
                    }, OPEN)
                } catch (_: Exception) { fileCallback = null; callback.onReceiveValue(null); notice("파일 선택기를 열 수 없습니다.") }
                return true
            }
        }
        WebViewCompat.addWebMessageListener(web, "ROIHost", setOf(ConnectionPolicy.origin(link))) { view, message, origin, mainFrame, proxy ->
            if (view === browser && mainFrame && ConnectionPolicy.sameOrigin(selected, origin.toString())) {
                handleMessage(message.data, proxy)
            }
        }
        root.addView(web, FrameLayout.LayoutParams(-1, -1))
        loading = TextView(this).apply {
            text = "실험 화면을 불러오고 있습니다…"; textSize = 18f; setPadding(dp(24), dp(24), dp(24), dp(24))
            setBackgroundColor(Color.rgb(238, 243, 242)); root.addView(this, FrameLayout.LayoutParams(-1, -2))
        }
        web.loadUrl(link.toASCIIString())
        web.postDelayed({ if (browser === web && !pageReady) failLoad("실험 화면 준비가 지연되고 있습니다. PC 서버와 WebView 버전을 확인하세요.") }, 30000)
        immersive()
    }

    private fun handleMessage(text: String?, proxy: JavaScriptReplyProxy) {
        var rid = 0
        try {
            require(text != null && text.length <= 100000)
            val data = JSONObject(text)
            rid = data.getInt("rid"); require(rid > 0)
            when (data.getString("type")) {
                "hello" -> {
                    pageReady = true; loading?.let { root.removeView(it) }; loading = null
                    reply(proxy, rid, environment()); sendEnvironment(true)
                }
                "state" -> {
                    sessionActive = data.getBoolean("active"); wantsAwake = data.getBoolean("awake")
                    val sid = data.optString("session")
                    val edit = preferences.edit()
                    if (data.getBoolean("unfinished") && sid.isNotEmpty()) edit.putString("unfinished", UUID.fromString(sid).toString())
                    else edit.remove("unfinished")
                    edit.apply(); updateAwake(); reply(proxy, rid)
                }
                "leave" -> { requestLeave(); reply(proxy, rid) }
                "exportBegin" -> {
                    require(exportFile == null && !saving)
                    val sid = UUID.fromString(data.getString("session")).toString()
                    exportName = "ROI-$sid.json"; exportSize = 0
                    exportFile = File.createTempFile("roi-export-", ".json", cacheDir)
                    exportStream = exportFile!!.outputStream().buffered()
                    reply(proxy, rid)
                }
                "exportChunk" -> {
                    require(exportStream != null && !saving)
                    val chunk = Base64.decode(data.getString("data"), Base64.NO_WRAP)
                    require(chunk.size <= 65536 && exportSize + chunk.size <= MAX_JSON)
                    exportStream!!.write(chunk); exportSize += chunk.size; reply(proxy, rid)
                }
                "exportEnd" -> {
                    require(exportStream != null && !saving)
                    exportStream!!.close(); exportStream = null
                    val file = exportFile!!
                    exportReply = proxy; exportRid = rid; saving = true
                    disk.execute {
                        try {
                            validateExport(file)
                            runOnUiThread {
                                if (isDestroyed) { cleanupExport(); return@runOnUiThread }
                                try {
                                    startActivityForResult(Intent(Intent.ACTION_CREATE_DOCUMENT).apply {
                                        addCategory(Intent.CATEGORY_OPENABLE); type = "application/json"
                                        putExtra(Intent.EXTRA_TITLE, exportName)
                                    }, SAVE)
                                } catch (_: Exception) { finishExport("저장 화면을 열 수 없습니다.") }
                            }
                        } catch (_: Exception) { runOnUiThread { finishExport("세션 JSON 형식 또는 크기를 확인하세요.") } }
                    }
                }
                "exportAbort" -> { require(!saving); cleanupExport(); reply(proxy, rid) }
                else -> throw IllegalArgumentException()
            }
        } catch (_: Exception) {
            if (!saving) cleanupExport()
            reply(proxy, rid, error = "앱 요청 형식·크기 또는 저장 상태를 확인하세요.")
        }
    }

    private fun validateExport(file: File) {
        require(file.length() in 1..MAX_JSON)
        var version = false; var session = false; var events = false
        JsonReader(file.reader(Charsets.UTF_8)).use { reader ->
            reader.beginObject()
            while (reader.hasNext()) when (reader.nextName()) {
                "schema_version" -> { require(reader.nextInt() == 1); version = true }
                "session_id" -> { require("ROI-${UUID.fromString(reader.nextString())}.json" == exportName); session = true }
                "events" -> {
                    reader.beginArray(); var count = 0
                    while (reader.hasNext()) { require(++count <= 250000); reader.skipValue() }
                    reader.endArray(); events = true
                }
                else -> reader.skipValue()
            }
            reader.endObject(); require(reader.peek() == android.util.JsonToken.END_DOCUMENT)
        }
        require(version && session && events)
    }

    private fun reply(proxy: JavaScriptReplyProxy, rid: Int, result: JSONObject = JSONObject(), error: String? = null) {
        try { proxy.postMessage(JSONObject().put("rid", rid).put("ok", error == null)
            .put("result", result).put("error", error).toString()) } catch (_: Exception) { /* Page may have closed. */ }
    }

    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode == OPEN) {
            val callback = fileCallback; fileCallback = null
            var accepted: Uri? = null
            try {
                if (resultCode == RESULT_OK) {
                    val uri = data?.data ?: error("Missing URI")
                    require(uri.scheme == "content")
                    contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)?.use { row ->
                        require(row.moveToFirst() && row.getString(0).lowercase().endsWith(fileExtension))
                        if (!row.isNull(1)) require(row.getLong(1) in 1..(if (fileExtension == ".json") MAX_JSON else 300L * 1024 * 1024))
                    } ?: error("Missing file metadata")
                    contentResolver.openInputStream(uri)?.use { require(it.read() >= 0) } ?: error("Unreadable file")
                    accepted = uri
                }
            } catch (_: Exception) { notice("선택한 파일의 형식·크기·읽기 권한을 확인하세요.") }
            callback?.onReceiveValue(accepted?.let { arrayOf(it) })
        } else if (requestCode == SAVE) {
            val uri = data?.data; val file = exportFile
            if (resultCode != RESULT_OK || uri == null || file == null) finishExport("파일 저장을 취소했습니다.")
            else disk.execute {
                val error = try {
                    require(uri.scheme == "content")
                    contentResolver.openOutputStream(uri, "wt")?.use { output -> file.inputStream().use { it.copyTo(output) } }
                        ?: error("Cannot open output")
                    null
                } catch (_: Exception) { "파일 저장에 실패했습니다. 저장 위치를 확인하고 다시 시도하세요." }
                runOnUiThread { finishExport(error) }
            }
        }
        immersive()
    }

    private fun finishExport(error: String?) {
        exportReply?.let { reply(it, exportRid, error = error) }
        notice(error ?: "JSON 파일을 저장했습니다.")
        cleanupExport()
    }
    private fun cleanupExport() {
        try { exportStream?.close() } catch (_: Exception) { }
        exportStream = null; exportFile?.delete(); exportFile = null
        exportReply = null; saving = false; exportSize = 0
    }

    override fun onRequestPermissionsResult(code: Int, permissions: Array<out String>, results: IntArray) {
        super.onRequestPermissionsResult(code, permissions, results)
        if (code == CAMERA) {
            requestingCamera = false
            if (checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) grantCamera()
            else {
                cameraRequest?.deny(); cameraRequest = null
                AlertDialog.Builder(this).setMessage("카메라 권한이 없어 시선을 측정할 수 없습니다. 앱 설정에서 권한을 허용한 뒤 카메라를 다시 준비하세요.")
                    .setPositiveButton("앱 권한 설정") { _, _ -> startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:$packageName"))) }
                    .setNegativeButton("닫기", null).show()
            }
        }
    }
    private fun grantCamera() {
        val request = cameraRequest ?: return
        if (!resumed) return
        cameraRequest = null
        if (ConnectionPolicy.sameOrigin(selected, request.origin.toString()) && checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED)
            request.grant(arrayOf(PermissionRequest.RESOURCE_VIDEO_CAPTURE))
        else request.deny()
    }

    private fun environment(): JSONObject {
        val rotation = display?.rotation ?: 0
        val landscape = resources.configuration.orientation == Configuration.ORIENTATION_LANDSCAPE
        if (requiredRotation == null && landscape && resumed) requiredRotation = rotation
        val available = resumed && window.decorView.hasWindowFocus() && !barsVisible && !imeVisible &&
            landscape && !isInMultiWindowMode && rotation == requiredRotation
        val provider = WebView.getCurrentWebViewPackage()
        val oneUI = try { Build.VERSION::class.java.getField("SEM_PLATFORM_INT").getInt(null).toString() } catch (_: Exception) { JSONObject.NULL }
        return JSONObject().put("available", available).put("foreground", resumed)
            .put("reason", if (!landscape || isInMultiWindowMode || rotation != requiredRotation) "가로 전체 화면과 기존 기기 방향으로 돌아온 뒤 다시 보정하세요." else "앱 이탈 또는 시스템 화면 표시로 측정을 중지했습니다.")
            .put("app_version", BuildConfig.VERSION_NAME).put("app_version_code", BuildConfig.VERSION_CODE)
            .put("android_version", Build.VERSION.RELEASE).put("android_api", Build.VERSION.SDK_INT)
            .put("one_ui_platform", oneUI).put("device", "${Build.MANUFACTURER} ${Build.MODEL}")
            .put("webview_package", provider?.packageName).put("webview_version", provider?.versionName)
            .put("display_rotation", rotation).put("system_bars", barsVisible).put("keyboard", imeVisible)
            .put("landscape", landscape).put("multi_window", isInMultiWindowMode)
    }
    private fun sendEnvironment(force: Boolean = false) {
        if (!pageReady) return
        val data = environment().toString()
        if (force || data != lastEnvironment) {
            lastEnvironment = data
            browser?.evaluateJavascript("window.roiNativeEvent?.($data)", null)
        }
    }
    private fun updateAwake() {
        if (resumed && wantsAwake) window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        else window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
    }
    override fun onResume() { super.onResume(); resumed = true; browser?.onResume(); immersive(); grantCamera(); updateAwake(); sendEnvironment() }
    override fun onPause() { resumed = false; sendEnvironment(true); browser?.onPause(); updateAwake(); super.onPause() }
    override fun onWindowFocusChanged(focus: Boolean) { super.onWindowFocusChanged(focus); if (focus) immersive(); sendEnvironment() }
    override fun onConfigurationChanged(configuration: Configuration) { super.onConfigurationChanged(configuration); sendEnvironment(true) }
    override fun onBackPressed() {
        if (imeVisible) { window.insetsController?.hide(WindowInsets.Type.ime()); return }
        if (browser == null) super.onBackPressed() else requestLeave()
    }
    private fun requestLeave() {
        if (saving || exportFile != null) { notice("파일 저장을 완료하거나 취소한 뒤 이동하세요."); return }
        val web = browser ?: return
        if (!pageReady) { showConnection(); return }
        web.evaluateJavascript("window.roiCanLeave?.() === true") { safe ->
            if (web !== browser) return@evaluateJavascript
            if (safe == "true") showConnection()
            else {
                web.evaluateJavascript("window.roiSuspend?.('연결 화면으로 이동하기 전에 세션을 종료하고 저장하세요.')", null)
                AlertDialog.Builder(this).setMessage("진행 중이거나 미저장 데이터가 있는 세션입니다. 실험 화면에서 종료하고 PC 저장을 확인하거나 JSON을 내보내세요.")
                    .setPositiveButton("실험 화면으로", null)
                    .setNeutralButton("JSON 저장") { _, _ -> web.evaluateJavascript("window.roiExport?.()", null) }.show()
            }
        }
    }
    private fun failLoad(message: String) {
        if (sessionActive) { notice(message); return }
        loading?.text = "$message\n뒤로가기를 눌러 연결 링크를 수정할 수 있습니다."
    }
    private fun notice(message: String) { Toast.makeText(this, message, Toast.LENGTH_LONG).show() }
    private fun dp(value: Int) = (value * resources.displayMetrics.density).toInt()
    override fun onDestroy() {
        cameraRequest?.deny(); fileCallback?.onReceiveValue(null)
        browser?.destroy(); browser = null
        if (!saving) cleanupExport()
        disk.shutdown(); super.onDestroy()
    }
    companion object { private const val CAMERA = 10; private const val OPEN = 11; private const val SAVE = 12; private const val MAX_JSON = 100L * 1024 * 1024 }
}
