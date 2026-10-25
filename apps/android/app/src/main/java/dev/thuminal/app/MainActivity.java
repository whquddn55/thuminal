package dev.thuminal.app;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.os.Bundle;
import android.text.InputType;
import android.util.TypedValue;
import android.graphics.Insets;
import android.view.Gravity;
import android.view.View;
import android.view.WindowInsets;
import android.view.ViewGroup;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;

import com.google.mlkit.vision.barcode.common.Barcode;
import com.google.mlkit.vision.codescanner.GmsBarcodeScanner;
import com.google.mlkit.vision.codescanner.GmsBarcodeScannerOptions;
import com.google.mlkit.vision.codescanner.GmsBarcodeScanning;

/**
 * thuminal 안드로이드 앱. 데스크톱 데몬이 내는 웹 화면(원격 접속)을 WebView 로 띄우는 얇은 껍데기다.
 *
 * 처음에는 데스크톱 설정 → 원격 접속 → [기기 등록] 의 QR 을 찍거나 주소를 붙여 넣는다. 주소(토큰이 든)는 앱에 남는다.
 * 화면·터미널·키 줄은 모두 웹 화면이 그리고, 앱은 뒤로 가기·클립보드·접속 정보 지우기만 이어 준다 (window.ThuminalApp).
 */
public class MainActivity extends Activity {
    private static final String PREFS = "thuminal";
    private static final String KEY_URL = "url";

