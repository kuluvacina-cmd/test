package app.song.music;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.net.http.SslError;
import android.os.Bundle;
import android.webkit.GeolocationPermissions;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.SslErrorHandler;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.Toast;

import java.io.IOException;
import java.io.OutputStream;
import java.net.BindException;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.HashSet;
import java.util.Set;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

public final class MainActivity extends Activity {
  private static final int PICK_HISTORY = 401;
  private static final int SAVE_LIBRARY = 402;
  private static final int MAX_EXPORT_BYTES = 10 * 1024 * 1024;
  private static final Set<String> EXTERNAL_HOSTS = new HashSet<>(Arrays.asList(
      "open.spotify.com", "developer.spotify.com", "www.spotify.com", "support.spotify.com"));
  private WebView webView;
  private LocalWebServer server;
  private ValueCallback<Uri[]> selectedFiles;
  private byte[] pendingExport;
  private volatile boolean destroyed;

  @Override public void onCreate(Bundle state) {
    super.onCreate(state);
    FrameLayout frame = new FrameLayout(this);
    frame.setBackgroundColor(Color.rgb(246, 248, 246));
    frame.setOnApplyWindowInsetsListener((view, insets) -> {
      view.setPadding(insets.getSystemWindowInsetLeft(), insets.getSystemWindowInsetTop(),
          insets.getSystemWindowInsetRight(), insets.getSystemWindowInsetBottom());
      return insets.consumeSystemWindowInsets();
    });
    webView = new WebView(this);
    webView.setBackgroundColor(Color.rgb(246, 248, 246));
    webView.setSaveEnabled(false);
    webView.setSaveFromParentEnabled(false);
    frame.addView(webView, new FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
    setContentView(frame);
    frame.requestApplyInsets();

    WebSettings settings = webView.getSettings();
    settings.setJavaScriptEnabled(true);
    settings.setDomStorageEnabled(true);
    settings.setDatabaseEnabled(true);
    settings.setAllowFileAccess(false);
    settings.setAllowContentAccess(true); // Content URIs are granted only by the system file picker.
    settings.setAllowFileAccessFromFileURLs(false);
    settings.setAllowUniversalAccessFromFileURLs(false);
    settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
    settings.setSafeBrowsingEnabled(true);
    settings.setJavaScriptCanOpenWindowsAutomatically(false);
    settings.setSupportMultipleWindows(false);
    WebView.setWebContentsDebuggingEnabled(false);
    webView.setWebViewClient(new NavigationClient());
    webView.setWebChromeClient(new BrowserClient());
    webView.addJavascriptInterface(new DownloadBridge(), "SongDownloads");

    server = new LocalWebServer(getAssets(), search -> {
      if (destroyed || isFinishing()) return false;
      runOnUiThread(() -> {
        if (!destroyed) webView.loadUrl(LocalWebServer.ORIGIN + "/" + search);
      });
      return true;
    });
    Thread startup = new Thread(() -> {
      try {
        server.start();
        if (destroyed) { server.close(); return; }
        runOnUiThread(() -> { if (!destroyed) webView.loadUrl(LocalWebServer.ORIGIN + "/"); });
      } catch (IOException error) {
        if (destroyed) return;
        final boolean portBusy = error instanceof BindException;
        runOnUiThread(() -> new AlertDialog.Builder(this)
            .setTitle(portBusy ? "Cổng kết nối đang được dùng" : "Chưa mở được Sóng")
            .setMessage(portBusy
                ? "Sóng cần cổng 127.0.0.1:43821 để kết nối Spotify. Hãy đóng phiên Sóng khác, rồi mở ứng dụng lại."
                : "Không mở được giao diện cục bộ. Hãy đóng ứng dụng và thử lại.")
            .setPositiveButton("Đóng", (dialog, which) -> finish())
            .setCancelable(false).show());
      }
    }, "Song-startup");
    startup.setDaemon(true);
    startup.start();
  }

  private static boolean httpsHost(Uri uri, String host) {
    return "https".equals(uri.getScheme()) && host.equals(uri.getHost()) && uri.getUserInfo() == null
        && (uri.getPort() == -1 || uri.getPort() == 443);
  }

  private static boolean appOrigin(Uri uri) {
    return "http".equals(uri.getScheme()) && "127.0.0.1".equals(uri.getHost())
        && uri.getPort() == LocalWebServer.PORT && uri.getUserInfo() == null
        && ("/".equals(uri.getPath()) || "/callback".equals(uri.getPath()));
  }

  private boolean openBrowser(Uri uri) {
    try {
      startActivity(new Intent(Intent.ACTION_VIEW, uri).addCategory(Intent.CATEGORY_BROWSABLE));
      return true;
    } catch (ActivityNotFoundException error) {
      Toast.makeText(this, "Hãy cài hoặc bật trình duyệt trên điện thoại rồi thử lại.", Toast.LENGTH_LONG).show();
      return false;
    }
  }

  private boolean authorize(Uri uri) {
    if (!httpsHost(uri, "accounts.spotify.com") || !"/authorize".equals(uri.getPath()) || uri.getFragment() != null) return false;
    String[] required = { "client_id", "state", "redirect_uri", "response_type", "code_challenge", "code_challenge_method" };
    for (String key : required) if (uri.getQueryParameters(key).size() != 1) return false;
    String state = uri.getQueryParameter("state");
    String clientId = uri.getQueryParameter("client_id");
    String challenge = uri.getQueryParameter("code_challenge");
    if (!LocalWebServer.REDIRECT_URI.equals(uri.getQueryParameter("redirect_uri"))
        || !"code".equals(uri.getQueryParameter("response_type"))
        || !"S256".equals(uri.getQueryParameter("code_challenge_method"))
        || state == null || !state.matches("[A-Za-z0-9_-]{16,256}")
        || clientId == null || !clientId.matches("[A-Za-z0-9]{16,128}")
        || challenge == null || !challenge.matches("[A-Za-z0-9_-]{43}")) return false;
    server.registerAuthorization(state);
    openBrowser(uri);
    return true;
  }

  private final class NavigationClient extends WebViewClient {
    @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
      if (!request.isForMainFrame()) return true;
      Uri uri = request.getUrl();
      if (appOrigin(uri)) return false;
      if (authorize(uri)) return true;
      if (uri.getHost() != null && EXTERNAL_HOSTS.contains(uri.getHost()) && httpsHost(uri, uri.getHost())) openBrowser(uri);
      return true;
    }

    @Override public void onPageFinished(WebView view, String url) {
      if (url != null && appOrigin(Uri.parse(url))) {
        view.evaluateJavascript("window.songNativeExport=function(content,name){SongDownloads.exportJson(content,name);};", null);
      }
    }

    @Override public void onReceivedSslError(WebView view, SslErrorHandler handler, SslError error) {
      handler.cancel();
      Toast.makeText(MainActivity.this, "Không xác minh được kết nối bảo mật. Hãy kiểm tra mạng và thời gian trên điện thoại.", Toast.LENGTH_LONG).show();
    }
  }

