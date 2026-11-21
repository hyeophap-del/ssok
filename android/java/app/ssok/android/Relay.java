package app.ssok.android;

import java.io.ByteArrayOutputStream;
import java.io.Closeable;
import java.io.DataInputStream;
import java.io.EOFException;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.net.URI;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.Base64;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import javax.crypto.Cipher;
import javax.crypto.Mac;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;
import javax.net.ssl.SNIHostName;
import javax.net.ssl.SSLParameters;
import javax.net.ssl.SSLSocket;
import javax.net.ssl.SSLSocketFactory;

/**
 * 집 밖에서 PC의 중계 서버(예: https://ssok.example.com)를 거쳐 PC로 보낸다.
 * PC 쪽 public/relay.js와 같은 약속을 따른다:
 *   1. 웹소켓으로 /ws/c/&lt;PC 번호&gt; 에 붙어, 난수와 이 앱의 번호(kid)를 담은 인사를 주고받는다
 *   2. 연결할 때 받은 키에서 만든 비밀 값과 두 난수로 방향별 AES-GCM 열쇠를 만든다 (HKDF-SHA256)
 *   3. 그 뒤로는 모든 메시지를 암호화한다. 중계 서버는 내용을 볼 수 없다.
 * Android에 의존하지 않는 Java로 써서 PC에서도 시험할 수 있다.
 */
final class Relay implements Closeable {
    static final int REQ_HEAD = 1, REQ_DATA = 2, REQ_END = 3, RES_HEAD = 4, RES_DATA = 5, RES_END = 6, CANCEL = 7, AUTH = 8, AUTH_OK = 9;
    private static final int CHUNK = 64 * 1024;
    private static final String GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
    private static final SecureRandom RANDOM = new SecureRandom();

    /** 중계 서버나 PC가 알려 준 이유 (PC_OFFLINE: PC가 꺼짐, UNKNOWN_PEER: PC에서 연결을 해제함 등) */
    static final class RelayException extends IOException {
        final String code;

        RelayException(String code, String message) {
            super(message);
            this.code = code;
        }
    }

    static final class Response {
        int status;
        String body;
    }

    interface Progress {
        void update(long done);
    }

    private final Socket socket;
    private final DataInputStream in;
    private final OutputStream out;
    private SecretKeySpec sendKey;
    private SecretKeySpec recvKey;
    private long sendCounter;
    private long recvCounter;
    private int nextId = 1;

    private Relay(Socket socket) throws IOException {
        this.socket = socket;
        this.in = new DataInputStream(socket.getInputStream());
        this.out = socket.getOutputStream();
    }

    /** 연결할 때 받은 키에서 통로의 비밀 값을 만든다 (PC 쪽 src/peers.js의 peerRelaySecret과 같다) */
    static byte[] peerSecret(String key) throws Exception {
        return MessageDigest.getInstance("SHA-256").digest(("ssok-peer-relay-v1:" + key).getBytes(StandardCharsets.UTF_8));
    }

    /** 'https://ssok.example.com' 꼴만 받는다 (시험용으로 이 기기 안의 http 주소도) */
    static boolean isValidRelayUrl(String url) {
        return url != null && url.matches("^https://[A-Za-z0-9.-]+(:\\d{1,5})?$");
    }

    /**
     * PC로 가는 암호화 통로를 연다.
     * @param kid 이 앱의 번호 (PC가 어느 기기의 열쇠로 풀지 고른다)
     */
    static Relay connect(String relayUrl, String pcId, String kid, byte[] secret, String device, int timeoutMs) throws Exception {
        URI uri = URI.create(relayUrl);
        boolean secure = "https".equals(uri.getScheme());
        if (!secure && !("http".equals(uri.getScheme()) && ("127.0.0.1".equals(uri.getHost()) || "localhost".equals(uri.getHost())))) {
            throw new IOException("중계 서버 주소가 올바르지 않아요");
        }
        String host = uri.getHost();
        int port = uri.getPort() > 0 ? uri.getPort() : (secure ? 443 : 80);
        Socket raw = new Socket();
        raw.connect(new InetSocketAddress(host, port), timeoutMs);
        Socket socket = raw;
        if (secure) {
            // 중계 서버는 공인 인증서(Cloudflare)를 쓴다: 휴대폰이 믿는 인증서인지, 주소 이름이 맞는지 확인한다
            SSLSocket ssl = (SSLSocket) ((SSLSocketFactory) SSLSocketFactory.getDefault()).createSocket(raw, host, port, true);
            SSLParameters params = ssl.getSSLParameters();
            params.setEndpointIdentificationAlgorithm("HTTPS");
            params.setServerNames(java.util.Collections.singletonList(new SNIHostName(host)));
            ssl.setSSLParameters(params);
            ssl.startHandshake();
            socket = ssl;
        }
        socket.setSoTimeout(timeoutMs);
        Relay relay = new Relay(socket);
        try {
            relay.handshake(host + (uri.getPort() > 0 ? ":" + uri.getPort() : ""), "/ws/c/" + pcId);
            relay.hello(kid, secret, device);
            socket.setSoTimeout(60_000);
            return relay;
        } catch (Exception e) {
            relay.close();
            throw e;
        }
    }

