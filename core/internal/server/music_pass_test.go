package server

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	product "github.com/aston314/mingming-music-tv"
)

func passTestServer(t *testing.T, upstream string) *Server {
	t.Helper()
	cfg := product.Load()
	cfg.Upstream = upstream
	return New(cfg, "pass-test", "test", t.TempDir(), false)
}

func musicRead(h *Server, method, path, body string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	// Neither browser cookies nor account credentials may enter music reads.
	req.Header.Set("Cookie", "untrusted_browser_cookie=private")
	req.Header.Set("Authorization", "Bearer untrusted-browser-token")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)
	return w
}

func requirePass(w http.ResponseWriter) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusUnauthorized)
	_, _ = io.WriteString(w, `{"code":-1,"error":"NEED_PASS"}`)
}

func issuePass(w http.ResponseWriter, value string) {
	http.SetCookie(w, &http.Cookie{Name: "deviceId", Value: "test-device", Path: "/", HttpOnly: true})
	http.SetCookie(w, &http.Cookie{Name: "mm_pass", Value: value, Path: "/", HttpOnly: true, MaxAge: 3600})
	w.Header().Set("Content-Type", "application/json")
	_, _ = io.WriteString(w, `{"success":true,"ticket":"private-ticket","expiresAt":9999999999999}`)
}

func TestMusicPassAcquisitionReplayAndExpiry(t *testing.T) {
	var passes atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "" || strings.Contains(r.Header.Get("Cookie"), "untrusted_browser_cookie") {
			t.Error("browser/account credentials reached the music service")
		}
		if r.URL.Path == "/api/music-pass" {
			if r.Method != http.MethodGet {
				t.Error("pass must be an anonymous GET")
			}
			issuePass(w, fmt.Sprint(passes.Add(1)))
			return
		}
		cookie, err := r.Cookie("mm_pass")
		if err != nil || cookie.Value != fmt.Sprint(passes.Load()) {
			requirePass(w)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		body, _ := io.ReadAll(r.Body)
		_, _ = fmt.Fprintf(w, `{"method":%q,"path":%q,"query":%q,"body":%q}`, r.Method, r.URL.Path, r.URL.RawQuery, string(body))
	}))
	defer upstream.Close()
	h := passTestServer(t, upstream.URL)
	h.token = "account-token"
	for _, endpoint := range []string{"list", "search", "url", "lrc", "pic", "word-lyric"} {
		method, path, body := http.MethodPost, "/api/music/"+endpoint, "id=108640&type=wy"
		if endpoint == "word-lyric" {
			method, path, body = http.MethodGet, "/api/word-lyric?id=108640", ""
		}
		w := musicRead(h, method, path, body)
		if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), body) {
			t.Fatalf("%s: %d %s", endpoint, w.Code, w.Body.String())
		}
		if w.Header().Get("Set-Cookie") != "" || strings.Contains(w.Body.String(), "private-ticket") {
			t.Fatal("anonymous pass leaked to WebView")
		}
		if endpoint == "word-lyric" && !strings.Contains(w.Body.String(), `"query":"id=108640"`) {
			t.Fatal("replay lost query parameters")
		}
	}
	if passes.Load() != 1 || h.authHeader() != "Bearer account-token" {
		t.Fatalf("pass reuse/login preservation: passes=%d", passes.Load())
	}
	// The cookie jar expires credentials. The next read refreshes exactly once.
	u, _ := url.Parse(upstream.URL)
	h.musicClient.Jar.SetCookies(u, []*http.Cookie{{Name: "mm_pass", Value: "expired", Path: "/", MaxAge: -1}})
	w := musicRead(h, http.MethodPost, "/api/music/url", "id=108640&type=wy")
	if w.Code != http.StatusOK || passes.Load() != 2 {
		t.Fatalf("expired pass recovery: %d, refreshes=%d", w.Code, passes.Load())
	}
}

func TestConcurrentNeedPassSharesOneRefresh(t *testing.T) {
	const readers = 12
	var rejected, passes atomic.Int32
	allRejected := make(chan struct{})
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/music-pass" {
			passes.Add(1)
			issuePass(w, "current")
			return
		}
		cookie, err := r.Cookie("mm_pass")
		if err != nil || cookie.Value != "current" {
			if rejected.Add(1) == readers {
				close(allRejected)
			}
			select {
			case <-allRejected:
			case <-r.Context().Done():
				return
			}
			requirePass(w)
			return
		}
		_, _ = io.WriteString(w, `{"code":1,"data":"ok"}`)
	}))
	defer upstream.Close()
	h := passTestServer(t, upstream.URL)
	u, _ := url.Parse(upstream.URL)
	h.musicClient.Jar.SetCookies(u, []*http.Cookie{{Name: "mm_pass", Value: "revoked", Path: "/"}})
	var wg sync.WaitGroup
	for i := 0; i < readers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			w := musicRead(h, http.MethodPost, "/api/music/lrc", "id=108640&type=wy")
			if w.Code != http.StatusOK {
				t.Errorf("concurrent music read: %d %s", w.Code, w.Body.String())
			}
		}()
	}
	wg.Wait()
	if passes.Load() != 1 {
		t.Fatalf("concurrent pass refreshes=%d, want 1", passes.Load())
	}
}

