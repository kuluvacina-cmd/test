package main

import (
	"bytes"
	"context"
	"embed"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"io/fs"
	"mime"
	"net"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"time"
)

const (
	appID       = "song"
	appVersion  = "0.1.0"
	defaultPort = 43821
	healthPath  = "/__song_health"
)

//go:embed web
var embeddedWeb embed.FS

type healthIdentity struct {
	App     string `json:"app"`
	Version string `json:"version"`
}

// newHandler serves only the supplied application files. It deliberately does
// not expose a filesystem directory or log request URLs containing OAuth data.
func newHandler(web fs.FS, allowedHost string) http.Handler {
	identity, _ := json.Marshal(healthIdentity{App: appID, Version: appVersion})
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		if r.Host != allowedHost {
			http.Error(w, "Forbidden", http.StatusForbidden)
			return
		}
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			w.Header().Set("Allow", "GET, HEAD")
			http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
			return
		}
		if r.URL.Path == healthPath {
			w.Header().Set("Content-Type", "application/json; charset=utf-8")
			http.ServeContent(w, r, "health.json", time.Time{}, bytes.NewReader(identity))
			return
		}

		name := strings.TrimPrefix(r.URL.Path, "/")
		if r.URL.Path == "/" || r.URL.Path == "/callback" {
			name = "index.html"
		}
		if !safeAssetPath(name) {
			http.Error(w, "Not found", http.StatusNotFound)
			return
		}
		contents, err := fs.ReadFile(web, name)
		if err != nil {
			http.Error(w, "Not found", http.StatusNotFound)
			return
		}
		w.Header().Set("Content-Type", contentType(name))
		http.ServeContent(w, r, path.Base(name), time.Time{}, bytes.NewReader(contents))
	})
}

func safeAssetPath(name string) bool {
	if !fs.ValidPath(name) || strings.ContainsAny(name, "\\\x00") {
		return false
	}
	for _, segment := range strings.Split(name, "/") {
		if strings.HasPrefix(segment, ".") {
			return false
		}
	}
	return true
}

func contentType(name string) string {
	switch strings.ToLower(path.Ext(name)) {
	case ".html":
		return "text/html; charset=utf-8"
	case ".js", ".mjs":
		return "text/javascript; charset=utf-8"
	case ".css":
		return "text/css; charset=utf-8"
	case ".svg":
		return "image/svg+xml"
	case ".json":
		return "application/json; charset=utf-8"
	case ".woff":
		return "font/woff"
	case ".woff2":
		return "font/woff2"
	}
	if known := mime.TypeByExtension(path.Ext(name)); known != "" {
		return known
	}
	return "application/octet-stream"
}

func existingLauncher(address string) bool {
	client := &http.Client{
		Timeout: 2 * time.Second,
		Transport: &http.Transport{
			Proxy: nil,
		},
		CheckRedirect: func(_ *http.Request, _ []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}
	defer client.CloseIdleConnections()
	response, err := client.Get("http://" + address + healthPath)
	if err != nil {
		return false
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return false
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, 2048))
	if err != nil {
		return false
	}
	var identity healthIdentity
	return json.Unmarshal(body, &identity) == nil && identity.App == appID && identity.Version == appVersion
}

func openBrowser(target string) error {
	var command *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		command = exec.Command("open", target)
	case "linux":
		command = exec.Command("xdg-open", target)
	default:
		return errors.New("automatic browser opening is unavailable on this platform")
	}
	if err := command.Start(); err != nil {
		return err
	}
	go func() {
		if err := command.Wait(); err != nil {
			fmt.Fprintln(os.Stderr, "Không mở được trình duyệt tự động. Hãy mở", target)
		}
	}()
	return nil
}

func run(ctx context.Context, port int, noOpen bool, opener func(string) error) error {
	if port < 1 || port > 65535 {
		return errors.New("cổng phải nằm trong khoảng 1–65535")
	}
	address := net.JoinHostPort("127.0.0.1", strconv.Itoa(port))
	target := "http://" + address + "/"
	listener, err := net.Listen("tcp4", address)
	if err != nil {
		if errors.Is(err, syscall.EADDRINUSE) && existingLauncher(address) {
			fmt.Println("Sóng đã chạy tại", target)
			if !noOpen {
				if err := opener(target); err != nil {
					fmt.Fprintln(os.Stderr, "Hãy mở trình duyệt tại", target)
				}
			}
			return nil
		}
		return fmt.Errorf("không mở được cổng %d; đóng ứng dụng đang dùng cổng này rồi mở Sóng lại", port)
	}
	defer listener.Close()
	web, err := fs.Sub(embeddedWeb, "web")
	if err != nil {
		return errors.New("không đọc được giao diện đã đóng gói")
	}
	server := &http.Server{
		Handler:           newHandler(web, address),
		ReadHeaderTimeout: 5 * time.Second,
		IdleTimeout:       60 * time.Second,
		MaxHeaderBytes:    16 * 1024,
	}
	finished := make(chan error, 1)
	go func() { finished <- server.Serve(listener) }()
	fmt.Println("Sóng đang chạy tại", target)
	if !noOpen {
		if err := opener(target); err != nil {
			fmt.Fprintln(os.Stderr, "Không mở được trình duyệt tự động. Hãy mở", target)
		}
	}
	select {
	case err := <-finished:
		if errors.Is(err, http.ErrServerClosed) {
			return nil
		}
		return errors.New("máy chủ Sóng đã dừng ngoài dự kiến")
	case <-ctx.Done():
		shutdown, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := server.Shutdown(shutdown); err != nil {
			_ = server.Close()
			return errors.New("máy chủ Sóng không đóng kịp thời")
		}
		return nil
	}
}

func main() {
	noOpen := flag.Bool("no-open", false, "Chạy máy chủ mà không tự mở trình duyệt")
	port := flag.Int("port", defaultPort, "Cổng loopback; chỉ thay đổi để kiểm thử")
	flag.Parse()
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if err := run(ctx, *port, *noOpen, openBrowser); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
