package app.song.music;

import android.content.res.AssetManager;
import android.os.SystemClock;

import java.io.BufferedInputStream;
import java.io.ByteArrayOutputStream;
import java.io.Closeable;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.URI;
import java.net.URLDecoder;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;

/** Serves packaged assets and receives one-time OAuth callbacks on loopback only. */
public final class LocalWebServer implements Closeable {
  public static final int PORT = 43821;
  public static final String ORIGIN = "http://127.0.0.1:" + PORT;
  public static final String REDIRECT_URI = ORIGIN + "/callback";
  private static final String HOST_HEADER = "127.0.0.1:" + PORT;
  private static final String[] CALLBACK_KEYS = { "code", "state", "error", "error_description" };
  private static final String CSP = "default-src 'self'; base-uri 'self'; object-src 'none'; "
      + "frame-src 'none'; frame-ancestors 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
      + "img-src 'self' data: https://i.scdn.co https://mosaic.scdn.co https://image-cdn-ak.spotifycdn.com; "
      + "font-src 'self' data:; connect-src 'self' https://api.spotify.com https://accounts.spotify.com https://api.openai.com; "
      + "media-src 'none'; form-action 'none'";

  public interface OAuthCallback { boolean onOAuthCallback(String search); }

  private final AssetManager assets;
  private final OAuthCallback callback;
  private final Set<Socket> clients = ConcurrentHashMap.newKeySet();
  private final ThreadPoolExecutor workers = new ThreadPoolExecutor(
      2, 4, 30, TimeUnit.SECONDS, new ArrayBlockingQueue<Runnable>(32), runnable -> {
        Thread thread = new Thread(runnable, "Song-local-request");
        thread.setDaemon(true);
        return thread;
      });
  private volatile boolean closed;
  private ServerSocket listener;
  private String pendingState;
  private long pendingExpiresAt;

  public LocalWebServer(AssetManager assets, OAuthCallback callback) {
    this.assets = assets;
    this.callback = callback;
  }

  public synchronized void start() throws IOException {
    if (closed) throw new IOException("Server is closed");
    if (listener != null) throw new IOException("Server already started");
    ServerSocket socket = new ServerSocket();
    try {
      socket.setReuseAddress(true);
      socket.bind(new java.net.InetSocketAddress(InetAddress.getByName("127.0.0.1"), PORT), 32);
      listener = socket;
    } catch (IOException error) {
      socket.close();
      throw error;
    }
    Thread accepting = new Thread(this::acceptConnections, "Song-loopback-server");
    accepting.setDaemon(true);
    accepting.start();
  }

  public synchronized void registerAuthorization(String state) {
    if (closed || state == null || !state.matches("[A-Za-z0-9_-]{16,256}")) {
      throw new IllegalArgumentException("Invalid authorization state");
    }
    pendingState = state;
    pendingExpiresAt = SystemClock.elapsedRealtime() + 10 * 60 * 1000;
  }

  private synchronized boolean consumeAuthorization(String state) {
    if (closed || pendingState == null || SystemClock.elapsedRealtime() > pendingExpiresAt || !pendingState.equals(state)) {
      return false;
    }
    pendingState = null;
    return true;
  }

  private void acceptConnections() {
    while (!closed) {
      Socket client = null;
      try {
        client = listener.accept();
        client.setSoTimeout(5000);
        clients.add(client);
        final Socket accepted = client;
        workers.execute(() -> {
          try { handle(accepted); } catch (IOException ignored) {
            // Request data and OAuth values are never written to logs.
          } finally {
            clients.remove(accepted);
            try { accepted.close(); } catch (IOException ignored) { }
          }
        });
      } catch (IOException | RejectedExecutionException error) {
        if (client != null) {
          clients.remove(client);
          try { client.close(); } catch (IOException ignored) { }
        }
        if (closed) return;
      }
    }
  }

  private static String readLine(InputStream input, int maximum) throws IOException {
    ByteArrayOutputStream bytes = new ByteArrayOutputStream();
    int current;
    while ((current = input.read()) != -1) {
      if (current == '\n') {
        byte[] result = bytes.toByteArray();
        int length = result.length;
        if (length > 0 && result[length - 1] == '\r') length -= 1;
        return new String(result, 0, length, StandardCharsets.US_ASCII);
      }
      if (bytes.size() >= maximum) throw new IOException("Request line too long");
      bytes.write(current);
    }
    return bytes.size() == 0 ? null : bytes.toString(StandardCharsets.US_ASCII.name());
  }

