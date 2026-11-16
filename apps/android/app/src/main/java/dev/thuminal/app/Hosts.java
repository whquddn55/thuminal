package dev.thuminal.app;

import android.content.Context;
import android.content.SharedPreferences;
import android.net.Uri;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * 컴퓨터 목록 (SharedPreferences) 과 데몬 HTTP 요청 (요약 · 알림 등록).
 *
 * 컴퓨터 하나는 이름과 접속 주소(`http://100.x.y.z:6780/#token=…`)다. 같은 컴퓨터는 origin(주소 · 포트)으로 가른다.
 */
final class Hosts {
    static final String PREFS = "thuminal";
    /** 예전 판이 남긴 주소 하나 (처음 켤 때 목록으로 옮긴다) */
    private static final String KEY_URL = "url";
    /** 컴퓨터 목록: [{"name": …, "url": …}] */
    private static final String KEY_HOSTS = "hosts";
    /** 컴퓨터마다 마지막으로 맡긴 FCM 토큰: "push:<origin>" */
    private static final String KEY_PUSHED = "push:";
    private static final Pattern TOKEN = Pattern.compile("token=([0-9a-f]+)");

    static final class Host {
        final String name;
        final String url;

        Host(String name, String url) {
            this.name = name;
            this.url = url;
        }
    }

    private Hosts() {}

    static SharedPreferences prefs(Context c) {
        return c.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    static List<Host> list(Context c) {
        List<Host> out = new ArrayList<>();
        try {
            JSONArray a = new JSONArray(prefs(c).getString(KEY_HOSTS, "[]"));
            for (int i = 0; i < a.length(); i++) {
                JSONObject o = a.getJSONObject(i);
                out.add(new Host(o.optString("name"), o.optString("url")));
            }
        } catch (JSONException ignored) {
        }
        return out;
    }

    static JSONArray json(Context c) {
        JSONArray a = new JSONArray();
        try {
            for (Host h : list(c)) a.put(new JSONObject().put("name", h.name).put("url", h.url).put("origin", originOf(h.url)));
        } catch (JSONException ignored) {
        }
        return a;
    }

    private static void save(Context c, List<Host> hosts) {
        JSONArray a = new JSONArray();
        try {
            for (Host h : hosts) a.put(new JSONObject().put("name", h.name).put("url", h.url));
        } catch (JSONException ignored) {
        }
        prefs(c).edit().putString(KEY_HOSTS, a.toString()).apply();
    }

    /** 예전 판의 주소 하나를 목록으로 옮긴다 */
    static void migrate(Context c) {
        String old = prefs(c).getString(KEY_URL, null);
        if (old == null) return;
        List<Host> hosts = list(c);
        if (indexOf(hosts, old) < 0) hosts.add(new Host(defaultName(old), old));
        save(c, hosts);
        prefs(c).edit().remove(KEY_URL).apply();
    }

    /** 같은 컴퓨터(주소 · 포트가 같은)의 자리 */
    static int indexOf(List<Host> hosts, String url) {
        String origin = originOf(url);
        for (int i = 0; i < hosts.size(); i++) {
            if (origin != null && origin.equals(originOf(hosts.get(i).url))) return i;
        }
        return -1;
    }

    static Host find(Context c, String origin) {
        for (Host h : list(c)) if (origin != null && origin.equals(originOf(h.url))) return h;
        return null;
    }

    /** 목록에 넣는다. 같은 컴퓨터가 있으면 이름 · 주소를 바꾼다 */
    static void put(Context c, String name, String url) {
        List<Host> hosts = list(c);
        int i = indexOf(hosts, url);
        Host h = new Host(name, url);
        if (i >= 0) hosts.set(i, h);
        else hosts.add(h);
        save(c, hosts);
    }

    static void remove(Context c, String url) {
        List<Host> hosts = list(c);
        int i = indexOf(hosts, url);
        if (i >= 0) hosts.remove(i);
        save(c, hosts);
        prefs(c).edit().remove(KEY_PUSHED + originOf(url)).apply();
    }

    static String defaultName(String url) {
        try {
            String h = Uri.parse(url).getHost();
            return h == null ? "컴퓨터" : h;
        } catch (Exception e) {
            return "컴퓨터";
        }
    }

    /** http(s) 주소만 받는다. 끝의 공백·줄바꿈은 지운다 */
    static String normalize(String text) {
        if (text == null) return null;
        String t = text.trim();
        if (t.startsWith("http://") || t.startsWith("https://")) return t;
        return null;
    }

    static String originOf(String url) {
        try {
            Uri u = Uri.parse(url);
            return u.getScheme() + "://" + u.getAuthority();
        } catch (Exception e) {
            return null;
        }
    }

    static String tokenOf(String url) {
        Matcher m = TOKEN.matcher(url == null ? "" : url);
        return m.find() ? m.group(1) : "";
    }

    /** 세션을 바로 여는 주소 (웹 화면이 `open=` 을 읽는다) */
    static String openUrl(String url, long session) {
        if (session <= 0) return url;
        return url + (url.contains("#") ? "&" : "#") + "open=" + session;
    }

    // ---- 데몬 HTTP (UI 스레드에서 부르지 않는다) ----

    static final class Reply {
        final int code;
        final String body;

        Reply(int code, String body) {
            this.code = code;
            this.body = body;
        }
    }

    static Reply request(String method, String url, String body) {
        HttpURLConnection c = null;
        try {
            c = (HttpURLConnection) new URL(url).openConnection();
            c.setConnectTimeout(4000);
            c.setReadTimeout(6000);
            c.setRequestMethod(method);
            if (body != null) {
                c.setDoOutput(true);
                c.setRequestProperty("Content-Type", "application/json");
                try (OutputStream o = c.getOutputStream()) {
                    o.write(body.getBytes(StandardCharsets.UTF_8));
                }
            }
            int code = c.getResponseCode();
            InputStream in = code < 400 ? c.getInputStream() : c.getErrorStream();
            return new Reply(code, in == null ? "" : read(in));
        } catch (Exception e) {
            return new Reply(0, String.valueOf(e.getMessage()));
        } finally {
            if (c != null) c.disconnect();
        }
    }

    private static String read(InputStream in) throws java.io.IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        int n;
        while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
        in.close();
        return out.toString("UTF-8");
    }

