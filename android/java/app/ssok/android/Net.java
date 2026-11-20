package app.ssok.android;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.DatagramPacket;
import java.net.DatagramSocket;
import java.net.InetAddress;
import java.net.SocketTimeoutException;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.security.cert.CertificateException;
import java.security.cert.X509Certificate;
import java.util.regex.Pattern;

import javax.net.ssl.HttpsURLConnection;
import javax.net.ssl.SSLContext;
import javax.net.ssl.TrustManager;
import javax.net.ssl.X509TrustManager;

import org.json.JSONObject;

/**
 * PC의 쏙 프로그램과 주고받는 암호화(HTTPS) 요청.
 * PC는 스스로 만든 인증서를 쓰므로, 처음 연결할 때 받은 인증서의 지문을 기억해 두고 그 뒤로는 그 인증서만 믿는다.
 */
final class Net {
    static final String APP_ID = "ssok";
    static final int DEFAULT_PORT = 8765;
    private static final Pattern HOST = Pattern.compile("^[A-Za-z0-9.-]{1,253}$");
    private static final SecureRandom RANDOM = new SecureRandom();

    private Net() {}

    static final class Result {
        int status;
        JSONObject json;
        String fingerprint;
    }

    static boolean isValidHost(String host) {
        return host != null && HOST.matcher(host).matches();
    }