  public final class DownloadBridge {
    @JavascriptInterface public void exportJson(String content, String name) {
      if (content == null || content.length() > MAX_EXPORT_BYTES || name == null || !name.matches("[A-Za-z0-9._-]{1,100}\\.json")) {
        exportNotice("File xuất chưa hợp lệ hoặc lớn hơn 10 MB.");
        return;
      }
      final byte[] bytes = content.getBytes(StandardCharsets.UTF_8);
      if (bytes.length > MAX_EXPORT_BYTES) { exportNotice("File xuất lớn hơn 10 MB."); return; }
      String trimmed = content.trim();
      try {
        if (trimmed.startsWith("{")) new JSONObject(trimmed);
        else if (trimmed.startsWith("[")) new JSONArray(trimmed);
        else throw new JSONException("JSON object or array required");
      } catch (JSONException error) { exportNotice("Dữ liệu xuất chưa phải file JSON hợp lệ."); return; }
      runOnUiThread(() -> {
        if (destroyed || webView.getUrl() == null || !appOrigin(Uri.parse(webView.getUrl()))) return;
        if (pendingExport != null) { exportNotice("Hãy hoàn tất lựa chọn file trước khi xuất thêm."); return; }
        pendingExport = bytes;
        Intent save = new Intent(Intent.ACTION_CREATE_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE)
            .setType("application/json").putExtra(Intent.EXTRA_TITLE, name).addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
        try { startActivityForResult(save, SAVE_LIBRARY); }
        catch (ActivityNotFoundException error) {
          pendingExport = null;
          exportNotice("Không mở được trình lưu file trên điện thoại.");
        }
      });
    }
  }

