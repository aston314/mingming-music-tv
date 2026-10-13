package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	product "github.com/aston314/mingming-music-tv"
)

func TestFixtureContractsAndAssets(t *testing.T) {
	h := New(product.Load(), "0.1.0-dev", "test", t.TempDir(), true)
	for _, path := range []string{"/health", "/", "/app.css", "/app.js", "/api/music/search", "/api/aimusic/square?limit=3"} {
		method := http.MethodGet
		body := strings.NewReader("")
		if path == "/api/music/search" {
			method = http.MethodPost
			body = strings.NewReader("name=test&type=wy")
		}
		r := httptest.NewRequest(method, path, body)
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		if w.Code != http.StatusOK {
			t.Fatalf("%s: status %d", path, w.Code)
		}
	}
}

func TestFixtureRecommendationAndPlaylistShape(t *testing.T) {
	h := New(product.Load(), "0.1.0-dev", "test", t.TempDir(), true)
	checks := []struct {
		name   string
		method string
		path   string
		body   string
		assert func(t *testing.T, value map[string]any)
	}{
		{name: "carousel", method: http.MethodGet, path: "/api/carousel", assert: func(t *testing.T, value map[string]any) {
			items, ok := value["items"].([]any)
			if !ok || len(items) != 3 {
				t.Fatalf("carousel items = %#v, want 3", value["items"])
			}
		}},
		{name: "catalogue", method: http.MethodGet, path: "/api/netease/catalogue", assert: func(t *testing.T, value map[string]any) {
			items, ok := value["sub"].([]any)
			if !ok || len(items) < 5 {
				t.Fatalf("catalogue sub = %#v, want category entries", value["sub"])
			}
		}},
		{name: "catplaylists", method: http.MethodGet, path: "/api/netease/catplaylists?cat=%E5%8D%8E%E8%AF%AD", assert: func(t *testing.T, value map[string]any) {
			items, ok := value["playlists"].([]any)
			if !ok || len(items) != 3 {
				t.Fatalf("playlists = %#v, want 3", value["playlists"])
			}
		}},
		{name: "playlist tracks", method: http.MethodPost, path: "/api/music/list", body: "id=fixture&type=wy", assert: func(t *testing.T, value map[string]any) {
			data, ok := value["data"].(map[string]any)
			playlist, ok2 := data["playlist"].(map[string]any)
			tracks, ok3 := playlist["tracks"].([]any)
			if !ok || !ok2 || !ok3 || len(tracks) != 3 {
				t.Fatalf("playlist tracks = %#v, want 3", value["data"])
			}
		}},
	}
	for _, check := range checks {
		t.Run(check.name, func(t *testing.T) {
			r := httptest.NewRequest(check.method, check.path, strings.NewReader(check.body))
			w := httptest.NewRecorder()
			h.ServeHTTP(w, r)
			if w.Code != http.StatusOK {
				t.Fatalf("status = %d", w.Code)
			}
			var value map[string]any
			if err := json.Unmarshal(w.Body.Bytes(), &value); err != nil {
				t.Fatalf("decode response: %v", err)
			}
			check.assert(t, value)
		})
	}
}

func TestFixtureArtistAndAlbumContracts(t *testing.T) {
	h := New(product.Load(), "0.1.0-dev", "test", t.TempDir(), true)
	checks := []struct {
		path string
		want string
	}{
		{path: "/api/netease/search?keyword=%E9%A2%84%E8%A7%88", want: "result"},
		{path: "/api/netease/artist?id=8926", want: "artist"},
		{path: "/api/netease/artist/albums?id=8926&offset=0&limit=2", want: "hotAlbums"},
		{path: "/api/netease/album?id=album-1", want: "songs"},
	}
	for _, check := range checks {
		r := httptest.NewRequest(http.MethodGet, check.path, nil)
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		if w.Code != http.StatusOK {
			t.Fatalf("%s: status %d", check.path, w.Code)
		}
		var value map[string]any
		if err := json.Unmarshal(w.Body.Bytes(), &value); err != nil {
			t.Fatalf("%s: invalid JSON: %v", check.path, err)
		}
		if _, ok := value[check.want]; !ok {
			t.Fatalf("%s: missing %s in %#v", check.path, check.want, value)
		}
	}
}