func TestMusicPassFailureIsBounded(t *testing.T) {
	for _, failure := range []string{"unavailable", "malformed", "missing-cookie", "still-rejected"} {
		t.Run(failure, func(t *testing.T) {
			var passes, reads atomic.Int32
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path != "/api/music-pass" {
					reads.Add(1)
					requirePass(w)
					return
				}
				passes.Add(1)
				switch failure {
				case "unavailable":
					w.WriteHeader(http.StatusServiceUnavailable)
				case "malformed":
					_, _ = io.WriteString(w, "not json")
				case "missing-cookie":
					_, _ = io.WriteString(w, `{"success":true,"ticket":"private-ticket"}`)
				default:
					issuePass(w, "rejected")
				}
			}))
			defer upstream.Close()
			h := passTestServer(t, upstream.URL)
			w := musicRead(h, http.MethodPost, "/api/music/url", "id=108640&type=wy")
			if w.Code != http.StatusUnauthorized || w.Body.String() != `{"code":-1,"error":"NEED_PASS"}` {
				t.Fatalf("upstream error not preserved: %d %s", w.Code, w.Body.String())
			}
			if failure == "still-rejected" {
				if passes.Load() != 1 || reads.Load() != 2 {
					t.Fatalf("unbounded replay: passes=%d reads=%d", passes.Load(), reads.Load())
				}
				return
			}
			_ = musicRead(h, http.MethodPost, "/api/music/lrc", "id=108640&type=wy")
			if passes.Load() != 1 || reads.Load() != 2 {
				t.Fatalf("failed refresh cooldown: passes=%d reads=%d", passes.Load(), reads.Load())
			}
		})
	}
}

func TestMusicPassDoesNotRefreshOther401Errors(t *testing.T) {
	var passes atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/music-pass" {
			passes.Add(1)
		}
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = io.WriteString(w, `{"error":"ACCOUNT_REQUIRED"}`)
	}))
	defer upstream.Close()
	h := passTestServer(t, upstream.URL)
	w := musicRead(h, http.MethodPost, "/api/music/url", "id=108640&type=wy")
	if w.Code != http.StatusUnauthorized || passes.Load() != 0 {
		t.Fatalf("unrelated 401 triggered pass refresh: status=%d passes=%d", w.Code, passes.Load())
	}
}

func TestMusicPassCookiesStayOutOfOtherClientsAndRedirects(t *testing.T) {
	var leaked atomic.Bool
	other := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		leaked.Store(true)
	}))
	defer other.Close()
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/music-pass" {
			issuePass(w, "current")
			return
		}
		if r.URL.Path == "/api/music/url" {
			if _, err := r.Cookie("mm_pass"); err != nil {
				requirePass(w)
			} else {
				http.Redirect(w, r, other.URL, http.StatusFound)
			}
			return
		}
		if r.Header.Get("Cookie") != "" {
			t.Errorf("music cookie reached %s", r.URL.Path)
		}
		_, _ = io.WriteString(w, `{}`)
	}))
	defer upstream.Close()
	h := passTestServer(t, upstream.URL)
	w := musicRead(h, http.MethodPost, "/api/music/url", "id=108640&type=wy")
	if w.Code != http.StatusFound || leaked.Load() {
		t.Fatalf("cross-origin redirect followed: status=%d leaked=%v", w.Code, leaked.Load())
	}
	for _, path := range []string{"/api/user?action=me", "/api/netease/catalogue", "/media?url=" + url.QueryEscape(upstream.URL+"/song.mp3")} {
		r := httptest.NewRequest(http.MethodGet, path, nil)
		h.ServeHTTP(httptest.NewRecorder(), r)
	}
	if h.client.Jar != nil || h.mediaClient.Jar != nil {
		t.Fatal("music jar shared with account or media clients")
	}
}

func TestMusicPassWaitHonorsCancellation(t *testing.T) {
	h := passTestServer(t, "http://example.invalid")
	h.musicPass.refreshing = make(chan struct{})
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	started := time.Now()
	if err := h.refreshMusicPass(ctx, 0); err != context.Canceled || time.Since(started) > time.Second {
		t.Fatalf("canceled waiter: %v", err)
	}
}