    // ---- 웹소켓 ----

    private void handshake(String hostHeader, String path) throws Exception {
        byte[] nonce = new byte[16];
        RANDOM.nextBytes(nonce);
        String key = Base64.getEncoder().encodeToString(nonce);
        String request = "GET " + path + " HTTP/1.1\r\nHost: " + hostHeader + "\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
                + "Sec-WebSocket-Key: " + key + "\r\nSec-WebSocket-Version: 13\r\nUser-Agent: ssok-android\r\n\r\n";
        out.write(request.getBytes(StandardCharsets.US_ASCII));
        out.flush();
        ByteArrayOutputStream head = new ByteArrayOutputStream();
        int matched = 0;
        while (matched < 4) {
            int b = in.read();
            if (b < 0) throw new EOFException("중계 서버가 연결을 끊었어요");
            head.write(b);
            matched = (b == (matched % 2 == 0 ? '\r' : '\n')) ? matched + 1 : (b == '\r' ? 1 : 0);
            if (head.size() > 16 * 1024) throw new IOException("응답이 너무 길어요");
        }
        String response = head.toString("ISO-8859-1");
        if (!response.startsWith("HTTP/1.1 101")) throw new IOException("중계 서버에 연결하지 못했어요 (" + response.split("\r\n")[0] + ")");
        String expected = Base64.getEncoder().encodeToString(MessageDigest.getInstance("SHA-1").digest((key + GUID).getBytes(StandardCharsets.US_ASCII)));
        if (!response.toLowerCase().contains("sec-websocket-accept: " + expected.toLowerCase())) throw new IOException("중계 서버의 응답이 올바르지 않아요");
    }

    private void sendFrame(int opcode, byte[] data) throws IOException {
        ByteArrayOutputStream frame = new ByteArrayOutputStream(data.length + 14);
        frame.write(0x80 | opcode);
        if (data.length < 126) frame.write(0x80 | data.length);
        else if (data.length < 65536) {
            frame.write(0x80 | 126);
            frame.write(data.length >> 8);
            frame.write(data.length & 0xff);
        } else {
            frame.write(0x80 | 127);
            frame.write(ByteBuffer.allocate(8).putLong(data.length).array(), 0, 8);
        }
        byte[] mask = new byte[4];
        RANDOM.nextBytes(mask);
        frame.write(mask, 0, 4);
        byte[] masked = new byte[data.length];
        for (int i = 0; i < data.length; i++) masked[i] = (byte) (data[i] ^ mask[i & 3]);
        frame.write(masked, 0, masked.length);
        synchronized (out) {
            frame.writeTo(out);
            out.flush();
        }
    }

