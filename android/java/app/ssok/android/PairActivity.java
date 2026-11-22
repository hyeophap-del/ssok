package app.ssok.android;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;

import org.json.JSONObject;

/**
 * PC와 연결하기. 순서는 PC끼리 연결할 때와 같다 (src/peer-api.js 참고).
 *  1. PC 인증서를 받아 두고(처음 연결), 봉인한 난수를 보낸다 → PC의 난수를 받는다
 *  2. 6자리 확인 숫자를 띄우고, 난수를 공개한다 → PC 화면에서 [허용]을 누르면 키를 받는다
 */
public class PairActivity extends Activity {
    private LinearLayout column;
    private TextView status;
    private TextView code;
    private TextView detail;
    private ProgressBar spinner;
    private volatile boolean busy;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        column = Ui.page(this);
        Ui.add(column, Ui.title(this, "PC와 연결"), 0);
        status = Ui.body(this, "");
        Ui.add(column, status, 16);
        code = Ui.big(this, "");
        Ui.add(column, code, 20);
        spinner = new ProgressBar(this);
        Ui.add(column, spinner, 16);
        detail = Ui.muted(this, "");
        Ui.add(column, detail, 16);
        handle(getIntent());
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        handle(intent);
    }

    private void handle(Intent intent) {
        Uri uri = intent.getData();
        if (uri == null || busy) return;
        String host = uri.getQueryParameter("host");
        int port;
        try {
            port = Integer.parseInt(uri.getQueryParameter("port"));
        } catch (Exception e) {
            port = Net.DEFAULT_PORT;
        }
        if (!Net.isValidHost(host) || port < 1 || port > 65535) {
            fail("주소가 올바르지 않아요.");
            return;
        }
        confirm(host, port);
    }

    /**
     * 연결하기 전에 묻는다. ssok://pair 링크는 아무 웹사이트나 열 수 있으므로, 사용자가 PC 화면에서 누른 것이 맞을 때만 연결한다.
     */
    private void confirm(String host, int port) {
        status.setText("이 PC와 연결할까요?");
        code.setText("");
        detail.setText("주소: " + host + ":" + port + "\n\nPC의 쏙 화면에서 [앱에 이 PC 연결]을 눌러 열린 것이 맞을 때만 연결하세요. 모르는 웹사이트에서 열렸다면 취소하세요.");
        spinner.setVisibility(android.view.View.GONE);
        final android.view.View[] buttons = new android.view.View[2];
        buttons[0] = Ui.button(this, "연결하기", true, v -> {
            for (android.view.View b : buttons) column.removeView(b);
            if (busy) return;
            busy = true;
            new Thread(() -> pair(host, port)).start();
        });
        buttons[1] = Ui.button(this, "취소", false, v -> finish());
        Ui.add(column, buttons[0], 24);
        Ui.add(column, buttons[1], 8);
    }

    private void pair(String host, int port) {
        show("PC에 연결하는 중…", "", "");
        try {
            // 처음 연결: PC가 내민 인증서를 받아 둔다. 이후 요청은 모두 이 인증서로 고정한다.
            Net.Result ping = Net.json(host, port, "GET", "/api/ping", null, null, null, 5000);
            if (ping.status != 200 || !Net.APP_ID.equals(ping.json.optString("app")) || ping.fingerprint == null) {
                fail("그 주소에서 쏙 프로그램을 찾지 못했어요. PC에서 쏙이 켜져 있는지 확인해 주세요.");
                return;
            }
            String pcId = ping.json.optString("id");
            String pcName = ping.json.optString("name", "PC");
            String fingerprint = ping.fingerprint;
            String appId = Store.appId(this);
            // 이미 연결해 둔 PC와 번호는 같은데 인증서가 다르면, 다른 기기가 그 PC인 척하는 것일 수 있다: 덮어쓰지 않는다
            Store.Pc existing = Store.get(this, pcId);
            if (existing != null && !fingerprint.equals(existing.fingerprint)) {
                fail("이미 연결해 둔 ‘" + existing.name + "’이라고 하는데 보안 인증서가 달라요. 다른 기기가 그 PC인 척하는 것일 수 있어 연결하지 않았어요.\n\n"
                        + "그 PC에 쏙을 새로 설치한 것이 맞다면, 앱 첫 화면에서 그 PC를 [연결 해제]한 뒤 다시 연결해 주세요.");
                return;
            }

            String na = Net.randomHex(16);
            JSONObject start = new JSONObject()
                    .put("id", appId)
                    .put("name", Store.deviceName(this))
                    .put("kind", "app")
                    .put("commit", Net.sha256Hex(na));
            Net.Result first = Net.json(host, port, "POST", "/api/pair/start", start, null, fingerprint, 10000);
            if (first.status != 200) {
                fail(first.status == 409 ? "PC에서 다른 연결 요청을 처리하는 중이에요. 잠시 뒤 다시 시도해 주세요." : first.json.optString("error", "연결하지 못했어요."));
                return;
            }
            String pairCode = Net.pairCode("app:" + appId, fingerprint, na, first.json.optString("nb"));
            show(pcName + " 화면에 아래 숫자가 떴는지 확인하고, PC에서 [허용]을 눌러 주세요.", Net.formatCode(pairCode),
                    "숫자가 다르면 누군가 중간에 끼어든 것일 수 있어요. 그때는 PC에서 거절하세요.");

            Net.Result second = Net.json(host, port, "POST", "/api/pair/finish", new JSONObject().put("id", appId).put("na", na), null, fingerprint, 90000);
            if (second.status == 200 && second.json.optString("key").length() >= 20) {
                Store.Pc pc = new Store.Pc();
                pc.id = pcId;
                pc.name = pcName;
                pc.host = host;
                pc.port = port;
                pc.fingerprint = fingerprint;
                pc.key = second.json.optString("key");
                pc.updateAlts(ping.json.optJSONArray("addrs")); // 집 Wi-Fi·Tailscale 주소를 함께 기억한다
                pc.updateRelay(second.json); // PC가 중계 서버를 쓰면 집 밖에서도 그 서버로 보낸다
                Store.save(this, pc);
                done(pcName + "에 연결했어요!", "이제 갤러리에서 보낼 것을 고르고 공유 → 쏙을 누르면 바로 " + pcName + "(으)로 가요.");
            } else if (second.status == 403) {
                fail("PC에서 거절했어요.");
            } else if (second.status == 408) {
                fail("PC에서 응답이 없어 취소됐어요. PC의 쏙 화면을 연 채로 다시 시도해 주세요.");
            } else {
                fail(second.json.optString("error", "연결하지 못했어요. 다시 시도해 주세요."));
            }
        } catch (Exception e) {
            fail("PC에 연결하지 못했어요. 휴대폰과 PC가 같은 Wi-Fi에 있는지 확인해 주세요.\n\n(원인: " + Net.describe(e) + ")");
        } finally {
            busy = false;
        }
    }

    private void show(String message, String codeText, String detailText) {
        runOnUiThread(() -> {
            status.setText(message);
            code.setText(codeText);
            detail.setText(detailText);
            spinner.setVisibility(android.view.View.VISIBLE);
        });
    }

    private void done(String message, String detailText) {
        runOnUiThread(() -> {
            status.setText(message);
            code.setText("✓");
            detail.setText(detailText);
            spinner.setVisibility(android.view.View.GONE);
            Ui.add(column, Ui.button(this, "확인", true, v -> {
                startActivity(new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP));
                finish();
            }), 24);
        });
    }

    private void fail(String message) {
        runOnUiThread(() -> {
            status.setText(message);
            code.setText("");
            detail.setText("");
            spinner.setVisibility(android.view.View.GONE);
            Ui.add(column, Ui.button(this, "닫기", false, v -> finish()), 24);
        });
    }
}
