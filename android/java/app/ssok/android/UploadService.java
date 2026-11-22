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
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
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
import java.util.HashMap;
import java.util.Map;
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
    private int lastStartId; // 가장 최근에 받은 시작 번호 (끝낼 때 그보다 새 요청이 있으면 끄지 않게)
    private volatile boolean timedOut; // 안드로이드가 오래 걸린다고 멈추라고 했다
    private int resultId = 100;
    private Relay relay; // 이번에 보내는 동안 열어 둔 중계 통로 (여러 파일을 보낼 때 다시 쓴다)
    private boolean viaRelay; // 마지막으로 중계 서버로 보냈는지 (결과 알림에 적는다)

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
            lastStartId = startId;
        }
        worker.execute(() -> {
            try {
                run(intent);
            } finally {
                synchronized (this) {
                    pending--;
                    if (pending == 0) {
                        stopForeground(STOP_FOREGROUND_REMOVE);
                        stopSelf(lastStartId); // 그사이 새 공유가 들어왔으면 안드로이드가 끄지 않는다
                    }
                }
            }
        });
        return START_NOT_STICKY;
    }

    /** 안드로이드 15부터: 데이터 보내기 서비스는 하루 6시간까지. 넘으면 불리고, 곧바로 멈춰야 한다. */
    public void onTimeout(int startId, int fgsType) {
        timedOut = true;
        result("보내기를 멈췄어요", "안드로이드가 오래 걸리는 보내기를 멈췄어요. 남은 파일은 다시 보내 주세요.", true);
        stopForeground(STOP_FOREGROUND_REMOVE);
        stopSelf();
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
        viaRelay = false;
        try {
            if (text != null && (uris == null || uris.isEmpty())) {
                sendText(pc, text);
                result(pc.name + "(으)로 보냈어요", "텍스트", false);
                return;
            }
            int sent = 0;
            String lastError = null;
            for (int i = 0; uris != null && i < uris.size() && !timedOut; i++) {
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
                    lastError = failureText(pc, e);
                    break; // 연결이 안 되면 남은 파일도 안 된다
                }
            }
            int total = uris == null ? 0 : uris.size();
            if (sent == total) result(pc.name + "(으)로 " + (total == 1 ? "보냈어요" : total + "개를 보냈어요"), viaRelay ? "집 밖이라 중계 서버를 거쳐 보냈어요 (암호화). PC의 받은 파일 폴더에 저장됐어요." : "PC의 받은 파일 폴더에 저장됐어요.", false);
            else result(total + "개 중 " + sent + "개를 보냈어요", lastError, true);
        } catch (UnpairedException e) {
            Store.remove(this, pc.id);
            result("PC에서 연결이 해제됐어요", pc.name + "에 다시 연결해 주세요.", true);
        } catch (Exception e) {
            result("보내지 못했어요", failureText(pc, e), true);
        } finally {
            if (relay != null) relay.close();
            relay = null;
            wifi.release();
            wake.release();
        }
    }

    // ---- 보내기 ----

    private void sendText(Store.Pc pc, String text) throws Exception {
        byte[] body = new JSONObject().put("text", text).toString().getBytes("UTF-8");
        deliver(pc, () -> {
            Net.Result r = Net.json(pc.host, pc.port, "POST", "/api/text", new JSONObject().put("text", text), pc.key, pc.fingerprint, 15000);
            check(r.status, r.json);
            return null;
        }, () -> {
            relayRequest(pc, "/api/text", "application/json", body.length, () -> new java.io.ByteArrayInputStream(body), null);
            return null;
        });
    }

    private void sendFile(Store.Pc pc, Uri uri, int index, int total) throws Exception {
        ContentResolver resolver = getContentResolver();
        try (InputStream probe = resolver.openInputStream(uri)) {
            if (probe == null) throw new RejectedException("파일을 읽을 수 없어요.");
        } catch (IOException | SecurityException e) {
            throw new RejectedException("파일을 읽을 수 없어요. 지워졌거나 아직 내려받지 않은 파일일 수 있어요.");
        }
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
                if (in == null) throw new RejectedException("파일을 읽을 수 없어요.");
                copy(in, out, null);
            } catch (Exception e) {
                temp.delete();
                if (e instanceof RejectedException) throw e;
                throw new RejectedException("파일을 읽을 수 없어요. (휴대폰 저장 공간이 부족할 수 있어요)");
            }
            size = temp.length();
        }
        final File source = temp;
        final long length = size;
        final String fileName = name;
        Opener opener = () -> source != null ? new FileInputStream(source) : resolver.openInputStream(uri);
        try {
            deliver(pc, () -> {
                upload(pc, fileName, length, lastModified, index, total, opener);
                return null;
            }, () -> {
                String path = "/api/upload?name=" + URLEncoder.encode(fileName, "UTF-8") + (lastModified > 0 ? "&lastModified=" + lastModified : "");
                relayRequest(pc, path, "application/octet-stream", length, opener, progressFor(pc, fileName, length, index, total, true));
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

    /**
     * 같은 Wi-Fi(또는 Tailscale)로 바로 보내 보고, 안 되면 중계 서버로 보낸다.
     * 휴대폰이 데이터(LTE·5G)로만 연결되어 있으면 바로 보내기는 어차피 안 되니 중계 서버부터 쓴다.
     */
    private void deliver(Store.Pc pc, Attempt direct, Attempt viaRelayServer) throws Exception {
        boolean canRelay = !pc.relay.isEmpty();
        boolean relayTried = false;
        Exception relayError = null;
        // 이번에 보내는 중에 이미 중계로 보냈으면 남은 파일도 바로 중계로 (파일마다 바로 보내기를 기다리지 않게)
        if (canRelay && (viaRelay || !onLocalNetwork())) {
            relayTried = true;
            try {
                viaRelayServer.run();
                viaRelay = true;
                return;
            } catch (UnpairedException | RejectedException e) {
                throw e;
            } catch (Exception e) {
                relayError = e; // Tailscale 등으로 바로 닿을 수도 있으니 아래에서 마저 해 본다
            }
        }
        try {
            withRediscovery(pc, direct);
        } catch (UnpairedException | RejectedException e) {
            throw e;
        } catch (Exception e) {
            if (!canRelay) throw e;
            if (relayTried) throw relayError;
            viaRelayServer.run();
            viaRelay = true;
        }
    }

    /** 휴대폰이 지금 Wi-Fi(또는 유선)에 연결되어 있는지 */
    private boolean onLocalNetwork() {
        try {
            ConnectivityManager cm = getSystemService(ConnectivityManager.class);
            Network active = cm.getActiveNetwork();
            NetworkCapabilities caps = active == null ? null : cm.getNetworkCapabilities(active);
            return caps != null && (caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) || caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET));
        } catch (Exception e) {
            return true; // 모르면 지금처럼 바로 보내기부터
        }
    }

    /** 중계 서버를 거쳐 PC의 쏙에 보낸다. 통로는 한 번 열어 두고 이번에 보내는 파일들에 다시 쓴다. */
    private void relayRequest(Store.Pc pc, String path, String contentType, long length, Opener opener, Progress progress) throws Exception {
        notifications.notify(PROGRESS_ID, progress(pc.name + "(으)로 보내는 중", 0, 0, true, "집 밖이라 중계 서버를 거쳐요"));
        Map<String, String> headers = new HashMap<>();
        headers.put("content-type", contentType);
        headers.put("x-requested-with", Net.APP_ID);
        boolean reused = relay != null;
        Watchdog dog = new Watchdog(60_000, () -> {
            Relay r = relay;
            if (r != null) r.close(); // 1분 동안 하나도 못 보냈다: 통로를 닫아 멈춘 쓰기를 깨운다
        });
        try {
            if (relay == null) relay = Relay.connect(pc.relay, pc.id, Store.appId(this), Relay.peerSecret(pc.key), Store.deviceName(this), 15000);
            Relay.Response r;
            try (InputStream in = opener.open()) {
                if (in == null) throw new RejectedException("파일을 읽을 수 없어요.");
                r = relay.request("POST", path, headers, in, length, done -> {
                    dog.kick();
                    if (progress != null) progress.update(done);
                });
            }
            JSONObject json;
            try {
                json = new JSONObject(r.body == null ? "" : r.body);
            } catch (Exception e) {
                json = new JSONObject();
            }
            check(r.status, json);
        } catch (Relay.RelayException e) {
            closeRelay();
            if (reused && "CLOSED".equals(e.code)) {
                dog.close();
                relayRequest(pc, path, contentType, length, opener, progress); // 오래 쉬어 끊긴 통로: 새로 열어 한 번 더
                return;
            }
            // PC에서 연결을 해제했거나 키가 바뀐 것 같다. 다만 이 표시는 중계 서버가 보낸 것이라 연결을 지우지는 않는다.
            if ("UNKNOWN_PEER".equals(e.code) || "BAD_KEY".equals(e.code)) {
                throw new IOException("PC가 이 휴대폰을 모른다고 해요. PC에서 연결을 해제했다면 앱에서 그 PC를 지우고 다시 연결해 주세요.", e);
            }
            if ("PC_OFFLINE".equals(e.code) || "PC_TIMEOUT".equals(e.code)) throw new IOException(pc.name + "의 쏙이 꺼져 있거나 중계 서버에 연결되어 있지 않아요.", e);
            throw e;
        } catch (IOException e) {
            closeRelay(); // 끊긴 통로는 버린다 (다음 파일은 새로 연다)
            if (reused) {
                dog.close();
                relayRequest(pc, path, contentType, length, opener, progress); // 오래 쉬어 끊긴 통로: 새로 열어 한 번 더
                return;
            }
            throw e;
        } finally {
            dog.close();
        }
    }

    /** 정해진 시간 동안 kick()이 없으면 onStall을 부른다 (멈춘 연결을 끊어, 끝없이 기다리지 않게) */
    private static final class Watchdog {
        private volatile long last = System.currentTimeMillis();
        private volatile boolean done;
        private final Thread thread;

        Watchdog(long limitMs, Runnable onStall) {
            thread = new Thread(() -> {
                while (!done) {
                    try {
                        Thread.sleep(2000);
                    } catch (InterruptedException e) {
                        return;
                    }
                    if (!done && System.currentTimeMillis() - last > limitMs) {
                        onStall.run();
                        return;
                    }
                }
            }, "ssok-watchdog");
            thread.setDaemon(true);
            thread.start();
        }

        void kick() {
            last = System.currentTimeMillis();
        }

        void close() {
            done = true;
            thread.interrupt();
        }
    }

    private void closeRelay() {
        if (relay != null) relay.close();
        relay = null;
    }

    /** 알림의 진행률 (바로 보낼 때와 같은 모양) */
    private Progress progressFor(Store.Pc pc, String name, long size, int index, int total, boolean relayed) {
        String label = (total > 1 ? index + "/" + total + " · " : "") + name;
        long started = System.currentTimeMillis();
        long[] last = {0};
        return done -> {
            long now = System.currentTimeMillis();
            if (now - last[0] < 500) return;
            last[0] = now;
            double seconds = Math.max(0.5, (now - started) / 1000.0);
            String speed = formatSize((long) (done / seconds)) + "/s";
            notifications.notify(PROGRESS_ID, progress(label, (int) (done * 1000 / Math.max(1, size)), 1000, false,
                    pc.name + "(으)로 보내는 중 · " + (relayed ? "중계 서버 · " : "") + speed));
        };
    }

    /** 보내지 못했을 때 알림 문구 */
    private static String failureText(Store.Pc pc, Exception e) {
        String hint = pc.relay.isEmpty()
                ? "PC에서 쏙이 켜져 있고 같은 Wi-Fi인지 확인해 주세요. 집 밖에서도 보내려면 PC [설정]에서 ‘어디서나 (중계 서버)’를 켜고, 같은 Wi-Fi에서 이 앱을 한 번 열어 주세요."
                : "PC에서 쏙이 켜져 있는지 확인해 주세요.";
        return pc.name + "에 연결하지 못했어요. " + hint + "\n(원인: " + Net.describe(e) + ")";
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
            Watchdog dog = new Watchdog(60_000, c::disconnect);
            try (InputStream in = opener.open(); OutputStream out = c.getOutputStream()) {
                if (in == null) throw new RejectedException(name + ": 파일을 읽을 수 없어요.");
                long[] last = {0};
                copy(in, out, done -> {
                    dog.kick();
                    long now = System.currentTimeMillis();
                    if (now - last[0] < 500) return;
                    last[0] = now;
                    double seconds = Math.max(0.5, (now - started) / 1000.0);
                    String speed = formatSize((long) (done / seconds)) + "/s";
                    notifications.notify(PROGRESS_ID, progress(label, (int) (done * 1000 / Math.max(1, size)), 1000, false, pc.name + "(으)로 보내는 중 · " + speed));
                });
            } finally {
                dog.close();
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

    /**
     * 지금 주소로 연결이 안 되면 PC의 다른 주소(집 밖이면 Tailscale 주소 등)를 써 보고,
     * 그래도 안 되면 같은 Wi-Fi에서 PC를 다시 찾아(IP가 바뀌었을 수 있다) 한 번 더 시도한다.
     */
    private void withRediscovery(Store.Pc pc, Attempt attempt) throws Exception {
        try {
            attempt.run();
        } catch (UnpairedException | RejectedException e) {
            throw e;
        } catch (Exception first) {
            notifications.notify(PROGRESS_ID, progress(pc.name + " 찾는 중…", 0, 0, true));
            String[] found = null;
            for (String alt : new ArrayList<>(pc.alts)) {
                if (isThatPc(pc, alt, pc.port)) {
                    found = new String[] {alt, String.valueOf(pc.port)};
                    break;
                }
            }
            if (found == null) {
                String[] answer = Net.find(pc.id, 3000);
                if (answer != null && isThatPc(pc, answer[0], Integer.parseInt(answer[1]))) found = answer;
            }
            if (found == null) throw first;
            // 이전 주소도 다른 주소 목록에 남겨 둔다 (집에 돌아오면 다시 쓴다)
            if (!pc.alts.contains(pc.host)) pc.alts.add(pc.host);
            pc.alts.remove(found[0]);
            pc.host = found[0];
            pc.port = Integer.parseInt(found[1]);
            Store.update(this, pc);
            attempt.run();
        }
    }

    /** 그 주소에 있는 것이 정말 연결해 둔 그 PC인지 (저장해 둔 인증서로만 확인한다. 다른 기기가 그 PC인 척 답해도 걸러진다) */
    private static boolean isThatPc(Store.Pc pc, String host, int port) {
        try {
            Net.Result ping = Net.json(host, port, "GET", "/api/ping", null, null, pc.fingerprint, 4000);
            return ping.status == 200 && pc.id.equals(ping.json.optString("id"));
        } catch (Exception e) {
            return false;
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
