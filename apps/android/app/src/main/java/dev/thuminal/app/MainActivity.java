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
import android.widget.ScrollView;
import android.widget.TextView;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;

import com.google.mlkit.vision.barcode.common.Barcode;
import com.google.mlkit.vision.codescanner.GmsBarcodeScanner;
import com.google.mlkit.vision.codescanner.GmsBarcodeScannerOptions;
import com.google.mlkit.vision.codescanner.GmsBarcodeScanning;

/**
 * thuminal 안드로이드 앱. 데스크톱 데몬이 내는 웹 화면(원격 접속)을 WebView 로 띄우는 얇은 껍데기다.
 *
 * 컴퓨터 여러 대를 목록으로 기억한다. 컴퓨터마다 데스크톱 설정 → 원격 접속의 접속 주소(QR)를 찍거나 붙여 넣어 더한다.
 * 컴퓨터가 하나면 바로 들어가고, 여럿이면 목록에서 고른다. 같은 컴퓨터(같은 주소 · 포트)를 다시 넣으면 주소만 바꾼다
 * (토큰을 바꾼 뒤). 화면·터미널·키 줄은 모두 웹 화면이 그리고, 앱은 뒤로 가기·클립보드·목록만 이어 준다 (window.ThuminalApp).
 */
public class MainActivity extends Activity {
    private static final String PREFS = "thuminal";
    /** 예전 판이 남긴 주소 하나 (처음 켤 때 목록으로 옮긴다) */
    private static final String KEY_URL = "url";
    /** 컴퓨터 목록: [{"name": …, "url": …}] */
    private static final String KEY_HOSTS = "hosts";

    private WebView web;
    private SharedPreferences prefs;
    /** 지금 웹 화면으로 연 컴퓨터 주소 */
    private String current;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
        migrate();
        String fromIntent = urlFromIntent(getIntent());
        if (fromIntent != null) {
            askName(fromIntent);
            return;
        }
        List<Host> hosts = hosts();
        if (hosts.isEmpty()) showSetup(null);
        else if (hosts.size() == 1) showWeb(hosts.get(0).url);
        else showList(null);
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        String url = urlFromIntent(intent);
        if (url != null) askName(url);
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

    // ---- 컴퓨터 목록 ----

    private static final class Host {
        final String name;
        final String url;

        Host(String name, String url) {
            this.name = name;
            this.url = url;
        }
    }

    private List<Host> hosts() {
        List<Host> out = new ArrayList<>();
        try {
            JSONArray a = new JSONArray(prefs.getString(KEY_HOSTS, "[]"));
            for (int i = 0; i < a.length(); i++) {
                JSONObject o = a.getJSONObject(i);
                out.add(new Host(o.optString("name"), o.optString("url")));
            }
        } catch (JSONException ignored) {
        }
        return out;
    }

    private void saveHosts(List<Host> hosts) {
        JSONArray a = new JSONArray();
        try {
            for (Host h : hosts) a.put(new JSONObject().put("name", h.name).put("url", h.url));
        } catch (JSONException ignored) {
        }
        prefs.edit().putString(KEY_HOSTS, a.toString()).apply();
    }

    /** 예전 판의 주소 하나를 목록으로 옮긴다 */
    private void migrate() {
        String old = prefs.getString(KEY_URL, null);
        if (old == null) return;
        List<Host> hosts = hosts();
        if (indexOf(hosts, old) < 0) hosts.add(new Host(defaultName(old), old));
        saveHosts(hosts);
        prefs.edit().remove(KEY_URL).apply();
    }

    /** 같은 컴퓨터(주소 · 포트가 같은)의 자리 */
    private static int indexOf(List<Host> hosts, String url) {
        String origin = originOf(url);
        for (int i = 0; i < hosts.size(); i++) {
            if (origin != null && origin.equals(originOf(hosts.get(i).url))) return i;
        }
        return -1;
    }

