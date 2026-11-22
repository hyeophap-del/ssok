package app.ssok.android;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.text.InputType;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.Toast;

import java.util.List;

/** 연결된 PC 목록과 사용법 */
public class MainActivity extends Activity {
    private LinearLayout column;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        column = Ui.page(this);
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            // 보내는 중 진행률과 결과를 알림으로 보여 준다
            requestPermissions(new String[] {Manifest.permission.POST_NOTIFICATIONS}, 1);
        }
    }

    @Override
    protected void onResume() {
        super.onResume();
        render();
        checkAppUpdate();
    }

    /** 연결된 PC가 더 새 버전의 앱을 갖고 있으면 알려 준다 (PC를 업데이트하면 새 앱도 함께 들어온다) */
    private void checkAppUpdate() {
        final List<Store.Pc> pcs = Store.pcs(this);
        if (pcs.isEmpty()) return;
        final long mine = myVersionCode();
        new Thread(() -> {
            for (Store.Pc pc : pcs) {
                try {
                    Net.Result ping = Net.json(pc.host, pc.port, "GET", "/api/ping", null, null, pc.fingerprint, 4000);
                    // PC에 Tailscale을 나중에 깔았거나 주소가 바뀌었으면 알아 둔다
                    if (ping.status == 200 && pc.updateAlts(ping.json.optJSONArray("addrs"))) Store.update(this, pc);
                    // PC에서 '어디서나 (중계 서버)'를 켜거나 바꿨으면 알아 둔다
                    if (ping.status == 200) {
                        Net.Result info = Net.json(pc.host, pc.port, "GET", "/api/peer/info", null, pc.key, pc.fingerprint, 4000);
                        if (info.status == 200 && pc.updateRelay(info.json)) {
                            Store.update(this, pc);
                            runOnUiThread(this::render);
                        }
                    }
                    if (ping.status == 200 && ping.json.optInt("android", 0) > mine) {
                        runOnUiThread(() -> showAppUpdate(pc));
                        return;
                    }
                } catch (Exception ignored) {
                    // PC가 꺼져 있다
                }
            }
        }).start();
    }

    @SuppressWarnings("deprecation")
    private long myVersionCode() {
        try {
            android.content.pm.PackageInfo info = getPackageManager().getPackageInfo(getPackageName(), 0);
            return Build.VERSION.SDK_INT >= 28 ? info.getLongVersionCode() : info.versionCode;
        } catch (Exception e) {
            return Long.MAX_VALUE;
        }
    }

    private void showAppUpdate(Store.Pc pc) {
        LinearLayout card = Ui.card(this);
        Ui.add(card, Ui.heading(this, "새 버전 앱이 있어요"), 0);
        Ui.add(card, Ui.muted(this, pc.name + "에서 받아 바로 설치해요. 연결은 그대로 남아요."), 4);
        final android.widget.Button[] button = new android.widget.Button[1];
        button[0] = Ui.button(this, "새 버전 받기", true, v -> installUpdate(pc, button[0]));
        Ui.add(card, button[0], 12);
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        params.topMargin = Ui.dp(this, 16);
        column.addView(card, 2, params);
    }

    /**
     * 새 버전 앱을 연결해 둔 PC에서 받는다. 같은 Wi-Fi의 다른 기기가 바꿔치기하지 못하게 PC 인증서로 고정한 HTTPS로 받고,
     * 이 앱(같은 패키지)의 더 높은 버전인지 확인한 뒤 안드로이드 설치기에 넘긴다 (서명이 다르면 설치기가 거절한다).
     */
    private void installUpdate(Store.Pc pc, android.widget.Button button) {
        if (Build.VERSION.SDK_INT >= 26 && !getPackageManager().canRequestPackageInstalls()) {
            android.widget.Toast.makeText(this, "‘쏙’이 앱을 설치할 수 있게 허용한 뒤, 돌아와서 다시 눌러 주세요.", android.widget.Toast.LENGTH_LONG).show();
            startActivity(new Intent(android.provider.Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + getPackageName())));
            return;
        }
        button.setEnabled(false);
        button.setText("받는 중…");
        new Thread(() -> {
            java.io.File apk = new java.io.File(getCacheDir(), "update.apk");
            try {
                javax.net.ssl.HttpsURLConnection c = Net.open(pc.host, pc.port, "/" + Net.APP_ID + ".apk", pc.fingerprint, null);
                try {
                    c.setConnectTimeout(5000);
                    c.setReadTimeout(30000);
                    if (c.getResponseCode() != 200) throw new java.io.IOException("PC에서 새 버전을 찾지 못했어요.");
                    try (java.io.InputStream in = c.getInputStream(); java.io.OutputStream out = new java.io.FileOutputStream(apk)) {
                        copyAll(in, out);
                    }
                } finally {
                    c.disconnect();
                }
                android.content.pm.PackageInfo info = getPackageManager().getPackageArchiveInfo(apk.getPath(), 0);
                long code = info == null ? -1 : Build.VERSION.SDK_INT >= 28 ? info.getLongVersionCode() : info.versionCode;
                if (info == null || !getPackageName().equals(info.packageName) || code <= myVersionCode()) {
                    throw new java.io.IOException("받은 파일이 이 앱의 새 버전이 아니에요.");
                }
                android.content.pm.PackageInstaller installer = getPackageManager().getPackageInstaller();
                android.content.pm.PackageInstaller.SessionParams params =
                        new android.content.pm.PackageInstaller.SessionParams(android.content.pm.PackageInstaller.SessionParams.MODE_FULL_INSTALL);
                params.setAppPackageName(getPackageName());
                int sessionId = installer.createSession(params);
                try (android.content.pm.PackageInstaller.Session session = installer.openSession(sessionId)) {
                    try (java.io.InputStream in = new java.io.FileInputStream(apk); java.io.OutputStream out = session.openWrite("ssok.apk", 0, apk.length())) {
                        copyAll(in, out);
                        session.fsync(out);
                    }
                    int flags = android.app.PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= 31 ? android.app.PendingIntent.FLAG_MUTABLE : 0);
                    android.app.PendingIntent done = android.app.PendingIntent.getBroadcast(this, sessionId, new Intent(this, InstallResult.class), flags);
                    session.commit(done.getIntentSender());
                }
                runOnUiThread(() -> button.setText("설치 화면을 여는 중…"));
            } catch (Exception e) {
                apk.delete();
                runOnUiThread(() -> {
                    button.setEnabled(true);
                    button.setText("새 버전 받기");
                    android.widget.Toast.makeText(this, "새 버전을 받지 못했어요. " + Net.describe(e), android.widget.Toast.LENGTH_LONG).show();
                });
            }
        }).start();
    }

    private static void copyAll(java.io.InputStream in, java.io.OutputStream out) throws java.io.IOException {
        byte[] buf = new byte[64 * 1024];
        int n;
        while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
    }

    private void render() {
        column.removeAllViews();
        Ui.add(column, Ui.title(this, getString(R.string.app_name)), 0);
        Ui.add(column, Ui.muted(this, "휴대폰에서 PC로 파일을 바로 보내요"), 4);

        List<Store.Pc> pcs = Store.pcs(this);
        LinearLayout how = Ui.card(this);
        if (pcs.isEmpty()) {
            Ui.add(how, Ui.heading(this, "PC와 연결하기"), 0);
            Ui.add(how, Ui.body(this,
                    "1. PC에서 쏙 프로그램을 켜요.\n"
                            + "2. 휴대폰 카메라로 PC 화면의 QR 코드를 찍어요.\n"
                            + "3. 열린 화면에서 [앱에 이 PC 연결]을 누르고, PC 화면의 6자리 숫자와 같으면 PC에서 [허용]을 눌러요."), 8);
        } else {
            Ui.add(how, Ui.heading(this, "보내는 방법"), 0);
            Ui.add(how, Ui.body(this,
                    "갤러리나 파일 앱에서 보낼 것을 고르고 공유 → 쏙을 누르세요.\n"
                            + "화면이 꺼져도 끝까지 보내고, 다 보내면 알림으로 알려 줘요."), 8);
        }
        Ui.add(column, how, 20);

        if (!pcs.isEmpty()) {
            Ui.add(column, Ui.heading(this, "연결된 PC"), 24);
            for (Store.Pc pc : pcs) {
                LinearLayout card = Ui.card(this);
                Ui.add(card, Ui.heading(this, pc.name), 0);
                Ui.add(card, Ui.muted(this, pc.host + (pc.port == Net.DEFAULT_PORT ? "" : ":" + pc.port) + " · 암호화 연결"), 2);
                Ui.add(card, Ui.muted(this, pc.relay.isEmpty()
                        ? "집 밖에서 보내려면 PC [설정]에서 ‘어디서나 (중계 서버)’를 켜고, 같은 Wi-Fi에서 이 앱을 한 번 열어 주세요."
                        : "어디서나: 집 밖에서는 " + pc.relay.replaceFirst("^https://", "") + "를 거쳐 보내요"), 2);
                Ui.add(card, Ui.button(this, "연결 해제", false, v -> confirmUnpair(pc)), 12);
                Ui.add(column, card, 8);
            }
        }

        Ui.add(column, Ui.button(this, pcs.isEmpty() ? "PC 주소로 직접 연결" : "다른 PC 연결", false, v -> askAddress()), 24);
        Ui.add(column, Ui.muted(this, "QR 코드 아래에 적힌 주소(예: 192.168.0.32)를 넣으면 돼요."), 6);
    }

    private void askAddress() {
        EditText input = new EditText(this);
        input.setHint("192.168.0.32");
        input.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        int pad = Ui.dp(this, 20);
        LinearLayout box = new LinearLayout(this);
        box.setPadding(pad, Ui.dp(this, 8), pad, 0);
        box.addView(input, new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT));
        new AlertDialog.Builder(this)
                .setTitle("PC 주소")
                .setView(box)
                .setPositiveButton("연결", (d, w) -> {
                    String text = input.getText().toString().trim().replaceFirst("^https?://", "").replaceFirst("/.*$", "");
                    String host = text;
                    String port = String.valueOf(Net.DEFAULT_PORT);
                    int colon = text.lastIndexOf(':');
                    if (colon > 0) {
                        host = text.substring(0, colon);
                        port = text.substring(colon + 1);
                    }
                    if (!Net.isValidHost(host) || !port.matches("\\d{1,5}")) {
                        Toast.makeText(this, "주소를 확인해 주세요", Toast.LENGTH_SHORT).show();
                        return;
                    }
                    Uri uri = new Uri.Builder().scheme("ssok").authority("pair").appendQueryParameter("host", host).appendQueryParameter("port", port).build();
                    startActivity(new Intent(Intent.ACTION_VIEW, uri, this, PairActivity.class));
                })
                .setNegativeButton("취소", null)
                .show();
    }

    private void confirmUnpair(Store.Pc pc) {
        new AlertDialog.Builder(this)
                .setTitle(pc.name + " 연결 해제")
                .setMessage("다시 보내려면 처음처럼 연결해야 해요.")
                .setPositiveButton("해제", (d, w) -> {
                    Store.remove(this, pc.id);
                    render();
                    // PC에도 알린다 (꺼져 있으면 나중에 PC에서 지워도 된다)
                    new Thread(() -> {
                        try {
                            Net.json(pc.host, pc.port, "POST", "/api/peer/unpair", null, pc.key, pc.fingerprint, 5000);
                        } catch (Exception ignored) {
                            // 같은 Wi-Fi에 없으면 중계 서버로 알린다
                            if (!pc.relay.isEmpty()) {
                                try (Relay relay = Relay.connect(pc.relay, pc.id, Store.appId(this), Relay.peerSecret(pc.key), Store.deviceName(this), 10000)) {
                                    java.util.Map<String, String> headers = new java.util.HashMap<>();
                                    headers.put("x-requested-with", Net.APP_ID);
                                    relay.request("POST", "/api/peer/unpair", headers, null, 0, null);
                                } catch (Exception alsoIgnored) {
                                    // PC가 꺼져 있다 (나중에 PC에서 지워도 된다)
                                }
                            }
                        }
                    }).start();
                })
                .setNegativeButton("취소", null)
                .show();
    }
}