    /** 메시지 하나를 받는다. [0] = 1(글자) 또는 2(바이트), 내용은 message에 */
    private int readMessage(ByteArrayOutputStream message) throws IOException {
        message.reset();
        int type = 0;
        while (true) {
            int b0 = in.readUnsignedByte();
            int b1 = in.readUnsignedByte();
            boolean fin = (b0 & 0x80) != 0;
            int opcode = b0 & 0x0f;
            long length = b1 & 0x7f;
            if (length == 126) length = in.readUnsignedShort();
            else if (length == 127) length = in.readLong();
            if (length > 8 * 1024 * 1024) throw new IOException("메시지가 너무 커요");
            byte[] mask = null;
            if ((b1 & 0x80) != 0) {
                mask = new byte[4];
                in.readFully(mask);
            }
            byte[] payload = new byte[(int) length];
            in.readFully(payload);
            if (mask != null) for (int i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
            if (opcode == 0x8) throw new RelayException(closeCode(payload) == 4004 ? "PC_OFFLINE" : "CLOSED", "연결이 끊겼어요");
            if (opcode == 0x9) {
                sendFrame(0xA, payload); // ping → pong
                continue;
            }
            if (opcode == 0xA) continue;
            if (opcode == 0x1 || opcode == 0x2) type = opcode;
            message.write(payload, 0, payload.length);
            if (fin) return type;
        }
    }

    private static int closeCode(byte[] payload) {
        return payload.length >= 2 ? ((payload[0] & 0xff) << 8) | (payload[1] & 0xff) : 0;
    }

    // ---- 암호화 통로 ----

    private void hello(String kid, byte[] secret, String device) throws Exception {
        byte[] myNonce = new byte[16];
        RANDOM.nextBytes(myNonce);
        String hello = "{\"t\":\"hello\",\"v\":1,\"n\":\"" + hex(myNonce) + "\",\"device\":" + quote(device) + ",\"kid\":" + quote(kid) + "}";
        sendFrame(0x1, hello.getBytes(StandardCharsets.UTF_8));
        ByteArrayOutputStream message = new ByteArrayOutputStream();
        while (true) {
            int type = readMessage(message);
            if (type != 1) throw new IOException("인사 전에 암호 메시지가 왔어요");
            String text = message.toString("UTF-8");
            checkError(text);
            if (!"hello".equals(field(text, "t"))) continue;
            byte[] theirNonce = unhex(field(text, "n"));
            if (theirNonce.length != 16) throw new IOException("잘못된 인사");
            byte[] salt = new byte[32];
            System.arraycopy(myNonce, 0, salt, 0, 16);
            System.arraycopy(theirNonce, 0, salt, 16, 16);
            byte[] keys = hkdf(secret, salt, "ssok-relay-v1".getBytes(StandardCharsets.UTF_8), 64);
            sendKey = new SecretKeySpec(keys, 0, 32, "AES"); // 휴대폰 → PC
            recvKey = new SecretKeySpec(keys, 32, 32, "AES"); // PC → 휴대폰
            break;
        }
        sendEncrypted(AUTH, 0, ("{\"device\":" + quote(device) + ",\"kid\":" + quote(kid) + "}").getBytes(StandardCharsets.UTF_8));
        Frame ok = readEncrypted(message);
        if (ok.type != AUTH_OK) throw new IOException("PC가 응답하지 않았어요");
    }

    private static final class Frame {
        int type;
        int id;
        byte[] payload;
    }

    private void sendEncrypted(int type, int id, byte[] payload) throws Exception {
        byte[] plain = new byte[5 + payload.length];
        plain[0] = (byte) type;
        plain[1] = (byte) (id >>> 24);
        plain[2] = (byte) (id >>> 16);
        plain[3] = (byte) (id >>> 8);
        plain[4] = (byte) id;
        System.arraycopy(payload, 0, plain, 5, payload.length);
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, sendKey, new GCMParameterSpec(128, iv(sendCounter++)));
        sendFrame(0x2, cipher.doFinal(plain));
    }

    private Frame readEncrypted(ByteArrayOutputStream message) throws Exception {
        while (true) {
            int type = readMessage(message);
            if (type == 1) {
                checkError(message.toString("UTF-8"));
                continue;
            }
            byte[] plain;
            try {
                Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
                cipher.init(Cipher.DECRYPT_MODE, recvKey, new GCMParameterSpec(128, iv(recvCounter)));
                plain = cipher.doFinal(message.toByteArray());
            } catch (Exception e) {
                throw new RelayException("BAD_KEY", "암호를 풀지 못했어요");
            }
            recvCounter++;
            Frame f = new Frame();
            f.type = plain[0] & 0xff;
            f.id = ((plain[1] & 0xff) << 24) | ((plain[2] & 0xff) << 16) | ((plain[3] & 0xff) << 8) | (plain[4] & 0xff);
            f.payload = new byte[plain.length - 5];
            System.arraycopy(plain, 5, f.payload, 0, f.payload.length);
            return f;
        }
    }

    /** 중계 서버·PC가 보낸 거절 메시지면 예외로 바꾼다 ('pc-offline' → PC_OFFLINE) */
    private static void checkError(String text) throws RelayException {
        if (!"error".equals(field(text, "t"))) return;
        String code = field(text, "code");
        String message = field(text, "message");
        throw new RelayException(code == null ? "ERROR" : code.toUpperCase().replace('-', '_'), message == null ? "연결하지 못했어요" : message);
    }

