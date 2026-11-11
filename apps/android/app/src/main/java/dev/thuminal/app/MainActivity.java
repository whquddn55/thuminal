package dev.thuminal.app;

import android.Manifest;
import android.app.Activity;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Insets;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowInsets;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;

import org.json.JSONObject;

import com.google.firebase.FirebaseApp;
import com.google.firebase.messaging.FirebaseMessaging;
import com.google.mlkit.vision.barcode.common.Barcode;
import com.google.mlkit.vision.codescanner.GmsBarcodeScanner;
import com.google.mlkit.vision.codescanner.GmsBarcodeScannerOptions;
import com.google.mlkit.vision.codescanner.GmsBarcodeScanning;

/**
 * thuminal 안드로이드 앱. 데스크톱 데몬이 내는 웹 화면(원격 접속)을 WebView 로 띄우는 얇은 껍데기다.
 *
 * 컴퓨터 여러 대를 목록으로 기억한다 ({@link Hosts}). 첫 화면(assets/home.html)은 컴퓨터마다 카드와, 모든 컴퓨터의 세션을
 * 상태별로 모아 보인다. 컴퓨터가 하나면 바로 그 웹 화면으로 들어간다. 화면·터미널·키 줄은 모두 웹 화면이 그리고,
 * 앱은 뒤로 가기·클립보드·목록·알림만 이어 준다 (window.ThuminalApp, 첫 화면은 window.ThuminalHome).
 * 알림은 데몬이 FCM 으로 보내고 {@link PushService} 가 그린다.
 */
public class MainActivity extends Activity {
    private static final String HOME = "file:///android_asset/home.html";
    private static final int REQ_NOTIFY = 1;