  private void handle(Socket client) throws IOException {
    InputStream input = new BufferedInputStream(client.getInputStream());
    OutputStream output = client.getOutputStream();
    String firstLine = readLine(input, 8192);
    if (firstLine == null) return;
    String[] request = firstLine.split(" ", 3);
    if (request.length != 3 || (!"HTTP/1.1".equals(request[2]) && !"HTTP/1.0".equals(request[2]))) {
      text(output, 400, false, "Yêu cầu không hợp lệ.");
      return;
    }
    boolean head = "HEAD".equals(request[0]);
    Map<String, String> headers = new LinkedHashMap<>();
    int headerBytes = 0;
    for (int count = 0; ; count += 1) {
      String line = readLine(input, 4096);
      if (line == null) { text(output, 400, head, "Yêu cầu chưa đầy đủ."); return; }
      if (line.isEmpty()) break;
      headerBytes += line.length();
      int separator = line.indexOf(':');
      if (count >= 64 || headerBytes > 32768 || separator <= 0) {
        text(output, 400, head, "Tiêu đề yêu cầu không hợp lệ.");
        return;
      }
      String key = line.substring(0, separator).trim().toLowerCase(Locale.ROOT);
      if ("host".equals(key) && headers.containsKey(key)) {
        text(output, 400, head, "Địa chỉ yêu cầu không hợp lệ.");
        return;
      }
      headers.put(key, line.substring(separator + 1).trim());
    }
    if (!HOST_HEADER.equals(headers.get("host"))) {
      text(output, 403, head, "Địa chỉ yêu cầu không được phép.");
      return;
    }
    if (!"GET".equals(request[0]) && !head) {
      send(output, 405, "text/plain; charset=utf-8", "Chỉ hỗ trợ GET và HEAD.".getBytes(StandardCharsets.UTF_8), false, false, "GET, HEAD");
      return;
    }
    URI uri;
    try {
      uri = new URI(request[1]);
      if (uri.isAbsolute() || uri.getRawAuthority() != null || uri.getRawFragment() != null || !request[1].startsWith("/")) {
        text(output, 403, head, "Địa chỉ yêu cầu không được phép.");
        return;
      }
    } catch (java.net.URISyntaxException error) {
      text(output, 400, head, "Địa chỉ yêu cầu không hợp lệ.");
      return;
    }

    String assetPath;
    try { assetPath = URLDecoder.decode(uri.getRawPath().replace("+", "%2B"), StandardCharsets.UTF_8.name()); }
    catch (IllegalArgumentException error) { text(output, 400, head, "Đường dẫn không hợp lệ."); return; }
    if ("/health".equals(assetPath)) {
      send(output, 200, "application/json; charset=utf-8", "{\"app\":\"song\",\"version\":1}".getBytes(StandardCharsets.UTF_8), head, false, null);
      return;
    }
    if ("/callback".equals(assetPath)) {
      if (head) {
        send(output, 405, "text/plain; charset=utf-8", new byte[0], true, false, "GET");
        return;
      }
      receiveCallback(output, uri.getRawQuery());
      return;
    }
    if (assetPath.indexOf('\0') >= 0 || assetPath.indexOf('\\') >= 0 || !assetPath.startsWith("/")) {
      text(output, 400, head, "Đường dẫn không hợp lệ.");
      return;
    }
    for (String segment : assetPath.split("/")) {
      if ("..".equals(segment) || ".".equals(segment)) {
        text(output, 403, head, "Đường dẫn không được phép.");
        return;
      }
    }
    String relative = "/".equals(assetPath) ? "index.html" : assetPath.substring(1);
    try (InputStream asset = assets.open("web/" + relative, AssetManager.ACCESS_STREAMING)) {
      ByteArrayOutputStream contents = new ByteArrayOutputStream();
      byte[] buffer = new byte[8192];
      int read;
      while ((read = asset.read(buffer)) != -1) {
        if (contents.size() + read > 32 * 1024 * 1024) throw new IOException("Asset too large");
        contents.write(buffer, 0, read);
      }
      send(output, 200, mime(relative), contents.toByteArray(), head, false, null);
    } catch (IOException error) {
      text(output, 404, head, "Không tìm thấy dữ liệu này trong ứng dụng.");
    }
  }

