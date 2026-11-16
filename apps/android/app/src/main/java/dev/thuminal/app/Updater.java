package dev.thuminal.app;

import android.app.Activity;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageInstaller;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.function.Consumer;
import org.json.JSONObject;

/**
 * 앱 업데이트. GitHub 에 게시한 최신 Release 를 보고, 새 버전이면 APK 를 받아 안드로이드 설치 창을 띄운다.
 *
 * 데스크톱 앱과 같은 기준(게시한 Release 의 latest.json)이라 "게시하면 모두 받는다" 가 맞는다. 같은 키로 서명한 APK 라
 * 덮어 깔리고 컴퓨터 목록은 남는다. 안드로이드는 조용히 깔지 못해 설치 창에서 사용자가 한 번 누르고, 처음에는
 * "출처를 알 수 없는 앱 설치" 를 허용해야 한다. 설치는 {@link PackageInstaller} 세션으로 해서 파일을 밖에 두지 않는다.
 */
final class Updater {
    private static final String LATEST = "https://github.com/whquddn55/thuminal/releases/latest/download/latest.json";
    private static final String APK = "https://github.com/whquddn55/thuminal/releases/latest/download/thuminal.apk";
    /** 설치 결과가 MainActivity 로 돌아올 때의 action */
    static final String ACTION_STATUS = "dev.thuminal.app.UPDATE_STATUS";
    private static final String KEY_LATEST = "update.latest";
    private static final String KEY_CHECKED = "update.checked";
    /** 저절로 확인하는 간격 (데스크톱 앱과 같다) */
    private static final long EVERY_MS = 6 * 60 * 60 * 1000L;

    private Updater() {}

    /** 깔린 앱 버전 */
    static String current(Context c) {
        try {
            return c.getPackageManager().getPackageInfo(c.getPackageName(), 0).versionName;
        } catch (PackageManager.NameNotFoundException e) {
            return "0";
        }
    }

    /** 지금 버전 · 새 버전(있으면)을 JSON 으로: {"current":"0.1.11","latest":"0.1.12"} (새 버전이 없으면 latest 는 null) */
    static String info(Context c) {
        String cur = current(c);
        String latest = Hosts.prefs(c).getString(KEY_LATEST, null);
        JSONObject o = new JSONObject();
        try {
            o.put("current", cur);
            o.put("latest", latest != null && newer(latest, cur) ? latest : JSONObject.NULL);
        } catch (Exception ignored) {
        }
        return o.toString();
    }

    /** a 가 b 보다 새 버전인가 (1.2.10 > 1.2.9) */
    static boolean newer(String a, String b) {
        String[] x = a.split("\\."), y = b.split("\\.");
        for (int i = 0; i < Math.max(x.length, y.length); i++) {
            int p = i < x.length ? num(x[i]) : 0, q = i < y.length ? num(y[i]) : 0;
            if (p != q) return p > q;
        }
        return false;
    }

    private static int num(String s) {
        try {
            return Integer.parseInt(s.replaceAll("\\D.*", ""));
        } catch (NumberFormatException e) {
            return 0;
        }
    }

    /**
     * 최신 버전을 확인한다. force 가 아니면 6시간 안에 확인했을 때 건너뛴다. 끝나면 done(info JSON 또는 오류면 null) 을
     * 확인한 스레드에서 부른다
     */
    static void check(Context c, boolean force, Consumer<String> done) {
        SharedPreferences p = Hosts.prefs(c);
        if (!force && System.currentTimeMillis() - p.getLong(KEY_CHECKED, 0) < EVERY_MS) {
            done.accept(info(c));
            return;
        }
        new Thread(() -> {
            try {
                String body = new String(fetch(LATEST), StandardCharsets.UTF_8);
                String v = new JSONObject(body).getString("version");
                p.edit().putString(KEY_LATEST, v).putLong(KEY_CHECKED, System.currentTimeMillis()).apply();
                done.accept(info(c));
            } catch (Exception e) {
                done.accept(null);
            }
        }).start();
    }

    /**
     * 새 APK 를 받아 설치 창을 띄운다. 진행은 status 로 알린다: "permission"(설치 허용 화면을 열었다. 허용한 뒤 다시 누른다),
     * "downloading", "installing"(설치 창이 뜬다), "error:<사유>"
     */
    static void install(Activity a, Consumer<String> status) {
        if (!a.getPackageManager().canRequestPackageInstalls()) {
            a.startActivity(new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + a.getPackageName())));
            status.accept("permission");
            return;
        }
        status.accept("downloading");
        new Thread(() -> {
            PackageInstaller pi = a.getPackageManager().getPackageInstaller();
            int id = -1;
            try {
                PackageInstaller.SessionParams params = new PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL);
                params.setAppPackageName(a.getPackageName());
                id = pi.createSession(params);
                try (PackageInstaller.Session s = pi.openSession(id)) {
                    HttpURLConnection conn = (HttpURLConnection) new URL(APK).openConnection();
                    conn.setConnectTimeout(15000);
                    conn.setReadTimeout(60000);
                    if (conn.getResponseCode() != 200) throw new Exception("HTTP " + conn.getResponseCode());
                    try (InputStream in = conn.getInputStream(); OutputStream out = s.openWrite("thuminal.apk", 0, conn.getContentLengthLong())) {
                        byte[] buf = new byte[64 * 1024];
                        for (int n; (n = in.read(buf)) > 0; ) out.write(buf, 0, n);
                        s.fsync(out);
                    }
                    // 결과는 MainActivity 로 돌아온다 (handle). 설치 창이 필요하면 거기서 띄운다
                    Intent back = new Intent(a, MainActivity.class).setAction(ACTION_STATUS);
                    PendingIntent pend = PendingIntent.getActivity(a, 0, back, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_MUTABLE);
                    s.commit(pend.getIntentSender());
                }
                status.accept("installing");
            } catch (Exception e) {
                if (id >= 0) pi.abandonSession(id);
                status.accept("error:" + e.getMessage());
            }
        }).start();
    }

    /** 설치 결과 인텐트를 다룬다. 사용자 확인이 필요하면 설치 창을 띄운다. 다룬 인텐트면 true */
    static boolean handle(Activity a, Intent intent) {
        if (intent == null || !ACTION_STATUS.equals(intent.getAction())) return false;
        int st = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE);
        if (st == PackageInstaller.STATUS_PENDING_USER_ACTION) {
            Intent confirm = Build.VERSION.SDK_INT >= 33 ? intent.getParcelableExtra(Intent.EXTRA_INTENT, Intent.class) : legacyExtra(intent);
            if (confirm != null) a.startActivity(confirm);
        }
        return true;
    }

    @SuppressWarnings("deprecation")
    private static Intent legacyExtra(Intent intent) {
        return intent.getParcelableExtra(Intent.EXTRA_INTENT);
    }

    private static byte[] fetch(String url) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setConnectTimeout(10000);
        c.setReadTimeout(15000);
        try (InputStream in = c.getInputStream(); ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            byte[] buf = new byte[8192];
            for (int n; (n = in.read(buf)) > 0; ) out.write(buf, 0, n);
            return out.toByteArray();
        } finally {
            c.disconnect();
        }
    }
}