    private WebView web;
    /** 지금 웹 화면으로 연 컴퓨터 주소. 첫 화면이면 null */
    private String current;
    /** FCM 등록 토큰 (Firebase 설정 없이 빌드했으면 null) */
    private volatile String fcm;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        Hosts.migrate(this);
        startPush();
        if (handle(getIntent())) return;
        if (Hosts.list(this).size() == 1) showWeb(Hosts.list(this).get(0).url, 0);
        else showHome(null, null);
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        handle(intent);
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (web != null) {
            web.onResume();
            if (current == null) web.evaluateJavascript("window.thuminalRefresh && thuminalRefresh()", null);
        }
    }

    @Override
    protected void onPause() {
        if (web != null && current == null) web.onPause();
        super.onPause();
    }

    /** 알림을 눌렀거나 thuminal://open?url=… 로 열었다. 다룬 인텐트면 true */
    private boolean handle(Intent intent) {
        if (intent == null) return false;
        if (PushService.ACTION_OPEN.equals(intent.getAction())) {
            Hosts.Host h = Hosts.find(this, intent.getStringExtra(PushService.EXTRA_HOST));
            if (h == null) return false;
            long session = intent.getLongExtra(PushService.EXTRA_SESSION, 0);
            // 같은 컴퓨터 화면이 열려 있으면 다시 읽지 않고 그 세션으로만 간다
            if (web != null && current != null && Hosts.originOf(current).equals(Hosts.originOf(h.url))) {
                web.evaluateJavascript("window.thuminalOpen && thuminalOpen(" + session + ")", null);
            } else {
                showWeb(h.url, session);
            }
            return true;
        }
        Uri data = intent.getData();
        if (data != null && "thuminal".equals(data.getScheme())) {
            String url = Hosts.normalize(data.getQueryParameter("url"));
            if (url != null) {
                showHome(url, null);
                return true;
            }
        }
        return false;
    }

    // ---- 알림 ----

    private void startPush() {
        PushService.channels(this);
        // google-services.json 없이 빌드했으면 Firebase 가 없다. 알림만 빠지고 나머지는 그대로 쓴다
        if (FirebaseApp.getApps(this).isEmpty()) return;
        FirebaseMessaging.getInstance().getToken().addOnSuccessListener(t -> {
            fcm = t;
            new Thread(() -> Hosts.registerAll(this, t, false)).start();
        });
    }

    private boolean notifyAllowed() {
        return Build.VERSION.SDK_INT < 33 || checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED;
    }

    @Override
    public void onRequestPermissionsResult(int code, String[] permissions, int[] results) {
        super.onRequestPermissionsResult(code, permissions, results);
        if (code == REQ_NOTIFY && web != null && current == null) web.evaluateJavascript("window.thuminalRefresh && thuminalRefresh()", null);
    }

    // ---- 화면 ----

    private void closeWeb() {
        if (web != null) {
            web.destroy();
            web = null;
        }
        current = null;
    }

    private WebView newWeb() {
        closeWeb();
        WebView w = new WebView(this);
        w.setBackgroundColor(getColor(R.color.bg));
        WebSettings s = w.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setSupportZoom(false);
        s.setTextZoom(100);
        s.setMediaPlaybackRequiresUserGesture(false);
        w.setWebChromeClient(new WebChromeClient());
        web = w;
        return w;
    }

    /** 첫 화면: 컴퓨터 카드 + 모든 컴퓨터의 세션. add 가 있으면 그 주소를 넣는 창을 띄우고, error 가 있으면 위에 보인다 */
    private void showHome(String add, String error) {
        WebView w = newWeb();
        w.getSettings().setAllowFileAccess(true);
        w.addJavascriptInterface(new Home(), "ThuminalHome");
        w.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
                return true;
            }
        });
        setContentView(fitInsets(w));
        StringBuilder hash = new StringBuilder();
        if (add != null) hash.append("add=").append(Uri.encode(add));
        if (error != null) hash.append(hash.length() > 0 ? "&" : "").append("error=").append(Uri.encode(error));
        w.loadUrl(hash.length() > 0 ? HOME + "#" + hash : HOME);
    }

    /** 컴퓨터 웹 화면. 주소의 #token= 은 웹 화면이 받아 이 WebView 저장소(컴퓨터 주소마다 따로)에 남긴다 */
    private void showWeb(String url, long session) {
        WebView w = newWeb();
        current = url;
        w.addJavascriptInterface(new Bridge(), "ThuminalApp");
        String origin = Hosts.originOf(url);
        w.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
                Uri u = req.getUrl();
                // 데스크톱 주소 밖(문서 링크 등)은 폰 브라우저로 연다
                if (origin != null && !origin.equals(Hosts.originOf(u.toString()))) {
                    startActivity(new Intent(Intent.ACTION_VIEW, u));
                    return true;
                }
                return false;
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest req, WebResourceError error) {
                if (req.isForMainFrame()) showHome(null, "컴퓨터에 연결하지 못했어요 (" + error.getDescription() + "). Tailscale이 켜져 있는지, 그 컴퓨터에서 원격 접속이 켜져 있는지 확인해 주세요.");
            }
        });
        setContentView(fitInsets(w));
        w.loadUrl(Hosts.openUrl(url, session));
    }

    /**
     * 안드로이드 15 는 앱을 상태 표시줄·내비게이션 줄 밑까지 그린다 (edge-to-edge). 그 자리와 키보드 자리만큼 안쪽 여백을 준다.
     * 키보드가 뜨면 웹 화면이 그만큼 줄어 터미널 줄 수가 맞춰진다
     */
    private View fitInsets(View content) {
        FrameLayout frame = new FrameLayout(this);
        frame.setBackgroundColor(getColor(R.color.bg));
        frame.addView(content, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        frame.setOnApplyWindowInsetsListener((v, insets) -> {
            Insets bars = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.ime() | WindowInsets.Type.displayCutout());
            v.setPadding(bars.left, bars.top, bars.right, bars.bottom);
            return WindowInsets.CONSUMED;
        });
        return frame;
    }

    private void scan() {
        GmsBarcodeScannerOptions options = new GmsBarcodeScannerOptions.Builder().setBarcodeFormats(Barcode.FORMAT_QR_CODE).build();
        GmsBarcodeScanner scanner = GmsBarcodeScanning.getClient(this, options);
        scanner.startScan()
                .addOnSuccessListener(code -> {
                    String url = Hosts.normalize(code.getRawValue());
                    homeCall("onScan", url, url == null ? "thuminal 접속 주소가 든 QR이 아니에요: " + code.getRawValue() : null);
                })
                .addOnFailureListener(e -> homeCall("onScan", null, "QR을 찍지 못했어요: " + e.getMessage()));
    }

    /** 첫 화면의 함수를 글 인자들로 부른다 (null 은 null 로) */
    private void homeCall(String fn, String... args) {
        if (web == null || current != null) return;
        StringBuilder js = new StringBuilder("window.").append(fn).append(" && ").append(fn).append("(");
        for (int i = 0; i < args.length; i++) {
            if (i > 0) js.append(",");
            js.append(args[i] == null ? "null" : JSONObject.quote(args[i]));
        }
        web.evaluateJavascript(js.append(")").toString(), null);
    }

    @Override
    public void onBackPressed() {
        if (web == null) {
            moveTaskToBack(true);
        } else if (current == null) {
            // 첫 화면: 떠 있는 창이 있으면 닫고, 없으면 앱을 뒤로
            web.evaluateJavascript("window.thuminalBack ? thuminalBack() : false", r -> {
                if (!"true".equals(r)) moveTaskToBack(true);
            });
        } else if (web.canGoBack()) {
            web.goBack();
        } else if (Hosts.list(this).size() > 1) {
            showHome(null, null);
        } else {
            moveTaskToBack(true);
        }
    }

    @Override
    protected void onDestroy() {
        if (web != null) web.destroy();
        super.onDestroy();
    }

    /** 첫 화면이 부르는 앱 기능 (window.ThuminalHome) */
    private class Home {
        @JavascriptInterface
        public String hosts() {
            return Hosts.json(MainActivity.this).toString();
        }

        /** 컴퓨터 요약을 받아 `onSummary(origin, code, body)` 로 돌려준다. 받으면 알림 토큰도 맡긴다 */
        @JavascriptInterface
        public void summary(String url) {
            new Thread(() -> {
                Hosts.Reply r = Hosts.summary(url);
                if (r.code == 200 && fcm != null) Hosts.registerPush(MainActivity.this, url, fcm, false);
                runOnUiThread(() -> homeCall("onSummary", Hosts.originOf(url), String.valueOf(r.code), r.body));
            }).start();
        }

        @JavascriptInterface
        public void open(String url, String session) {
            long id;
            try {
                id = Long.parseLong(session);
            } catch (NumberFormatException e) {
                id = 0;
            }
            long s = id;
            runOnUiThread(() -> showWeb(url, s));
        }

        @JavascriptInterface
        public void save(String name, String url) {
            String u = Hosts.normalize(url);
            if (u == null) return;
            Hosts.put(MainActivity.this, name == null || name.trim().isEmpty() ? Hosts.defaultName(u) : name.trim(), u);
            String t = fcm;
            if (t != null) new Thread(() -> Hosts.registerPush(MainActivity.this, u, t, true)).start();
        }

        @JavascriptInterface
        public void remove(String url) {
            Hosts.remove(MainActivity.this, url);
        }

        @JavascriptInterface
        public String defaultName(String url) {
            return Hosts.defaultName(url);
        }

        @JavascriptInterface
        public void scan() {
            runOnUiThread(MainActivity.this::scan);
        }

        /** "on" 알림 허용 · "off" 막힘 · "none" 이 빌드에 알림이 없다 */
        @JavascriptInterface
        public String notifyState() {
            if (FirebaseApp.getApps(MainActivity.this).isEmpty()) return "none";
            return notifyAllowed() ? "on" : "off";
        }

        @JavascriptInterface
        public void allowNotify() {
            runOnUiThread(() -> {
                if (Build.VERSION.SDK_INT >= 33 && !shouldShowRequestPermissionRationale(Manifest.permission.POST_NOTIFICATIONS)
                        && Hosts.prefs(MainActivity.this).getBoolean("asked_notify", false)) {
                    // 두 번 거절하면 권한 창이 더는 뜨지 않는다. 앱 알림 설정을 연다
                    startActivity(new Intent(android.provider.Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(android.provider.Settings.EXTRA_APP_PACKAGE, getPackageName()));
                    return;
                }
                Hosts.prefs(MainActivity.this).edit().putBoolean("asked_notify", true).apply();
                if (Build.VERSION.SDK_INT >= 33) requestPermissions(new String[] {Manifest.permission.POST_NOTIFICATIONS}, REQ_NOTIFY);
            });
        }
    }

    /** 웹 화면이 부르는 앱 기능 (window.ThuminalApp) */
    private class Bridge {
        /** 클립보드 글. WebView 의 navigator.clipboard 는 권한 창 없이 막힌다 */
        @JavascriptInterface
        public String clipboardText() {
            ClipboardManager cm = (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
            if (cm == null || !cm.hasPrimaryClip()) return "";
            ClipData clip = cm.getPrimaryClip();
            if (clip == null || clip.getItemCount() == 0) return "";
            CharSequence t = clip.getItemAt(0).coerceToText(MainActivity.this);
            return t == null ? "" : t.toString();
        }

        @JavascriptInterface
        public void copyText(String text) {
            ClipboardManager cm = (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
            if (cm != null) cm.setPrimaryClip(ClipData.newPlainText("thuminal", text));
        }

        /** 지금 컴퓨터를 목록에서 지우고 첫 화면으로 (웹 화면이 이미 물어봤다) */
        @JavascriptInterface
        public void forget() {
            runOnUiThread(() -> {
                String url = current;
                if (url != null) Hosts.remove(MainActivity.this, url);
                if (web != null) web.clearCache(false);
                showHome(null, null);
            });
        }

        /** 첫 화면으로 (다른 컴퓨터를 고르거나 더한다) */
        @JavascriptInterface
        public void changeServer() {
            runOnUiThread(() -> showHome(null, null));
        }
    }
}
