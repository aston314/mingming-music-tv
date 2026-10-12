package server

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	product "github.com/aston314/mingming-music-tv"
)

func scanFixture(t *testing.T, scope string) (*Server, *scanSession) {
	t.Helper()
	s := New(product.Load(), "test", "test", t.TempDir(), true)
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	v := &scanSession{ID: "unpredictable-test-session", Scope: scope, Code: "A7C129", State: "waiting", Expires: time.Now().Add(scanTTL), Context: ctx, Cancel: cancel}
	s.scans.Sessions = map[string]*scanSession{v.ID: v}
	return s, v
}
func scanRequest(h http.Handler, method, path, body string) *httptest.ResponseRecorder {
	r := httptest.NewRequest(method, path, strings.NewReader(body))
	r.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	return w
}
func TestScanSearchScopeReplayAndAPIIsolation(t *testing.T) {
	s, v := scanFixture(t, "search")
	phone := s.PhoneHandler()
	path := "/phone/" + v.ID
	if w := scanRequest(phone, "GET", path, ""); w.Code != 200 || !strings.Contains(w.Body.String(), "A7C129") {
		t.Fatalf("phone page = %d", w.Code)
	}
	for _, check := range []struct {
		body   string
		status int
	}{
		{`{"scope":"login","value":"hello"}`, 400},
		{`{"scope":"search","value":""}`, 400},
		{`{"scope":"search","value":"hello","unexpected":true}`, 400},
		{`{"scope":"search","value":"hello"} {}`, 400},
		{`{"scope":"search","value":"` + strings.Repeat("a", 5000) + `"}`, 400},
		{`{"scope":"search","value":"hello","password":"secret"}`, 400},
		{`{"scope":"search","value":"  周杰伦  "}`, 200},
		{`{"scope":"search","value":"重复"}`, 410},
	} {
		w := scanRequest(phone, "POST", path+"/submit", check.body)
		if w.Code != check.status {
			t.Errorf("status = %d want %d", w.Code, check.status)
		}
	}
	w := scanRequest(s, "GET", "/api/scan/"+v.ID, "")
	var status map[string]any
	_ = json.Unmarshal(w.Body.Bytes(), &status)
	if status["state"] != "complete" || status["value"] != "周杰伦" {
		t.Fatalf("search result = %#v", status)
	}
	for _, path := range []string{"/api/user", "/api/library", "/api/scan", "/media", "/app.js", "/"} {
		if w := scanRequest(phone, "GET", path, ""); w.Code != 404 {
			t.Errorf("LAN exposes %s: %d", path, w.Code)
		}
	}
}
func TestScanCancellationExpiryAndOrigin(t *testing.T) {
	for _, name := range []string{"cancel", "background", "expiry"} {
		t.Run(name, func(t *testing.T) {
			s, v := scanFixture(t, "search")
			switch name {
			case "cancel":
				scanRequest(s, "DELETE", "/api/scan/"+v.ID, "")
			case "background":
				scanRequest(s, "POST", "/api/scan/cancel", "{}")
			case "expiry":
				s.scans.Now = func() time.Time { return v.Expires.Add(time.Second) }
			}
			w := scanRequest(s.PhoneHandler(), "POST", "/phone/"+v.ID+"/submit", `{"scope":"search","value":"late"}`)
			if w.Code != 410 || v.Value != "" {
				t.Fatalf("late input accepted: %d", w.Code)
			}
		})
	}
	s, v := scanFixture(t, "search")
	r := httptest.NewRequest("POST", "/phone/"+v.ID+"/submit", strings.NewReader(`{"scope":"search","value":"hello"}`))
	r.Header.Set("Origin", "http://unrelated.invalid")
	r.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	s.PhoneHandler().ServeHTTP(w, r)
	if w.Code != 403 || v.State != "waiting" {
		t.Fatal("foreign origin accepted")
	}
}
func TestScanAccountSharedValidationAndPrivateToken(t *testing.T) {
	for _, scope := range []string{"login", "register"} {
		t.Run(scope, func(t *testing.T) {
			s, v := scanFixture(t, scope)
			h := s.PhoneHandler()
			path := "/phone/" + v.ID
			if scope == "register" {
				w := scanRequest(h, "GET", path+"/captcha", "")
				if w.Code != 200 || v.CaptchaID != "fixture-captcha" {
					t.Fatal("missing captcha")
				}
			}
			direct := scanRequest(s, "POST", "/api/user", `{"action":"login","username":"demo","password":""}`)
			if direct.Code != 400 {
				t.Fatal("direct input bypasses validation")
			}
			input := `{"scope":"` + scope + `","username":"demo","password":"secret","captchaCode":"A7K2"}`
			w := scanRequest(h, "POST", path+"/submit", input)
			if w.Code != 200 || v.State != "complete" || s.authHeader() == "" {
				t.Fatalf("account submit: %d %s", w.Code, w.Body.String())
			}
			poll := scanRequest(s, "GET", "/api/scan/"+v.ID, "")
			if strings.Contains(w.Body.String(), "fixture-private-session") || strings.Contains(poll.Body.String(), "fixture-private-session") || strings.Contains(poll.Body.String(), "secret") {
				t.Fatal("secret exposed")
			}
			if v.Pending != nil {
				t.Fatal("credentials retained")
			}
			library := scanRequest(s, "PUT", "/api/library", `{"favorites":[{"id":"local"}],"playlists":[],"recent":[],"merge":true}`)
			if !strings.Contains(library.Body.String(), `"authenticated":true`) || !strings.Contains(library.Body.String(), `"synced":true`) {
				t.Fatal("account not ready for sync")
			}
		})
	}
}
func TestScanConcurrentSubmissionOnlyOneAccepted(t *testing.T) {
	s, v := scanFixture(t, "search")
	var wg sync.WaitGroup
	statuses := make(chan int, 8)
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			statuses <- scanRequest(s.PhoneHandler(), "POST", "/phone/"+v.ID+"/submit", `{"scope":"search","value":"one"}`).Code
		}()
	}
	wg.Wait()
	close(statuses)
	success := 0
	for status := range statuses {
		if status == 200 {
			success++
		} else if status != 409 && status != 410 {
			t.Errorf("unexpected %d", status)
		}
	}
	if success != 1 {
		t.Fatalf("accepted %d submissions", success)
	}
}
func TestScanCancelledAccountResponseCannotPublishToken(t *testing.T) {
	s, v := scanFixture(t, "login")
	started := make(chan struct{})
	release := make(chan struct{})
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		close(started)
		<-release
		_, _ = w.Write([]byte(`{"success":true,"token":"late-private-token"}`))
	}))
	defer upstream.Close()
	s.fixture = false
	s.cfg.Upstream = upstream.URL
	done := make(chan *httptest.ResponseRecorder)
	go func() {
		done <- scanRequest(s.PhoneHandler(), "POST", "/phone/"+v.ID+"/submit", `{"scope":"login","username":"demo","password":"secret"}`)
	}()
	<-started
	scanRequest(s, "POST", "/api/scan/cancel", "{}")
	close(release)
	w := <-done
	if w.Code != 410 || s.authHeader() != "" {
		t.Fatal("cancelled account response authenticated TV")
	}
	if _, err := os.Stat(filepath.Join(s.dataDir, "session.token")); !os.IsNotExist(err) {
		t.Fatal("cancelled token persisted")
	}
}
func TestScanLoginDeviceLimitContinuation(t *testing.T) {
	s, v := scanFixture(t, "login")
	s.fixture = false
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		if body["action"] == "login" {
			writeJSON(w, 409, map[string]any{"deviceLimit": true, "devices": []any{map[string]any{"tokenTail": "allowed", "deviceName": "old TV"}}})
			return
		}
		if body["action"] != "kickAndLogin" || body["kickTail"] != "allowed" || body["password"] != "secret" {
			t.Error("incorrect continuation")
			http.Error(w, "bad", 400)
			return
		}
		writeJSON(w, 200, map[string]any{"success": true, "token": "private-login-token"})
	}))
	defer upstream.Close()
	s.cfg.Upstream = upstream.URL
	h := s.PhoneHandler()
	path := "/phone/" + v.ID
	if w := scanRequest(h, "POST", path+"/submit", `{"scope":"login","username":"demo","password":"secret"}`); w.Code != 200 || v.State != "device_limit" {
		t.Fatal("device limit unavailable")
	}
	if w := scanRequest(h, "POST", path+"/resolve", `{"scope":"login","kickTail":"unlisted"}`); w.Code != 400 {
		t.Fatal("unlisted device accepted")
	}
	w := scanRequest(h, "POST", path+"/resolve", `{"scope":"login","kickTail":"allowed"}`)
	if w.Code != 200 || v.State != "complete" || v.Pending != nil || strings.Contains(w.Body.String(), "private-login-token") {
		t.Fatal("device resolution failed or leaked")
	}
}