    /** 모든 세션 요약 (`/api/summary`) */
    static Reply summary(String url) {
        return request("GET", originOf(url) + "/api/summary?token=" + tokenOf(url), null);
    }

    /** 요약에 든 컴퓨터 이름 (그 컴퓨터의 기본 워크스페이스 이름). 옛 데몬이거나 못 읽으면 null */
    static String nameIn(Reply r) {
        if (r.code != 200) return null;
        try {
            String n = new JSONObject(r.body).optString("name", "").trim();
            return n.isEmpty() ? null : n;
        } catch (JSONException e) {
            return null;
        }
    }

    /** 그 컴퓨터가 정한 이름이 목록 이름과 다르면 맞춘다 */
    static void syncName(Context c, String url, Reply r) {
        String name = nameIn(r);
        Host h = find(c, originOf(url));
        if (name != null && h != null && !name.equals(h.name)) put(c, name, h.url);
    }

    /**
     * 그 컴퓨터 이름을 바꾼다 (`/api/name`). 그 컴퓨터와 거기 붙은 모든 화면에 같이 바뀐다.
     * 옛 데몬은 이 요청을 몰라 이 폰 목록에서만 바꾼다. 실패하면 화면에 보일 글
     */
    static String rename(Context c, String url, String name) {
        String body;
        try {
            body = new JSONObject().put("name", name).toString();
        } catch (JSONException e) {
            return "이름을 보내지 못했어요";
        }
        Reply r = request("POST", originOf(url) + "/api/name?token=" + tokenOf(url), body);
        if (r.code == 0) return "그 컴퓨터에 연결되지 않아 이름을 바꾸지 못했어요";
        if (r.code == 401) return "접속 주소의 토큰이 맞지 않아요";
        if (r.code == 400) return r.body;
        String got = null;
        if (r.code == 200) {
            try {
                got = new JSONObject(r.body).optString("name", null);
            } catch (JSONException ignored) {
            }
        }
        Host h = find(c, originOf(url));
        if (h != null) put(c, got == null || got.isEmpty() ? name : got, h.url);
        return null;
    }

    /** 이 컴퓨터에 FCM 토큰을 맡긴다. 같은 토큰을 이미 맡겼으면 건너뛴다 (force 면 다시) */
    static void registerPush(Context c, String url, String fcm, boolean force) {
        String origin = originOf(url);
        if (fcm == null || origin == null) return;
        String key = KEY_PUSHED + origin;
        if (!force && fcm.equals(prefs(c).getString(key, null))) return;
        String body;
        try {
            body = new JSONObject().put("fcm", fcm).put("host", origin).put("on", true).toString();
        } catch (JSONException e) {
            return;
        }
        Reply r = request("POST", origin + "/api/push?token=" + tokenOf(url), body);
        if (r.code == 200) prefs(c).edit().putString(key, fcm).apply();
    }

    static void registerAll(Context c, String fcm, boolean force) {
        for (Host h : list(c)) registerPush(c, h.url, fcm, force);
    }
}
