package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"testing/fstest"
)

const testHost = "127.0.0.1:43821"

func applicationFiles() fstest.MapFS {
	return fstest.MapFS{
		"index.html":         {Data: []byte("<main>Sóng</main>")},
		"assets/app.js":      {Data: []byte("console.log('Sóng')")},
		"assets/app.css":     {Data: []byte("body{color:white}")},
		"assets/font.woff":   {Data: []byte("woff font")},
		"assets/font.woff2":  {Data: []byte("woff2 font")},
		"favicon.svg":        {Data: []byte("<svg></svg>")},
		".env":               {Data: []byte("never serve hidden configuration")},
		"assets/.hidden.js":  {Data: []byte("never serve hidden assets")},
		"private/secret.txt": {Data: []byte("not reachable by traversal")},
	}
}

func request(handler http.Handler, method, target, host string) *httptest.ResponseRecorder {
	r := httptest.NewRequest(method, target, nil)
	r.Host = host
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, r)
	return w
}

func TestIndexAndOAuthCallback(t *testing.T) {
	handler := newHandler(applicationFiles(), testHost)
	for _, target := range []string{"/", "/?code=private-code&state=private-state", "/callback?code=private-code&state=private-state"} {
		t.Run(target, func(t *testing.T) {
			response := request(handler, http.MethodGet, target, testHost)
			if response.Code != http.StatusOK || response.Body.String() != "<main>Sóng</main>" {
				t.Fatalf("callback must serve the application shell: status=%d body=%q", response.Code, response.Body.String())
			}
			if response.Header().Get("Content-Type") != "text/html; charset=utf-8" {
				t.Fatal("the application shell needs the HTML content type")
			}
			if strings.Contains(response.Body.String(), "private-code") || strings.Contains(fmt.Sprint(response.Header()), "private-state") {
				t.Fatal("OAuth query data must not be reflected in the response")
			}
		})
	}
}

func TestStaticContentTypesAndHead(t *testing.T) {
	handler := newHandler(applicationFiles(), testHost)
	for _, item := range []struct{ target, mime string }{
		{"/", "text/html; charset=utf-8"},
		{"/callback?code=test", "text/html; charset=utf-8"},
		{"/assets/app.js", "text/javascript; charset=utf-8"},
		{"/assets/app.css", "text/css; charset=utf-8"},
		{"/favicon.svg", "image/svg+xml"},
		{"/assets/font.woff", "font/woff"},
		{"/assets/font.woff2", "font/woff2"},
	} {
		t.Run(item.target, func(t *testing.T) {
			get := request(handler, http.MethodGet, item.target, testHost)
			head := request(handler, http.MethodHead, item.target, testHost)
			if get.Code != http.StatusOK || head.Code != http.StatusOK {
				t.Fatalf("asset should be served: GET=%d HEAD=%d", get.Code, head.Code)
			}
			if get.Header().Get("Content-Type") != item.mime || head.Header().Get("Content-Type") != item.mime {
				t.Fatalf("wrong content type for %s: %s", item.target, get.Header().Get("Content-Type"))
			}
			if head.Body.Len() != 0 || head.Header().Get("Content-Length") != get.Header().Get("Content-Length") || get.Header().Get("Content-Length") == "" {
				t.Fatal("HEAD must preserve asset metadata without returning a body")
			}
			if get.Header().Get("X-Content-Type-Options") != "nosniff" || get.Header().Get("Cache-Control") != "no-store" {
				t.Fatal("static assets need explicit MIME and fresh application contents")
			}
		})
	}
}

func TestExactLoopbackHostRequired(t *testing.T) {
	handler := newHandler(applicationFiles(), testHost)
	for _, host := range []string{"localhost:43821", "127.0.0.1:43822", "example.com:43821", "[::1]:43821", "127.0.0.1"} {
		for _, target := range []string{"/", healthPath} {
			response := request(handler, http.MethodGet, target, host)
			if response.Code != http.StatusForbidden {
				t.Errorf("foreign Host %q must be rejected for %s; got %d", host, target, response.Code)
			}
		}
	}
}