    private WebView web;
    private SharedPreferences prefs;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
        String fromIntent = urlFromIntent(getIntent());
        if (fromIntent != null) save(fromIntent);
        String url = prefs.getString(KEY_URL, null);
        if (url == null) showSetup(null);
        else showWeb(url);
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        String url = urlFromIntent(intent);
        if (url != null) {
            save(url);
            showWeb(url);
        }
    }

    /** thuminal://open?url=… 로 열었으면 그 주소 */
    private static String urlFromIntent(Intent intent) {
        Uri data = intent == null ? null : intent.getData();
        if (data == null || !"thuminal".equals(data.getScheme())) return null;
        return normalize(data.getQueryParameter("url"));
    }

    /** http(s) 주소만 받는다. 끝의 공백·줄바꿈은 지운다 */
    private static String normalize(String text) {
        if (text == null) return null;
        String t = text.trim();
        if (t.startsWith("http://") || t.startsWith("https://")) return t;
        return null;
    }

    private void save(String url) {
        prefs.edit().putString(KEY_URL, url).apply();
    }

    private int dp(int v) {
        return (int) TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v, getResources().getDisplayMetrics());
    }

    private Button button(String label, boolean primary) {
        Button b = new Button(this);
        b.setText(label);
        b.setAllCaps(false);
        b.setTextSize(15);
        b.setTextColor(primary ? Color.parseColor("#16161E") : getColor(R.color.fg));
        GradientDrawable bg = new GradientDrawable();
        bg.setCornerRadius(dp(10));
        if (primary) bg.setColor(getColor(R.color.accent));
        else bg.setStroke(dp(1), getColor(R.color.muted));
        b.setBackground(bg);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(48));
        lp.topMargin = dp(12);
        b.setLayoutParams(lp);
        return b;
    }

    /** 처음 화면: QR 찍기 또는 주소 붙여 넣기 */
    private void showSetup(String error) {
        if (web != null) {
            web.destroy();
            web = null;
        }
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setGravity(Gravity.CENTER_VERTICAL);
        box.setPadding(dp(28), dp(28), dp(28), dp(28));
        box.setBackgroundColor(getColor(R.color.bg));

        TextView title = new TextView(this);
        title.setText("thuminal");
        title.setTextSize(26);
        title.setTextColor(getColor(R.color.fg));
        box.addView(title);

        TextView desc = new TextView(this);
        desc.setText("데스크톱 thuminal 의 설정 → 원격 접속에서 [기기 등록] 을 누르고, 나온 QR 을 찍거나 주소를 붙여 넣는다. 폰과 데스크톱이 같은 Tailscale 망에 있어야 한다.");
        desc.setTextSize(14);
        desc.setLineSpacing(0, 1.3f);
        desc.setTextColor(getColor(R.color.muted));
        desc.setPadding(0, dp(10), 0, dp(6));
        box.addView(desc);

        if (error != null) {
            TextView err = new TextView(this);
            err.setText(error);
            err.setTextSize(13);
            err.setTextColor(Color.parseColor("#F7768E"));
            err.setPadding(0, dp(6), 0, dp(6));
            box.addView(err);
        }

        Button scan = button("QR 찍기", true);
        scan.setOnClickListener(v -> scan());
        box.addView(scan);

        EditText input = new EditText(this);
        input.setHint("http://100.x.y.z:6780/#token=…");
        input.setHintTextColor(getColor(R.color.muted));
        input.setTextColor(getColor(R.color.fg));
        input.setSingleLine(true);
        input.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        String saved = prefs.getString(KEY_URL, null);
        if (saved != null) input.setText(saved);
        LinearLayout.LayoutParams ilp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        ilp.topMargin = dp(20);
        input.setLayoutParams(ilp);
        box.addView(input);

        Button go = button("붙기", false);
        go.setOnClickListener(v -> {
            String url = normalize(input.getText().toString());
            if (url == null) {
                input.setError("http:// 로 시작하는 주소를 넣는다");
                return;
            }
            save(url);
            showWeb(url);
        });
        box.addView(go);
        setContentView(fitInsets(box));
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
                    String url = normalize(code.getRawValue());
                    if (url == null) {
                        showSetup("thuminal 주소가 든 QR 이 아니다: " + code.getRawValue());
                        return;
                    }
                    save(url);
                    showWeb(url);
                })
                .addOnFailureListener(e -> showSetup("QR 을 찍지 못했다: " + e.getMessage()));
    }

    /** 웹 화면. 주소의 #token= 은 웹 화면이 받아 이 WebView 저장소에 남긴다 */
    private void showWeb(String url) {
        if (web != null) web.destroy();
        web = new WebView(this);
        web.setBackgroundColor(getColor(R.color.bg));
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setSupportZoom(false);
        s.setTextZoom(100);
        s.setMediaPlaybackRequiresUserGesture(false);
        web.addJavascriptInterface(new Bridge(), "ThuminalApp");
        web.setWebChromeClient(new WebChromeClient());
        String origin = originOf(url);
        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
                Uri u = req.getUrl();
                // 데스크톱 주소 밖(문서 링크 등)은 폰 브라우저로 연다
                if (origin != null && !origin.equals(originOf(u.toString()))) {
                    startActivity(new Intent(Intent.ACTION_VIEW, u));
                    return true;
                }
                return false;
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest req, WebResourceError error) {
                if (req.isForMainFrame()) showSetup("데스크톱에 닿지 못했다 (" + error.getDescription() + "). Tailscale 이 켜져 있는지, 데스크톱에서 원격 접속이 켜져 있는지 본다.");
            }
        });
        setContentView(fitInsets(web));
        web.loadUrl(url);
    }

    private static String originOf(String url) {
        try {
            Uri u = Uri.parse(url);
            return u.getScheme() + "://" + u.getAuthority();
        } catch (Exception e) {
            return null;
        }
    }

    @Override
    public void onBackPressed() {
        if (web != null && web.canGoBack()) web.goBack();
        else moveTaskToBack(true);
    }

    @Override
    protected void onDestroy() {
        if (web != null) web.destroy();
        super.onDestroy();
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

        /** 접속 정보를 지우고 처음 화면으로 */
        @JavascriptInterface
        public void forget() {
            runOnUiThread(() -> {
                prefs.edit().remove(KEY_URL).apply();
                if (web != null) web.clearCache(false);
                showSetup(null);
            });
        }

        /** 다른 데스크톱으로 바꾼다 (처음 화면, 지금 주소를 채워 둔다) */
        @JavascriptInterface
        public void changeServer() {
            runOnUiThread(() -> new AlertDialog.Builder(MainActivity.this)
                    .setMessage("다른 데스크톱 주소로 바꿀까?")
                    .setPositiveButton("바꾸기", (d, w) -> showSetup(null))
                    .setNegativeButton("그대로", null)
                    .show());
        }
    }
}