func scanCaptchaImage(t *testing.T, w *httptest.ResponseRecorder) string {
	t.Helper()
	var result struct {
		Image string `json:"image"`
	}
	if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &result) != nil || !strings.HasPrefix(result.Image, "/phone/") {
		t.Fatalf("captcha response = %d %s", w.Code, w.Body.String())
	}
	return result.Image
}

func TestScanCaptchaImageRefreshAndScope(t *testing.T) {
	s, v := scanFixture(t, "register")
	h := s.PhoneHandler()
	path := "/phone/" + v.ID
	first := scanCaptchaImage(t, scanRequest(h, "GET", path+"/captcha", ""))
	w := scanRequest(h, "GET", first, "")
	if w.Code != 200 || w.Header().Get("Content-Type") != "image/svg+xml; charset=utf-8" || w.Header().Get("Cache-Control") != "no-store" || !strings.Contains(w.Body.String(), "A7K2") {
		t.Fatalf("captcha image = %d %s", w.Code, w.Body.String())
	}
	second := scanCaptchaImage(t, scanRequest(h, "GET", path+"/captcha", ""))
	if first == second || scanRequest(h, "GET", first, "").Code != 409 || scanRequest(h, "GET", second, "").Code != 200 {
		t.Fatal("refresh did not invalidate the previous image")
	}
	scanRequest(s, "DELETE", "/api/scan/"+v.ID, "")
	if scanRequest(h, "GET", second, "").Code != 410 || v.CaptchaID != "" || v.CaptchaSVG != "" {
		t.Fatal("cancelled captcha still available")
	}
	for _, scope := range []string{"search", "login"} {
		other, session := scanFixture(t, scope)
		if scanRequest(other.PhoneHandler(), "GET", "/phone/"+session.ID+"/captcha-image?v=1", "").Code != 405 {
			t.Fatalf("%s session exposes captcha", scope)
		}
	}
}

