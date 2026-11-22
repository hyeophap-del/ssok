package app.ssok.android;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.ClipData;
import android.content.ContentResolver;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.widget.Toast;

import java.util.ArrayList;
import java.util.List;

/** 공유 메뉴에서 '쏙'을 눌렀을 때. 보낼 PC를 정하고 UploadService에 넘긴 뒤 바로 닫힌다. */
public class ShareActivity extends Activity {
    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        Intent intent = getIntent();
        ArrayList<Uri> uris = new ArrayList<>();
        String text = null;

        if (Intent.ACTION_SEND.equals(intent.getAction())) {
            Uri uri = stream(intent);
            if (uri != null) uris.add(uri);
            else {
                // 서식 있는 글자(굵게 등)를 보내는 앱도 있어 CharSequence로 받는다
                CharSequence shared = intent.getCharSequenceExtra(Intent.EXTRA_TEXT);
                text = shared == null ? null : shared.toString();
            }
        } else if (Intent.ACTION_SEND_MULTIPLE.equals(intent.getAction())) {
            ArrayList<Uri> list = streams(intent);
            if (list != null) uris.addAll(list);
        }
        // 다른 앱이 건넨 파일은 content:// 만 받는다. file://은 이 앱의 권한으로 열리므로 이 앱의 설정 파일(PC 열쇠)을 가리킬 수 있다.
        int before = uris.size();
        uris.removeIf(u -> u == null || !ContentResolver.SCHEME_CONTENT.equals(u.getScheme()));
        if (uris.size() < before) Toast.makeText(this, "보낼 수 없는 형식의 파일은 뺐어요", Toast.LENGTH_SHORT).show();
        if (uris.isEmpty() && (text == null || text.trim().isEmpty())) {
            Toast.makeText(this, "보낼 내용이 없어요", Toast.LENGTH_SHORT).show();
            finish();
            return;
        }

        List<Store.Pc> pcs = Store.pcs(this);
        if (pcs.isEmpty()) {
            Toast.makeText(this, "먼저 PC와 연결해 주세요", Toast.LENGTH_LONG).show();
            startActivity(new Intent(this, MainActivity.class));
            finish();
            return;
        }
        final String sharedText = text;
        if (pcs.size() == 1) {
            send(pcs.get(0), uris, sharedText);
            return;
        }
        String[] names = new String[pcs.size()];
        for (int i = 0; i < names.length; i++) names[i] = pcs.get(i).name;
        new AlertDialog.Builder(this)
                .setTitle("어느 PC로 보낼까요?")
                .setItems(names, (d, which) -> send(pcs.get(which), uris, sharedText))
                .setOnCancelListener(d -> finish())
                .show();
    }

    @SuppressWarnings("deprecation")
    private static Uri stream(Intent intent) {
        if (Build.VERSION.SDK_INT >= 33) return intent.getParcelableExtra(Intent.EXTRA_STREAM, Uri.class);
        return intent.getParcelableExtra(Intent.EXTRA_STREAM);
    }

    @SuppressWarnings("deprecation")
    private static ArrayList<Uri> streams(Intent intent) {
        if (Build.VERSION.SDK_INT >= 33) return intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM, Uri.class);
        return intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM);
    }

    private void send(Store.Pc pc, ArrayList<Uri> uris, String text) {
        Intent service = new Intent(this, UploadService.class)
                .putExtra(UploadService.EXTRA_PC, pc.id)
                .putParcelableArrayListExtra(UploadService.EXTRA_URIS, uris)
                .putExtra(UploadService.EXTRA_TEXT, text);
        if (!uris.isEmpty()) {
            // 받은 파일을 읽을 권한을 보내는 서비스에도 넘겨준다
            ClipData clip = ClipData.newRawUri("", uris.get(0));
            for (int i = 1; i < uris.size(); i++) clip.addItem(new ClipData.Item(uris.get(i)));
            service.setClipData(clip);
            service.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        }
        startForegroundService(service);
        String what = uris.isEmpty() ? "텍스트를" : uris.size() == 1 ? "파일을" : "파일 " + uris.size() + "개를";
        Toast.makeText(this, pc.name + "(으)로 " + what + " 보내요", Toast.LENGTH_SHORT).show();
        finish();
    }
}