  private void receiveCallback(OutputStream output, String query) throws IOException {
    Map<String, String> values = new LinkedHashMap<>();
    boolean valid = query != null;
    if (query != null) {
      try {
        for (String pair : query.split("&")) {
          String[] parts = pair.split("=", 2);
          String key = URLDecoder.decode(parts[0], StandardCharsets.UTF_8.name());
          if (!Arrays.asList(CALLBACK_KEYS).contains(key)) continue;
          String value = URLDecoder.decode(parts.length == 2 ? parts[1] : "", StandardCharsets.UTF_8.name());
          if (values.containsKey(key) || value.length() > 4096 || value.matches("(?s).*[\\x00-\\x1f\\x7f].*")) valid = false;
          values.put(key, value);
        }
      } catch (IllegalArgumentException error) { valid = false; }
    }
    String state = values.get("state");
    String code = values.get("code");
    String error = values.get("error");
    boolean hasCode = code != null && !code.isEmpty();
    boolean hasError = error != null && !error.isEmpty();
    valid = valid && state != null && state.matches("[A-Za-z0-9_-]{16,256}") && (hasCode != hasError);
    if (!valid || !consumeAuthorization(state)) {
      callbackPage(output, false);
      return;
    }
    StringBuilder search = new StringBuilder("?");
    for (String key : CALLBACK_KEYS) {
      if (!values.containsKey(key)) continue;
      if (search.length() > 1) search.append('&');
      search.append(key).append('=').append(URLEncoder.encode(values.get(key), StandardCharsets.UTF_8.name()));
    }
    boolean delivered = callback != null && callback.onOAuthCallback(search.toString());
    callbackPage(output, delivered);
  }

  private static void callbackPage(OutputStream output, boolean accepted) throws IOException {
    String title = accepted ? "Quay lại Sóng" : "Kết nối chưa hoàn tất";
    String message = accepted
        ? "Đã nhận phản hồi từ Spotify. Nhấn nút bên dưới để quay lại ứng dụng và hoàn tất kết nối."
        : "Phiên kết nối đã hết hạn hoặc không khớp. Hãy quay lại Sóng và kết nối Spotify lần nữa.";
    String html = "<!doctype html><html lang=\"vi\"><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>"
        + title + " · Sóng</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f6f8f6;color:#183427;font:16px/1.6 system-ui,sans-serif}.card{max-width:440px;margin:24px;padding:32px;background:white;border:1px solid #dfebe2;border-radius:24px}h1{font-size:28px}p{color:#5a6d61}a{display:inline-block;padding:12px 22px;border-radius:12px;background:#2d7655;color:white;text-decoration:none;font-weight:700}</style><main class=\"card\"><strong>Sóng</strong><h1>"
        + title + "</h1><p>" + message + "</p><a href=\"song://return\">Mở ứng dụng Sóng</a></main></html>";
    send(output, accepted ? 200 : 400, "text/html; charset=utf-8", html.getBytes(StandardCharsets.UTF_8), false, true, null);
  }

  private static String mime(String path) {
    String extension = path.substring(path.lastIndexOf('.') + 1).toLowerCase(Locale.ROOT);
    switch (extension) {
      case "html": return "text/html; charset=utf-8";
      case "js": case "mjs": return "text/javascript; charset=utf-8";
      case "css": return "text/css; charset=utf-8";
      case "json": return "application/json; charset=utf-8";
      case "svg": return "image/svg+xml";
      case "png": return "image/png";
      case "jpg": case "jpeg": return "image/jpeg";
      case "webp": return "image/webp";
      case "ico": return "image/x-icon";
      case "woff": return "font/woff";
      case "woff2": return "font/woff2";
      case "ttf": return "font/ttf";
      default: return "application/octet-stream";
    }
  }

  private static void text(OutputStream output, int status, boolean head, String message) throws IOException {
    send(output, status, "text/plain; charset=utf-8", message.getBytes(StandardCharsets.UTF_8), head, false, null);
  }

  private static void send(OutputStream output, int status, String type, byte[] body, boolean head, boolean callbackPage, String allow) throws IOException {
    String policy = callbackPage
        ? "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
        : CSP;
    String headers = "HTTP/1.1 " + status + " " + (status == 200 ? "OK" : "Request Error") + "\r\n"
        + "Content-Type: " + type + "\r\nContent-Length: " + body.length + "\r\nConnection: close\r\n"
        + "Cache-Control: no-store\r\nReferrer-Policy: no-referrer\r\nX-Content-Type-Options: nosniff\r\n"
        + "Cross-Origin-Resource-Policy: same-origin\r\nContent-Security-Policy: " + policy + "\r\n"
        + (allow == null ? "" : "Allow: " + allow + "\r\n") + "\r\n";
    output.write(headers.getBytes(StandardCharsets.US_ASCII));
    if (!head) output.write(body);
    output.flush();
  }

  @Override public synchronized void close() {
    closed = true;
    pendingState = null;
    if (listener != null) { try { listener.close(); } catch (IOException ignored) { } }
    for (Socket client : clients) { try { client.close(); } catch (IOException ignored) { } }
    workers.shutdownNow();
  }
}
