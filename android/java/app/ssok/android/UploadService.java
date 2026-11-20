package app.ssok.android;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.ContentResolver;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.database.Cursor;
import android.net.Uri;
import android.net.wifi.WifiManager;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;
import android.provider.MediaStore;
import android.provider.OpenableColumns;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.URLEncoder;
import java.util.ArrayList;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

import javax.net.ssl.HttpsURLConnection;

import org.json.JSONObject;

/**
 * 공유받은 파일·텍스트를 PC로 보내는 서비스. 알림에 진행률을 보여 주고, 화면이 꺼져도 끝까지 보낸다.
 * 보내기 전에 저장해 둔 PC 인증서로 상대를 확인하고, PC의 IP가 바뀌었으면 같은 Wi-Fi에서 다시 찾는다.
 */
public class UploadService extends Service {
    static final String EXTRA_PC = "pc";
    static final String EXTRA_URIS = "uris";
    static final String EXTRA_TEXT = "text";

    private static final String CHANNEL_PROGRESS = "progress";
    private static final String CHANNEL_RESULT = "result";
    private static final int PROGRESS_ID = 1;

    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private NotificationManager notifications;
    private int pending;
    private int resultId = 100;

    /** 상대 PC가 연결을 해제했다 */
    private static final class UnpairedException extends Exception {}

    /** 다시 시도해도 소용없는 오류 (PC가 거절 등) */
    private static final class RejectedException extends Exception {
        RejectedException(String message) {
            super(message);
        }
    }

    @Override
    public void onCreate() {
        super.onCreate();
        notifications = getSystemService(NotificationManager.class);
        notifications.createNotificationChannel(new NotificationChannel(CHANNEL_PROGRESS, "보내는 중", NotificationManager.IMPORTANCE_LOW));
        notifications.createNotificationChannel(new NotificationChannel(CHANNEL_RESULT, "보내기 결과", NotificationManager.IMPORTANCE_DEFAULT));
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        Notification starting = progress("보낼 준비 중…", 0, 0, true);
        if (Build.VERSION.SDK_INT >= 29) startForeground(PROGRESS_ID, starting, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
        else startForeground(PROGRESS_ID, starting);
        synchronized (this) {
            pending++;
        }
        worker.execute(() -> {
            try {
                run(intent);
            } finally {
                synchronized (this) {
                    pending--;
                    if (pending == 0) {
                        stopForeground(STOP_FOREGROUND_REMOVE);
                        stopSelf();
                    }
                }
            }
        });
        return START_NOT_STICKY;
    }

    private void run(Intent intent) {
        Store.Pc pc = intent == null ? null : Store.get(this, intent.getStringExtra(EXTRA_PC));
        if (pc == null) {
            result("보내지 못했어요", "연결된 PC를 찾을 수 없어요. 앱에서 PC를 다시 연결해 주세요.", true);
            return;
        }
        ArrayList<Uri> uris = intent.getParcelableArrayListExtra(EXTRA_URIS);
        String text = intent.getStringExtra(EXTRA_TEXT);

        PowerManager.WakeLock wake = getSystemService(PowerManager.class).newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "ssok:upload");
        WifiManager.WifiLock wifi = ((WifiManager) getApplicationContext().getSystemService(WIFI_SERVICE))
                .createWifiLock(Build.VERSION.SDK_INT >= 29 ? WifiManager.WIFI_MODE_FULL_LOW_LATENCY : WifiManager.WIFI_MODE_FULL_HIGH_PERF, "ssok:upload");
        wake.acquire(6 * 60 * 60 * 1000L);
        wifi.acquire();
        try {
            if (text != null && (uris == null || uris.isEmpty())) {
                sendText(pc, text);
                result(pc.name + "(으)로 보냈어요", "텍스트", false);
                return;
            }
            int sent = 0;
            String lastError = null;
            for (int i = 0; uris != null && i < uris.size(); i++) {
                try {
                    sendFile(pc, uris.get(i), i + 1, uris.size());
                    sent++;
                } catch (UnpairedException e) {
                    Store.remove(this, pc.id);
                    result("PC에서 연결이 해제됐어요", pc.name + "에 다시 연결해 주세요.", true);
                    return;
                } catch (RejectedException e) {
                    lastError = e.getMessage();
                } catch (Exception e) {
                    lastError = pc.name + "에 연결하지 못했어요. PC에서 쏙이 켜져 있고 같은 Wi-Fi인지 확인해 주세요.\n(원인: " + Net.describe(e) + ")";
                    break; // 연결이 안 되면 남은 파일도 안 된다
                }
            }
            int total = uris == null ? 0 : uris.size();
            if (sent == total) result(pc.name + "(으)로 " + (total == 1 ? "보냈어요" : total + "개를 보냈어요"), "PC의 받은 파일 폴더에 저장됐어요.", false);
            else result(total + "개 중 " + sent + "개를 보냈어요", lastError, true);
        } catch (UnpairedException e) {
            Store.remove(this, pc.id);
            result("PC에서 연결이 해제됐어요", pc.name + "에 다시 연결해 주세요.", true);
        } catch (Exception e) {
            result("보내지 못했어요", pc.name + "에 연결하지 못했어요. PC에서 쏙이 켜져 있고 같은 Wi-Fi인지 확인해 주세요.\n(원인: " + Net.describe(e) + ")", true);
        } finally {
            wifi.release();
            wake.release();
        }
    }

