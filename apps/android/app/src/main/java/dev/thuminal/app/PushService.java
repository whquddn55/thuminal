package dev.thuminal.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;

import com.google.firebase.messaging.FirebaseMessagingService;
import com.google.firebase.messaging.RemoteMessage;

import java.util.Map;

/**
 * 데몬이 FCM 으로 보낸 알림 (crates/thuminal-daemon/src/push.rs). 앱이 꺼져 있어도 구글 플레이 서비스가 깨워 준다.
 * 데이터 메시지라 알림은 여기서 그린다. 누르면 그 컴퓨터의 그 세션을 연다.
 */
public class PushService extends FirebaseMessagingService {
    static final String CHANNEL_AGENT = "agent";
    static final String CHANNEL_BELL = "bell";
    static final String ACTION_OPEN = "dev.thuminal.app.OPEN";
    static final String EXTRA_HOST = "host";
    static final String EXTRA_SESSION = "session";

    @Override
    public void onNewToken(String token) {
        // 토큰이 바뀌었다. 등록한 컴퓨터마다 다시 맡긴다
        Hosts.registerAll(this, token, true);
    }

    @Override
    public void onMessageReceived(RemoteMessage message) {
        Map<String, String> d = message.getData();
        String origin = d.get("host");
        Hosts.Host host = Hosts.find(this, origin);
        // 목록에서 지운 컴퓨터의 알림은 띄우지 않는다
        if (host == null) return;
        long session = parse(d.get("session"));
        String title = orEmpty(d.get("title"));
        String subtitle = orEmpty(d.get("subtitle"));
        String body = orEmpty(d.get("body"));
        boolean bell = "bell".equals(d.get("kind"));

        channels(this);
        Intent open = new Intent(this, MainActivity.class)
                .setAction(ACTION_OPEN)
                .putExtra(EXTRA_HOST, origin)
                .putExtra(EXTRA_SESSION, session)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        int id = (origin + "#" + session).hashCode();
        PendingIntent pi = PendingIntent.getActivity(this, id, open, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        String text = body.isEmpty() ? subtitle : subtitle + " · " + body;
        Notification n = new Notification.Builder(this, bell ? CHANNEL_BELL : CHANNEL_AGENT)
                .setSmallIcon(R.drawable.ic_notify)
                .setColor(getColor(R.color.accent))
                .setSubText(host.name)
                .setContentTitle(title)
                .setContentText(text)
                .setStyle(new Notification.BigTextStyle().bigText(body.isEmpty() ? subtitle : subtitle + "\n" + body))
                .setContentIntent(pi)
                .setAutoCancel(true)
                .setCategory(Notification.CATEGORY_MESSAGE)
                .build();
        NotificationManager nm = getSystemService(NotificationManager.class);
        // 같은 세션 알림은 앞 것을 바꿔 끼운다
        if (nm != null) nm.notify(id, n);
    }

    /** 알림 종류 (설정 → 알림에서 종류마다 끄고 켠다) */
    static void channels(Context c) {
        NotificationManager nm = c.getSystemService(NotificationManager.class);
        if (nm == null) return;
        NotificationChannel agent = new NotificationChannel(CHANNEL_AGENT, "에이전트", NotificationManager.IMPORTANCE_HIGH);
        agent.setDescription("에이전트가 묻거나 일을 마쳤을 때");
        NotificationChannel bell = new NotificationChannel(CHANNEL_BELL, "터미널 벨", NotificationManager.IMPORTANCE_DEFAULT);
        bell.setDescription("터미널 벨이나 터미널 프로그램이 보낸 알림");
        nm.createNotificationChannel(agent);
        nm.createNotificationChannel(bell);
    }

    private static long parse(String s) {
        try {
            return s == null ? 0 : Long.parseLong(s);
        } catch (NumberFormatException e) {
            return 0;
        }
    }

    private static String orEmpty(String s) {
        return s == null ? "" : s;
    }
}