func TestScanCaptchaUpstreamFailureAndRetry(t *testing.T) {
	s, v := scanFixture(t, "register")
	s.fixture = false
	fail := true
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/captcha" || r.Method != "GET" || r.Header.Get("Accept") != "application/json" || r.Header.Get("Authorization") != "" {
			t.Error("incorrect upstream captcha request")
		}
		if fail {
			fail = false
			http.Error(w, "temporarily unavailable", 503)
			return
		}
		writeJSON(w, 200, map[string]any{"success": true, "captchaId": "real-shape", "svg": `<svg xmlns="http://www.w3.org/2000/svg" width="90" height="36"><text x="10" y="24">Ab12</text></svg>`})
	}))
	defer upstream.Close()
	s.cfg.Upstream = upstream.URL
	h := s.PhoneHandler()
	path := "/phone/" + v.ID
	w := scanRequest(h, "GET", path+"/captcha", "")
	if w.Code != 502 || !strings.Contains(w.Body.String(), "换一张") || v.State != "waiting" || v.CaptchaID != "" {
		t.Fatal("captcha error not recoverable")
	}
	if scanRequest(h, "POST", path+"/submit", `{"scope":"register","username":"demo","password":"secret","captchaCode":"Ab12"}`).Code != 400 || v.State != "waiting" {
		t.Fatal("register accepted without a loaded captcha")
	}
	image := scanCaptchaImage(t, scanRequest(h, "GET", path+"/captcha", ""))
	if v.CaptchaID != "real-shape" || !strings.Contains(scanRequest(h, "GET", image, "").Body.String(), "Ab12") {
		t.Fatal("retry did not load the upstream image")
	}
}

func TestScanCaptchaLateResponseCannotReplaceNewImage(t *testing.T) {
	s, v := scanFixture(t, "register")
	s.fixture = false
	started, release := make(chan struct{}), make(chan struct{})
	var requests int
	var mu sync.Mutex
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		requests++
		count := requests
		mu.Unlock()
		if count == 1 {
			close(started)
			<-release
			writeJSON(w, 200, map[string]any{"captchaId": "old", "svg": "<svg>old</svg>"})
			return
		}
		writeJSON(w, 200, map[string]any{"captchaId": "new", "svg": "<svg>new</svg>"})
	}))
	defer upstream.Close()
	s.cfg.Upstream = upstream.URL
	h := s.PhoneHandler()
	path := "/phone/" + v.ID + "/captcha"
	done := make(chan *httptest.ResponseRecorder)
	go func() { done <- scanRequest(h, "GET", path, "") }()
	<-started
	second := scanRequest(h, "GET", path, "")
	close(release)
	first := <-done
	image := scanCaptchaImage(t, second)
	if first.Code != 409 || v.CaptchaID != "new" || scanRequest(h, "GET", image, "").Body.String() != "<svg>new</svg>" {
		t.Fatal("late captcha replaced the current image")
	}
}

func TestScanCaptchaCancelledResponseCannotPublishImage(t *testing.T) {
	s, v := scanFixture(t, "register")
	s.fixture = false
	started, release := make(chan struct{}), make(chan struct{})
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		close(started)
		<-release
		writeJSON(w, 200, map[string]any{"captchaId": "late", "svg": "<svg>late</svg>"})
	}))
	defer upstream.Close()
	s.cfg.Upstream = upstream.URL
	done := make(chan *httptest.ResponseRecorder)
	go func() { done <- scanRequest(s.PhoneHandler(), "GET", "/phone/"+v.ID+"/captcha", "") }()
	<-started
	scanRequest(s, "POST", "/api/scan/cancel", "{}")
	close(release)
	w := <-done
	if w.Code != 410 || v.CaptchaID != "" || v.CaptchaSVG != "" {
		t.Fatal("cancelled captcha published an image")
	}
}