    // ---- 보내기 ----

    private void sendText(Store.Pc pc, String text) throws Exception {
        withRediscovery(pc, () -> {
            Net.Result r = Net.json(pc.host, pc.port, "POST", "/api/text", new JSONObject().put("text", text), pc.key, pc.fingerprint, 15000);
            check(r.status, r.json);
            return null;
        });
    }

    private void sendFile(Store.Pc pc, Uri uri, int index, int total) throws Exception {
        ContentResolver resolver = getContentResolver();
        String name = "파일";
        long size = -1;
        try (Cursor c = resolver.query(uri, new String[] {OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE}, null, null, null)) {
            if (c != null && c.moveToFirst()) {
                if (!c.isNull(0)) name = c.getString(0);
                if (!c.isNull(1)) size = c.getLong(1);
            }
        }
        long lastModified = lastModified(resolver, uri);

        // 크기를 알려 주지 않는 앱도 있다. PC는 크기를 미리 알아야 하므로 잠시 복사해서 잰다.
        File temp = null;
        if (size < 0) {
            temp = File.createTempFile("share", null, getCacheDir());
            try (InputStream in = resolver.openInputStream(uri); OutputStream out = new FileOutputStream(temp)) {
                copy(in, out, null);
            }
            size = temp.length();
        }
        final File source = temp;
        final long length = size;
        final String fileName = name;
        try {
            withRediscovery(pc, () -> {
                upload(pc, fileName, length, lastModified, index, total, () -> source != null ? new FileInputStream(source) : resolver.openInputStream(uri));
                return null;
            });
        } finally {
            if (temp != null) temp.delete();
        }
    }

    private interface Opener {
        InputStream open() throws IOException;
    }

    private interface Attempt {
        Void run() throws Exception;
    }

    private interface Progress {
        void update(long done);
    }

    private void upload(Store.Pc pc, String name, long size, long lastModified, int index, int total, Opener opener) throws Exception {
        String path = "/api/upload?name=" + URLEncoder.encode(name, "UTF-8") + (lastModified > 0 ? "&lastModified=" + lastModified : "");
        HttpsURLConnection c = Net.open(pc.host, pc.port, path, pc.fingerprint, null);
        try {
            c.setConnectTimeout(5000);
            c.setReadTimeout(60000);
            c.setRequestMethod("POST");
            c.setDoOutput(true);
            c.setFixedLengthStreamingMode(size);
            c.setRequestProperty("Authorization", "Bearer " + pc.key);
            c.setRequestProperty("Content-Type", "application/octet-stream");
            String label = (total > 1 ? index + "/" + total + " · " : "") + name;
            long started = System.currentTimeMillis();
            try (InputStream in = opener.open(); OutputStream out = c.getOutputStream()) {
                if (in == null) throw new RejectedException(name + ": 파일을 읽을 수 없어요.");
                long[] last = {0};
                copy(in, out, done -> {
                    long now = System.currentTimeMillis();
                    if (now - last[0] < 500) return;
                    last[0] = now;
                    double seconds = Math.max(0.5, (now - started) / 1000.0);
                    String speed = formatSize((long) (done / seconds)) + "/s";
                    notifications.notify(PROGRESS_ID, progress(label, (int) (done * 1000 / Math.max(1, size)), 1000, false, pc.name + "(으)로 보내는 중 · " + speed));
                });
            }
            String body = Net.readAll(c.getResponseCode() >= 400 ? c.getErrorStream() : c.getInputStream());
            JSONObject json;
            try {
                json = new JSONObject(body);
            } catch (Exception e) {
                json = new JSONObject();
            }
            check(c.getResponseCode(), json);
        } finally {
            c.disconnect();
        }
    }