    private static String defaultName(String url) {
        try {
            String h = Uri.parse(url).getHost();
            return h == null ? "컴퓨터" : h;
        } catch (Exception e) {
            return "컴퓨터";
        }
    }

    /** 목록에 넣는다. 같은 컴퓨터가 있으면 이름 · 주소를 바꾼다 */
    private void putHost(String name, String url) {
        List<Host> hosts = hosts();
        int i = indexOf(hosts, url);
        Host h = new Host(name, url);
        if (i >= 0) hosts.set(i, h);
        else hosts.add(h);
        saveHosts(hosts);
    }

    private void removeHost(String url) {
        List<Host> hosts = hosts();
        int i = indexOf(hosts, url);
        if (i >= 0) hosts.remove(i);
        saveHosts(hosts);
    }

    /** 새로 넣는 주소의 이름을 묻고 넣은 뒤 그 컴퓨터로 들어간다. 이미 있는 컴퓨터면 그 이름을 채워 둔다 */
    private void askName(String url) {
        List<Host> hosts = hosts();
        int i = indexOf(hosts, url);
        EditText input = new EditText(this);
        input.setSingleLine(true);
        input.setText(i >= 0 ? hosts.get(i).name : defaultName(url));
        input.setSelectAllOnFocus(true);
        new AlertDialog.Builder(this)
                .setTitle("이 컴퓨터 이름")
                .setView(input)
                .setPositiveButton("저장", (d, w) -> {
                    String name = input.getText().toString().trim();
                    putHost(name.isEmpty() ? defaultName(url) : name, url);
                    showWeb(url);
                })
                .setNegativeButton("취소", (d, w) -> {
                    if (web == null) showList(null);
                })
                .setCancelable(false)
                .show();
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

    private void closeWeb() {
        if (web != null) {
            web.destroy();
            web = null;
        }
        current = null;
    }

    private TextView text(String s, int sp, int color) {
        TextView t = new TextView(this);
        t.setText(s);
        t.setTextSize(sp);
        t.setTextColor(color);
        return t;
    }

    /** 컴퓨터 목록: 누르면 들어가고, 길게 누르면 이름 바꾸기 · 지우기 */
    private void showList(String error) {
        List<Host> hosts = hosts();
        if (hosts.isEmpty()) {
            showSetup(error);
            return;
        }
        closeWeb();
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setPadding(dp(24), dp(28), dp(24), dp(28));
        box.addView(text("thuminal", 26, getColor(R.color.fg)));
        TextView desc = text("연결할 컴퓨터를 골라요. 길게 누르면 이름을 바꾸거나 지울 수 있어요.", 14, getColor(R.color.muted));
        desc.setPadding(0, dp(8), 0, dp(4));
        box.addView(desc);
        if (error != null) {
            TextView err = text(error, 13, Color.parseColor("#F7768E"));
            err.setPadding(0, dp(6), 0, dp(6));
            box.addView(err);
        }
        for (Host h : hosts) {
            Button row = button(h.name + "\n" + originOf(h.url), false);
            row.setGravity(Gravity.START | Gravity.CENTER_VERTICAL);
            row.setPadding(dp(16), 0, dp(16), 0);
            row.getLayoutParams().height = dp(64);
            row.setOnClickListener(v -> showWeb(h.url));
            row.setOnLongClickListener(v -> {
                new AlertDialog.Builder(this)
                        .setTitle(h.name)
                        .setItems(new String[] {"이름 바꾸기", "목록에서 지우기"}, (d, which) -> {
                            if (which == 0) askRename(h);
                            else new AlertDialog.Builder(this)
                                    .setMessage(h.name + " 을(를) 목록에서 지울까요? 다시 쓰려면 그 컴퓨터의 접속 주소로 다시 넣어야 해요.")
                                    .setPositiveButton("지우기", (d2, w2) -> {
                                        removeHost(h.url);
                                        showList(null);
                                    })
                                    .setNegativeButton("취소", null)
                                    .show();
                        })
                        .show();
                return true;
            });
            box.addView(row);
        }
        Button add = button("컴퓨터 추가", true);
        add.setOnClickListener(v -> showSetup(null));
        box.addView(add);
        ScrollView scroll = new ScrollView(this);
        scroll.addView(box);
        setContentView(fitInsets(scroll));
    }

    private void askRename(Host h) {
        EditText input = new EditText(this);
        input.setSingleLine(true);
        input.setText(h.name);
        input.setSelectAllOnFocus(true);
        new AlertDialog.Builder(this)
                .setTitle("이름 바꾸기")
                .setView(input)
                .setPositiveButton("저장", (d, w) -> {
                    String name = input.getText().toString().trim();
                    if (!name.isEmpty()) putHost(name, h.url);
                    showList(null);
                })
                .setNegativeButton("취소", null)
                .show();
    }

    /** 컴퓨터 추가: QR 찍기 또는 주소 붙여 넣기 */
    private void showSetup(String error) {
        closeWeb();
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setGravity(Gravity.CENTER_VERTICAL);
        box.setPadding(dp(28), dp(28), dp(28), dp(28));
        box.setBackgroundColor(getColor(R.color.bg));

        box.addView(text("컴퓨터 추가", 26, getColor(R.color.fg)));

        TextView desc = text("데스크톱 thuminal의 설정 → 원격 접속에 있는 접속 주소의 QR을 찍거나 주소를 붙여 넣어 주세요. 폰과 그 컴퓨터가 같은 Tailscale 망에 있어야 해요.", 14, getColor(R.color.muted));
        desc.setLineSpacing(0, 1.3f);
        desc.setPadding(0, dp(10), 0, dp(6));
        box.addView(desc);

        if (error != null) {
            TextView err = text(error, 13, Color.parseColor("#F7768E"));
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
        LinearLayout.LayoutParams ilp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        ilp.topMargin = dp(20);
        input.setLayoutParams(ilp);
        box.addView(input);

        Button go = button("추가", false);
        go.setOnClickListener(v -> {
            String url = normalize(input.getText().toString());
            if (url == null) {
                input.setError("http:// 로 시작하는 주소를 넣어 주세요");
                return;
            }
            askName(url);
        });
        box.addView(go);

        if (!hosts().isEmpty()) {
            Button back = button("목록으로", false);
            back.setOnClickListener(v -> showList(null));
            box.addView(back);
        }
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
                        showSetup("thuminal 접속 주소가 든 QR이 아니에요: " + code.getRawValue());
                        return;
                    }
                    askName(url);
                })
                .addOnFailureListener(e -> showSetup("QR을 찍지 못했어요: " + e.getMessage()));
    }

    /** 웹 화면. 주소의 #token= 은 웹 화면이 받아 이 WebView 저장소(컴퓨터 주소마다 따로)에 남긴다 */
    private void showWeb(String url) {
        closeWeb();
        current = url;
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
                if (req.isForMainFrame()) showList("컴퓨터에 연결하지 못했어요 (" + error.getDescription() + "). Tailscale이 켜져 있는지, 그 컴퓨터에서 원격 접속이 켜져 있는지 확인해 주세요.");
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
        else if (web != null && hosts().size() > 1) showList(null);
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

        /** 지금 컴퓨터를 목록에서 지우고 목록으로 (웹 화면이 이미 물어봤다) */
        @JavascriptInterface
        public void forget() {
            runOnUiThread(() -> {
                if (current != null) removeHost(current);
                if (web != null) web.clearCache(false);
                showList(null);
            });
        }

        /** 컴퓨터 목록으로 (다른 컴퓨터를 고르거나 더한다) */
        @JavascriptInterface
        public void changeServer() {
            runOnUiThread(() -> showList(null));
        }
    }
}
