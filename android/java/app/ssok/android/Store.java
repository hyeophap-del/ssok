package app.ssok.android;

import android.content.Context;
import android.content.SharedPreferences;
import android.os.Build;
import android.provider.Settings;

import java.util.ArrayList;
import java.util.List;

import org.json.JSONArray;
import org.json.JSONObject;

/** 연결해 둔 PC 목록과 이 앱의 고유 번호를 휴대폰 안에 저장한다. */
final class Store {
    private Store() {}

    static final class Pc {
        String id;
        String name;
        String host;
        int port;
        String fingerprint; // 그 PC의 인증서 지문 (이 인증서가 아니면 보내지 않는다)
        String key; // 그 PC에 보낼 때 내미는 키
        List<String> alts = new ArrayList<>(); // 그 PC의 다른 주소들 (집 Wi-Fi, Tailscale 등). 지금 주소가 안 되면 써 본다.

        JSONObject toJson() throws Exception {
            return new JSONObject().put("id", id).put("name", name).put("host", host).put("port", port).put("fingerprint", fingerprint).put("key", key)
                    .put("alts", new JSONArray(alts));
        }

        /** PC가 알려 준 주소 목록으로 다른 주소들을 갱신한다. 바뀌었으면 true. */
        boolean updateAlts(JSONArray addrs) {
            if (addrs == null) return false;
            List<String> next = new ArrayList<>();
            for (int i = 0; i < addrs.length(); i++) {
                String a = addrs.optString(i);
                if (Net.isValidHost(a) && !a.equals(host) && !next.contains(a)) next.add(a);
            }
            if (next.equals(alts)) return false;
            alts = next;
            return true;
        }

        static Pc fromJson(JSONObject j) {
            Pc pc = new Pc();
            pc.id = j.optString("id");
            pc.name = j.optString("name", "PC");
            pc.host = j.optString("host");
            pc.port = j.optInt("port", Net.DEFAULT_PORT);
            pc.fingerprint = j.optString("fingerprint");
            pc.key = j.optString("key");
            JSONArray alts = j.optJSONArray("alts");
            for (int i = 0; alts != null && i < alts.length(); i++) pc.alts.add(alts.optString(i));
            return pc;
        }
    }

    private static SharedPreferences prefs(Context context) {
        return context.getSharedPreferences("ssok", Context.MODE_PRIVATE);
    }

    /** PC가 이 휴대폰을 알아보는 번호 (16자리) */
    static synchronized String appId(Context context) {
        String id = prefs(context).getString("appId", null);
        if (id == null) {
            id = Net.randomHex(8);
            prefs(context).edit().putString("appId", id).apply();
        }
        return id;
    }

    /** PC 화면에 보일 이 휴대폰 이름 (설정 → 휴대전화 정보의 이름) */
    static String deviceName(Context context) {
        String name = null;
        try {
            name = Settings.Global.getString(context.getContentResolver(), Settings.Global.DEVICE_NAME);
        } catch (Exception ignored) {
            // 일부 기기는 막아 둔다
        }
        if (name == null || name.trim().isEmpty()) name = Build.MODEL;
        name = name.trim();
        return name.length() > 40 ? name.substring(0, 40) : name;
    }

    static synchronized List<Pc> pcs(Context context) {
        List<Pc> list = new ArrayList<>();
        try {
            JSONArray array = new JSONArray(prefs(context).getString("pcs", "[]"));
            for (int i = 0; i < array.length(); i++) list.add(Pc.fromJson(array.getJSONObject(i)));
        } catch (Exception ignored) {
            // 망가진 값이면 빈 목록
        }
        return list;
    }

    static synchronized Pc get(Context context, String id) {
        for (Pc pc : pcs(context)) if (pc.id.equals(id)) return pc;
        return null;
    }

    static synchronized void save(Context context, Pc pc) {
        try {
            JSONArray array = new JSONArray();
            boolean replaced = false;
            for (Pc other : pcs(context)) {
                if (other.id.equals(pc.id)) {
                    array.put(pc.toJson());
                    replaced = true;
                } else {
                    array.put(other.toJson());
                }
            }
            if (!replaced) array.put(pc.toJson());
            prefs(context).edit().putString("pcs", array.toString()).apply();
        } catch (Exception ignored) {
            // JSON 변환 실패는 일어나지 않는다
        }
    }

    static synchronized void remove(Context context, String id) {
        try {
            JSONArray array = new JSONArray();
            for (Pc other : pcs(context)) if (!other.id.equals(id)) array.put(other.toJson());
            prefs(context).edit().putString("pcs", array.toString()).apply();
        } catch (Exception ignored) {
            // JSON 변환 실패는 일어나지 않는다
        }
    }
}