func TestAuthenticatedLibrarySync(t *testing.T) {
	var uploaded map[string]any
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPost && r.URL.Path == "/api/user" && r.Header.Get("Authorization") == "" {
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"success":true,"token":"test-token","userId":"user-1","username":"demo"}`))
			return
		}
		if r.Header.Get("Authorization") != "Bearer test-token" {
			http.Error(w, "missing auth", http.StatusUnauthorized)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		if r.Method == http.MethodGet && r.URL.Query().Get("action") == "me" {
			_, _ = w.Write([]byte(`{"userId":"user-1","username":"demo","favorites":[{"id":"cloud-fav"}],"playlist":[{"id":"cloud-queue"}]}`))
			return
		}
		if r.Method == http.MethodPost {
			if err := json.NewDecoder(r.Body).Decode(&uploaded); err != nil {
				http.Error(w, "invalid json", http.StatusBadRequest)
				return
			}
			_, _ = w.Write([]byte(`{"success":true}`))
			return
		}
		http.Error(w, "not found", http.StatusNotFound)
	}))
	defer upstream.Close()
	cfg := product.Load()
	cfg.Upstream = upstream.URL
	dataDir := t.TempDir()
	h := New(cfg, "0.1.0-dev", "test", dataDir, false)

	login := httptest.NewRequest(http.MethodPost, "/api/user", strings.NewReader(`{"action":"login","username":"demo","password":"secret"}`))
	loginRecorder := httptest.NewRecorder()
	h.ServeHTTP(loginRecorder, login)
	if loginRecorder.Code != http.StatusOK {
		t.Fatalf("login status = %d", loginRecorder.Code)
	}

	get := httptest.NewRequest(http.MethodGet, "/api/library", nil)
	getRecorder := httptest.NewRecorder()
	h.ServeHTTP(getRecorder, get)
	if getRecorder.Code != http.StatusOK {
		t.Fatalf("library GET status = %d", getRecorder.Code)
	}
	var cloud map[string]any
	if err := json.Unmarshal(getRecorder.Body.Bytes(), &cloud); err != nil {
		t.Fatalf("decode cloud library: %v", err)
	}
	if cloud["authenticated"] != true || cloud["synced"] != true {
		t.Fatalf("cloud state = %#v", cloud)
	}

	put := httptest.NewRequest(http.MethodPut, "/api/library", strings.NewReader(`{"favorites":[{"id":"local-fav"}],"playlists":[{"id":"local-queue"}],"recent":[{"id":"recent-song"}],"merge":true}`))
	putRecorder := httptest.NewRecorder()
	h.ServeHTTP(putRecorder, put)
	if putRecorder.Code != http.StatusOK {
		t.Fatalf("library PUT status = %d", putRecorder.Code)
	}
	if uploaded["userId"] != "user-1" {
		t.Fatalf("uploaded userId = %#v", uploaded["userId"])
	}
	favorites, _ := uploaded["favorites"].([]any)
	playlist, _ := uploaded["playlist"].([]any)
	if len(favorites) != 2 || len(playlist) != 2 {
		t.Fatalf("uploaded library = %#v", uploaded)
	}

	logout := httptest.NewRequest(http.MethodPost, "/api/logout", strings.NewReader(`{}`))
	logoutRecorder := httptest.NewRecorder()
	h.ServeHTTP(logoutRecorder, logout)
	if logoutRecorder.Code != http.StatusOK {
		t.Fatalf("logout status = %d, body = %s", logoutRecorder.Code, logoutRecorder.Body.String())
	}
	var guest map[string]any
	if err := json.Unmarshal(logoutRecorder.Body.Bytes(), &guest); err != nil {
		t.Fatalf("decode guest library: %v", err)
	}
	if guest["authenticated"] != false || len(guest["favorites"].([]any)) != 0 || len(guest["playlists"].([]any)) != 0 || len(guest["recent"].([]any)) != 1 {
		t.Fatalf("guest library after logout = %#v", guest)
	}
	if _, err := os.Stat(filepath.Join(dataDir, "session.token")); !os.IsNotExist(err) {
		t.Fatalf("session token remains after logout: %v", err)
	}
}