func TestOnlyReadMethodsAndNoDirectoryListing(t *testing.T) {
	handler := newHandler(applicationFiles(), testHost)
	for _, method := range []string{http.MethodPost, http.MethodPut, http.MethodDelete, http.MethodOptions} {
		for _, target := range []string{"/", "/callback", healthPath} {
			response := request(handler, method, target, testHost)
			if response.Code != http.StatusMethodNotAllowed || response.Header().Get("Allow") != "GET, HEAD" {
				t.Errorf("method %s must be rejected for %s; got %d", method, target, response.Code)
			}
		}
	}
	for _, target := range []string{"/assets", "/assets/", "/missing.js"} {
		if response := request(handler, http.MethodGet, target, testHost); response.Code != http.StatusNotFound {
			t.Errorf("missing files and directories must return 404: %s returned %d", target, response.Code)
		}
	}
}

func TestTraversalAndHiddenFilesRejected(t *testing.T) {
	handler := newHandler(applicationFiles(), testHost)
	for _, target := range []string{
		"/../private/secret.txt", "/assets/../private/secret.txt", "/%2e%2e/private/secret.txt",
		"/assets/%2e%2e/private/secret.txt", "/assets%2f..%2fprivate%2fsecret.txt",
		"/assets%5c..%5cprivate%5csecret.txt", "/.env", "/assets/.hidden.js", "/assets/%00/app.js",
	} {
		t.Run(target, func(t *testing.T) {
			response := request(handler, http.MethodGet, target, testHost)
			if response.Code != http.StatusNotFound {
				t.Fatalf("unsafe path should be rejected: status=%d body=%q", response.Code, response.Body.String())
			}
		})
	}
}

func TestHealthIdentityAndHead(t *testing.T) {
	handler := newHandler(applicationFiles(), testHost)
	response := request(handler, http.MethodGet, healthPath, testHost)
	var identity healthIdentity
	if response.Code != http.StatusOK || json.Unmarshal(response.Body.Bytes(), &identity) != nil || identity.App != appID || identity.Version != appVersion {
		t.Fatalf("wrong launcher health identity: status=%d body=%s", response.Code, response.Body.String())
	}
	if response.Header().Get("Content-Type") != "application/json; charset=utf-8" {
		t.Fatal("health identity must have a JSON content type")
	}
	head := request(handler, http.MethodHead, healthPath, testHost)
	if head.Code != http.StatusOK || head.Body.Len() != 0 {
		t.Fatal("health HEAD must succeed without a response body")
	}
}

func TestExistingLauncherRequiresCorrectHealth(t *testing.T) {
	for _, item := range []struct {
		name   string
		status int
		body   string
		ours   bool
	}{
		{"recognized launcher", 200, `{"app":"song","version":"0.1.0"}`, true},
		{"unrelated app", 200, `{"app":"other","version":"0.1.0"}`, false},
		{"wrong version", 200, `{"app":"song","version":"different"}`, false},
		{"missing version", 200, `{"app":"song"}`, false},
		{"unhealthy status", 503, `{"app":"song","version":"0.1.0"}`, false},
		{"not JSON", 200, `<html>Other server</html>`, false},
		{"extra data", 200, `{"app":"song","version":"0.1.0"} unexpected`, false},
	} {
		t.Run(item.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Method != http.MethodGet || r.URL.Path != healthPath {
					t.Errorf("unexpected health probe: method=%s path=%s", r.Method, r.URL.Path)
				}
				w.WriteHeader(item.status)
				_, _ = fmt.Fprint(w, item.body)
			}))
			defer server.Close()
			address, _ := url.Parse(server.URL)
			if got := existingLauncher(address.Host); got != item.ours {
				t.Fatalf("health recognition=%t; want %t", got, item.ours)
			}
		})
	}
}

func TestHealthProbeDoesNotFollowRedirect(t *testing.T) {
	redirected := false
	destination := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		redirected = true
		_, _ = fmt.Fprint(w, `{"app":"song","version":"0.1.0"}`)
	}))
	defer destination.Close()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, destination.URL, http.StatusFound)
	}))
	defer server.Close()
	address, _ := url.Parse(server.URL)
	if existingLauncher(address.Host) || redirected {
		t.Fatal("an unrelated occupied port must not redirect the health check elsewhere")
	}
}