  private void exportNotice(String message) {
    runOnUiThread(() -> { if (!destroyed) Toast.makeText(this, message, Toast.LENGTH_LONG).show(); });
  }

  private final class BrowserClient extends WebChromeClient {
    @Override public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams parameters) {
      if (selectedFiles != null) selectedFiles.onReceiveValue(null);
      selectedFiles = callback;
      Intent picker = new Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE)
          .setType("*/*").putExtra(Intent.EXTRA_MIME_TYPES, new String[] { "application/json", "text/plain", "application/octet-stream" })
          .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
      if (parameters.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE) picker.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
      try { startActivityForResult(picker, PICK_HISTORY); }
      catch (ActivityNotFoundException error) {
        selectedFiles.onReceiveValue(null);
        selectedFiles = null;
        Toast.makeText(MainActivity.this, "Không mở được trình chọn file trên điện thoại.", Toast.LENGTH_LONG).show();
      }
      return true;
    }

    @Override public void onPermissionRequest(PermissionRequest request) { request.deny(); }
    @Override public void onGeolocationPermissionsShowPrompt(String origin, GeolocationPermissions.Callback callback) { callback.invoke(origin, false, false); }
  }

  @Override protected void onActivityResult(int requestCode, int resultCode, Intent data) {
    super.onActivityResult(requestCode, resultCode, data);
    if (requestCode == SAVE_LIBRARY) {
      final byte[] contents = pendingExport;
      pendingExport = null;
      final Uri target = data == null ? null : data.getData();
      if (resultCode != RESULT_OK || contents == null || target == null || !"content".equals(target.getScheme())) return;
      Thread saving = new Thread(() -> {
        try (OutputStream output = getContentResolver().openOutputStream(target, "wt")) {
          if (output == null) throw new IOException("Document unavailable");
          output.write(contents);
          output.flush();
          exportNotice("Đã lưu file thư viện JSON.");
        } catch (IOException | SecurityException error) {
          exportNotice("Chưa lưu được file. Hãy chọn vị trí khác và thử lại.");
        }
      }, "Song-export-library");
      saving.setDaemon(true);
      saving.start();
      return;
    }
    if (requestCode != PICK_HISTORY || selectedFiles == null) return;
    Uri[] uris = null;
    if (resultCode == RESULT_OK && data != null) {
      ClipData clips = data.getClipData();
      if (clips != null) {
        uris = new Uri[clips.getItemCount()];
        for (int index = 0; index < uris.length; index += 1) uris[index] = clips.getItemAt(index).getUri();
      } else if (data.getData() != null) uris = new Uri[] { data.getData() };
    }
    selectedFiles.onReceiveValue(uris);
    selectedFiles = null;
  }

  @Override protected void onNewIntent(Intent intent) {
    super.onNewIntent(intent);
    // The return link only focuses this existing Activity; OAuth is validated by the loopback server.
  }

  @Override public void onBackPressed() {
    if (webView != null && webView.canGoBack()) webView.goBack();
    else moveTaskToBack(true);
  }

  @Override protected void onDestroy() {
    destroyed = true;
    if (selectedFiles != null) { selectedFiles.onReceiveValue(null); selectedFiles = null; }
    pendingExport = null;
    if (server != null) server.close();
    if (webView != null) { webView.removeJavascriptInterface("SongDownloads"); webView.destroy(); }
    super.onDestroy();
  }
}