    /** 인증서 지문 "AB:CD:..." (PC 쪽 Node.js의 fingerprint256과 같은 형식) */
    static String fingerprint(X509Certificate cert) throws Exception {
        byte[] digest = MessageDigest.getInstance("SHA-256").digest(cert.getEncoded());
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < digest.length; i++) {
            if (i > 0) sb.append(':');
            sb.append(String.format("%02X", digest[i] & 0xff));
        }
        return sb.toString();
    }

    static String sha256Hex(String text) throws Exception {
        byte[] digest = MessageDigest.getInstance("SHA-256").digest(text.getBytes(StandardCharsets.UTF_8));
        StringBuilder sb = new StringBuilder();
        for (byte b : digest) sb.append(String.format("%02x", b & 0xff));
        return sb.toString();
    }

    static String randomHex(int bytes) {
        byte[] buf = new byte[bytes];
        RANDOM.nextBytes(buf);
        StringBuilder sb = new StringBuilder();
        for (byte b : buf) sb.append(String.format("%02x", b & 0xff));
        return sb.toString();
    }

    /** 두 화면에 띄워 맞춰 보는 6자리 숫자. PC 쪽(src/peers.js의 pairCode)과 똑같이 계산한다. */
    static String pairCode(String initiator, String responderFingerprint, String initiatorNonce, String responderNonce) throws Exception {
        String input = APP_ID + "-pair\n" + initiator + "\n" + responderFingerprint + "\n" + initiatorNonce + "\n" + responderNonce;
        byte[] d = MessageDigest.getInstance("SHA-256").digest(input.getBytes(StandardCharsets.UTF_8));
        long value = ((d[0] & 0xffL) << 24) | ((d[1] & 0xffL) << 16) | ((d[2] & 0xffL) << 8) | (d[3] & 0xffL);
        return String.format("%06d", value % 1_000_000L);
    }

    /** 문제를 찾을 때 보여 줄 오류 원인 한 줄 (가장 안쪽 원인까지 따라간다) */
    static String describe(Throwable error) {
        Throwable root = error;
        while (root.getCause() != null && root.getCause() != root) root = root.getCause();
        String text = root.getClass().getSimpleName() + (root.getMessage() != null ? ": " + root.getMessage() : "");
        return text.length() > 160 ? text.substring(0, 160) + "…" : text;
    }

    static String formatCode(String code) {
        return code.length() == 6 ? code.substring(0, 3) + " " + code.substring(3) : code;
    }

    /** pin이 없으면 어떤 인증서든 받고 지문을 기록한다(처음 연결할 때). 있으면 그 지문이 아닌 인증서는 거부한다. */
    static final class PinningTrustManager implements X509TrustManager {
        private final String pin;
        volatile String seen;

        PinningTrustManager(String pin) {
            this.pin = pin;
        }

        @Override
        public void checkClientTrusted(X509Certificate[] chain, String authType) throws CertificateException {
            throw new CertificateException("not used");
        }

        @Override
        public void checkServerTrusted(X509Certificate[] chain, String authType) throws CertificateException {
            if (chain == null || chain.length == 0) throw new CertificateException("인증서가 없어요");
            try {
                seen = fingerprint(chain[0]);
            } catch (Exception e) {
                throw new CertificateException(e);
            }
            if (pin != null && !pin.equals(seen)) throw new CertificateException("PC의 인증서가 달라요");
        }

        @Override
        public X509Certificate[] getAcceptedIssuers() {
            return new X509Certificate[0];
        }
    }

    static HttpsURLConnection open(String host, int port, String path, String pin, PinningTrustManager[] trustOut) throws Exception {
        PinningTrustManager trust = new PinningTrustManager(pin);
        SSLContext context = SSLContext.getInstance("TLS");
        context.init(null, new TrustManager[] {trust}, RANDOM);
        HttpsURLConnection c = (HttpsURLConnection) new URL("https", host, port, path).openConnection();
        c.setSSLSocketFactory(context.getSocketFactory());
        // IP 주소로 접속하므로 이름 대신 위의 인증서 지문으로 상대를 확인한다
        c.setHostnameVerifier((hostname, session) -> true);
        c.setUseCaches(false);
        c.setRequestProperty("X-Requested-With", APP_ID);
        if (trustOut != null) trustOut[0] = trust;
        return c;
    }

    static Result json(String host, int port, String method, String path, JSONObject body, String bearer, String pin, int readTimeoutMs) throws Exception {
        PinningTrustManager[] trust = new PinningTrustManager[1];
        HttpsURLConnection c = open(host, port, path, pin, trust);
        try {
            c.setConnectTimeout(5000);
            c.setReadTimeout(readTimeoutMs);
            c.setRequestMethod(method);
            if (bearer != null) c.setRequestProperty("Authorization", "Bearer " + bearer);
            if (body != null) {
                byte[] bytes = body.toString().getBytes(StandardCharsets.UTF_8);
                c.setDoOutput(true);
                c.setRequestProperty("Content-Type", "application/json");
                c.setFixedLengthStreamingMode(bytes.length);
                try (OutputStream out = c.getOutputStream()) {
                    out.write(bytes);
                }
            }
            Result result = new Result();
            result.status = c.getResponseCode();
            result.fingerprint = trust[0].seen;
            InputStream in = result.status >= 400 ? c.getErrorStream() : c.getInputStream();
            String text = in == null ? "" : readAll(in);
            try {
                result.json = new JSONObject(text);
            } catch (Exception e) {
                result.json = new JSONObject();
            }
            return result;
        } finally {
            c.disconnect();
        }
    }

    static String readAll(InputStream in) throws IOException {
        try (InputStream stream = in) {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            int n;
            while ((n = stream.read(buf)) > 0 && out.size() < 64 * 1024) out.write(buf, 0, n);
            return out.toString("UTF-8");
        }
    }

    /**
     * 같은 Wi-Fi에서 그 PC를 다시 찾는다 (PC의 IP가 바뀌었을 때).
     * 누구나 답할 수 있으므로, 찾은 주소는 반드시 인증서를 고정한 연결로 다시 확인해서 쓴다.
     * @return {주소, 포트} 또는 못 찾으면 null
     */
    static String[] find(String pcId, int timeoutMs) {
        try (DatagramSocket socket = new DatagramSocket()) {
            socket.setBroadcast(true);
            socket.setSoTimeout(400);
            byte[] message = new JSONObject().put("app", APP_ID).put("v", 1).put("t", "find").toString().getBytes(StandardCharsets.UTF_8);
            DatagramPacket hello = new DatagramPacket(message, message.length, InetAddress.getByName("255.255.255.255"), DEFAULT_PORT);
            long end = System.currentTimeMillis() + timeoutMs;
            long nextSend = 0;
            byte[] buf = new byte[1024];
            while (System.currentTimeMillis() < end) {
                if (System.currentTimeMillis() >= nextSend) {
                    socket.send(hello);
                    nextSend = System.currentTimeMillis() + 800;
                }
                DatagramPacket packet = new DatagramPacket(buf, buf.length);
                try {
                    socket.receive(packet);
                } catch (SocketTimeoutException e) {
                    continue;
                }
                try {
                    JSONObject reply = new JSONObject(new String(packet.getData(), 0, packet.getLength(), StandardCharsets.UTF_8));
                    if (APP_ID.equals(reply.optString("app")) && "here".equals(reply.optString("t")) && pcId.equals(reply.optString("id"))) {
                        return new String[] {packet.getAddress().getHostAddress(), String.valueOf(reply.optInt("port", DEFAULT_PORT))};
                    }
                } catch (Exception ignored) {
                    // 다른 프로그램의 메시지
                }
            }
        } catch (Exception ignored) {
            // Wi-Fi가 꺼져 있는 등
        }
        return null;
    }
}