    /** 연결이 안 되면 같은 Wi-Fi에서 PC를 다시 찾아(IP가 바뀌었을 수 있다) 한 번 더 시도한다 */
    private void withRediscovery(Store.Pc pc, Attempt attempt) throws Exception {
        try {
            attempt.run();
        } catch (UnpairedException | RejectedException e) {
            throw e;
        } catch (Exception first) {
            notifications.notify(PROGRESS_ID, progress(pc.name + " 찾는 중…", 0, 0, true));
            String[] found = Net.find(pc.id, 3000);
            if (found == null) throw first;
            String host = found[0];
            int port = Integer.parseInt(found[1]);
            // 저장해 둔 인증서로만 확인한다. 같은 Wi-Fi의 다른 기기가 그 PC인 척 답해도 여기서 걸러진다.
            Net.Result ping = Net.json(host, port, "GET", "/api/ping", null, null, pc.fingerprint, 5000);
            if (ping.status != 200 || !pc.id.equals(ping.json.optString("id"))) throw first;
            pc.host = host;
            pc.port = port;
            Store.save(this, pc);
            attempt.run();
        }
    }

    private static void check(int status, JSONObject json) throws Exception {
        if (status >= 200 && status < 300) return;
        if (status == 401) throw new UnpairedException();
        throw new RejectedException(json.optString("error", "PC가 받지 못했어요. (" + status + ")"));
    }

    private static void copy(InputStream in, OutputStream out, Progress progress) throws IOException {
        byte[] buf = new byte[64 * 1024];
        long done = 0;
        int n;
        while ((n = in.read(buf)) > 0) {
            out.write(buf, 0, n);
            done += n;
            if (progress != null) progress.update(done);
        }
    }

    /** 사진 찍은 날짜를 PC 파일에도 남기려고 원래 시각을 알아낸다 */
    private static long lastModified(ContentResolver resolver, Uri uri) {
        String[] columns = Build.VERSION.SDK_INT >= 29
                ? new String[] {MediaStore.MediaColumns.DATE_TAKEN, MediaStore.MediaColumns.DATE_MODIFIED}
                : new String[] {MediaStore.MediaColumns.DATE_MODIFIED};
        try (Cursor c = resolver.query(uri, columns, null, null, null)) {
            if (c != null && c.moveToFirst()) {
                if (columns.length == 2 && !c.isNull(0) && c.getLong(0) > 0) return c.getLong(0); // 밀리초
                int modified = columns.length - 1;
                if (!c.isNull(modified) && c.getLong(modified) > 0) return c.getLong(modified) * 1000; // 초
            }
        } catch (Exception ignored) {
            // 미디어가 아닌 파일 등
        }
        return 0;
    }

    private static String formatSize(long bytes) {
        if (bytes < 1024) return bytes + " B";
        double value = bytes;
        String[] units = {"KB", "MB", "GB"};
        int unit = -1;
        do {
            value /= 1024;
            unit++;
        } while (value >= 1024 && unit < units.length - 1);
        return (value >= 100 ? String.valueOf(Math.round(value)) : String.format("%.1f", value)) + " " + units[unit];
    }

    // ---- 알림 ----

    private Notification progress(String title, int done, int max, boolean indeterminate) {
        return progress(title, done, max, indeterminate, null);
    }

    private Notification progress(String title, int done, int max, boolean indeterminate, String text) {
        Notification.Builder b = new Notification.Builder(this, CHANNEL_PROGRESS)
                .setSmallIcon(R.drawable.ic_notify)
                .setContentTitle(title)
                .setOnlyAlertOnce(true)
                .setOngoing(true)
                .setProgress(max, done, indeterminate);
        if (text != null) b.setContentText(text);
        return b.build();
    }

    private void result(String title, String text, boolean error) {
        PendingIntent open = PendingIntent.getActivity(this, 0, new Intent(this, MainActivity.class), PendingIntent.FLAG_IMMUTABLE);
        Notification n = new Notification.Builder(this, CHANNEL_RESULT)
                .setSmallIcon(R.drawable.ic_notify)
                .setContentTitle(title)
                .setContentText(text)
                .setStyle(new Notification.BigTextStyle().bigText(text))
                .setAutoCancel(true)
                .setContentIntent(open)
                .build();
        notifications.notify(error ? 99 : resultId++, n);
    }
}