    /**
     * PC의 쏙에 요청 하나를 보낸다. 본문은 64KB씩 암호화해서 흘려보낸다.
     * @param headers 소문자 이름 (content-type 등). content-length는 length로 정해진다.
     */
    Response request(String method, String path, Map<String, String> headers, InputStream body, long length, Progress progress) throws Exception {
        int id = nextId;
        nextId += 2;
        StringBuilder head = new StringBuilder("{\"method\":").append(quote(method)).append(",\"path\":").append(quote(path)).append(",\"headers\":{");
        boolean first = true;
        for (Map.Entry<String, String> h : headers.entrySet()) {
            if (!first) head.append(',');
            head.append(quote(h.getKey())).append(':').append(quote(h.getValue()));
            first = false;
        }
        if (body != null) head.append(first ? "" : ",").append("\"content-length\":").append(quote(String.valueOf(length)));
        head.append("}}");
        sendEncrypted(REQ_HEAD, id, head.toString().getBytes(StandardCharsets.UTF_8));
        if (body != null) {
            byte[] buf = new byte[CHUNK];
            long done = 0;
            int n;
            while ((n = body.read(buf)) > 0) {
                byte[] piece = new byte[n];
                System.arraycopy(buf, 0, piece, 0, n);
                sendEncrypted(REQ_DATA, id, piece);
                done += n;
                if (progress != null) progress.update(done);
            }
            if (done != length) throw new IOException("파일 크기가 달라졌어요");
        }
        sendEncrypted(REQ_END, id, new byte[0]);

        Response response = new Response();
        ByteArrayOutputStream bodyOut = new ByteArrayOutputStream();
        ByteArrayOutputStream message = new ByteArrayOutputStream();
        while (true) {
            Frame f = readEncrypted(message);
            if (f.id != id) continue;
            if (f.type == RES_HEAD) {
                String text = new String(f.payload, StandardCharsets.UTF_8);
                Matcher m = Pattern.compile("\"status\"\\s*:\\s*(\\d+)").matcher(text);
                response.status = m.find() ? Integer.parseInt(m.group(1)) : 0;
            } else if (f.type == RES_DATA) {
                if (bodyOut.size() < 64 * 1024) bodyOut.write(f.payload, 0, f.payload.length);
            } else if (f.type == RES_END) {
                response.body = bodyOut.toString("UTF-8");
                return response;
            } else if (f.type == CANCEL) {
                throw new IOException("PC가 요청을 끝냈어요");
            }
        }
    }

    @Override
    public void close() {
        try {
            socket.close();
        } catch (IOException ignored) {
            // 이미 닫힘
        }
    }

    // ---- 도구 ----

    private static byte[] iv(long counter) {
        return ByteBuffer.allocate(12).putInt(0).putLong(counter).array();
    }

    /** HKDF-SHA256 (RFC 5869). PC 쪽은 WebCrypto의 HKDF로 같은 값을 만든다. */
    static byte[] hkdf(byte[] ikm, byte[] salt, byte[] info, int length) throws Exception {
        Mac mac = Mac.getInstance("HmacSHA256");
        mac.init(new SecretKeySpec(salt, "HmacSHA256"));
        byte[] prk = mac.doFinal(ikm);
        mac.init(new SecretKeySpec(prk, "HmacSHA256"));
        byte[] out = new byte[length];
        byte[] previous = new byte[0];
        int done = 0;
        for (int counter = 1; done < length; counter++) {
            mac.update(previous);
            mac.update(info);
            mac.update((byte) counter);
            previous = mac.doFinal();
            int n = Math.min(previous.length, length - done);
            System.arraycopy(previous, 0, out, done, n);
            done += n;
        }
        return out;
    }

    static String hex(byte[] bytes) {
        StringBuilder sb = new StringBuilder();
        for (byte b : bytes) sb.append(String.format("%02x", b & 0xff));
        return sb.toString();
    }

    private static byte[] unhex(String hex) {
        if (hex == null || !hex.matches("^([0-9a-fA-F]{2})+$")) return new byte[0];
        byte[] out = new byte[hex.length() / 2];
        for (int i = 0; i < out.length; i++) out[i] = (byte) Integer.parseInt(hex.substring(i * 2, i * 2 + 2), 16);
        return out;
    }

    /** JSON 문자열 값 */
    static String quote(String text) {
        StringBuilder sb = new StringBuilder("\"");
        for (char c : (text == null ? "" : text).toCharArray()) {
            if (c == '"' || c == '\\') sb.append('\\').append(c);
            else if (c < 0x20) sb.append(String.format("\\u%04x", (int) c));
            else sb.append(c);
        }
        return sb.append('"').toString();
    }

    /** 간단한 JSON에서 글자 값 하나를 꺼낸다 (인사·오류 메시지용) */
    private static String field(String json, String name) {
        Matcher m = Pattern.compile("\"" + name + "\"\\s*:\\s*\"((?:[^\"\\\\]|\\\\.)*)\"").matcher(json);
        if (!m.find()) return null;
        String raw = m.group(1);
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < raw.length(); i++) {
            char c = raw.charAt(i);
            if (c != '\\' || i + 1 >= raw.length()) {
                sb.append(c);
                continue;
            }
            char next = raw.charAt(++i);
            if (next == 'u' && i + 4 < raw.length()) {
                sb.append((char) Integer.parseInt(raw.substring(i + 1, i + 5), 16));
                i += 4;
            } else if (next == 'n') sb.append('\n');
            else sb.append(next);
        }
        return sb.toString();
    }
}
