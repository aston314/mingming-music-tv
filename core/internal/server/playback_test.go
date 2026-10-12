package server

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	product "github.com/aston314/mingming-music-tv"
)

func putPlayback(t *testing.T, handler *Server, sequence int, position float64) int {
	t.Helper()
	body := fmt.Sprintf(`{"clientId":"test-client","sequence":%d,"snapshot":{"schema":1,"track":{"id":123,"name":"测试歌曲","ar":[{"name":"测试歌手","token":"private"}],"al":{"name":"专辑","picUrl":"https://example.test/cover.jpg"},"audioUrl":"https://example.test/expired?token=private","token":"private","type":"wy"},"position":%g,"duration":180,"mode":"shuffle","list":[{"id":123,"name":"测试歌曲","audioPath":"/expired"},{"id":"next","name":"下一首"}],"listSource":"recommend"}}`, sequence, position)
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, httptest.NewRequest(http.MethodPut, "/api/playback", strings.NewReader(body)))
	return w.Code
}

func getPlayback(t *testing.T, handler *Server) *playbackSnapshot {
	t.Helper()
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/api/playback", nil))
	var response struct {
		Snapshot *playbackSnapshot `json:"snapshot"`
	}
	if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &response) != nil {
		t.Fatalf("GET: %d %s", w.Code, w.Body.String())
	}
	return response.Snapshot
}

func TestPlaybackSurvivesCoreRestartAndLibraryChanges(t *testing.T) {
	dir := t.TempDir()
	server := New(product.Load(), "test", "first-port", dir, true)
	if getPlayback(t, server) != nil {
		t.Fatal("fresh install has playback")
	}
	if code := putPlayback(t, server, 1, 47.25); code != 200 {
		t.Fatalf("PUT: %d", code)
	}
	file := filepath.Join(dir, "playback.json")
	data, _ := os.ReadFile(file)
	for _, forbidden := range []string{"audioUrl", "audioPath", "token", "private", "expired"} {
		if strings.Contains(string(data), forbidden) {
			t.Errorf("persisted media URL/secret %s", forbidden)
		}
	}
	info, _ := os.Stat(file)
	if info.Mode().Perm() != 0600 {
		t.Fatalf("permissions = %v", info.Mode().Perm())
	}
	for _, path := range []string{"/api/library", "/api/logout"} {
		method := http.MethodPut
		if path == "/api/logout" {
			method = http.MethodPost
		}
		w := httptest.NewRecorder()
		server.ServeHTTP(w, httptest.NewRequest(method, path, strings.NewReader(`{"favorites":[],"playlists":[],"recent":[]}`)))
		if w.Code != 200 {
			t.Fatalf("library/logout: %d", w.Code)
		}
	}
	restarted := New(product.Load(), "test", "new-port", dir, true)
	saved := getPlayback(t, restarted)
	if saved == nil || saved.Track["name"] != "测试歌曲" || saved.Position != 47.25 || saved.Duration != 180 || saved.Mode != "shuffle" || len(saved.List) != 2 || saved.UpdatedAt == 0 {
		t.Fatalf("restored %#v", saved)
	}
}

func TestPlaybackPreservesAlbumMetadataWithoutPrivateFields(t *testing.T) {
	for _, field := range []string{"al", "album"} {
		var input map[string]any
		_ = json.Unmarshal([]byte(`{"id":"metadata-song","`+field+`":{"name":"测试专辑","picUrl":"https://example.test/cover.jpg","token":"private","extra":"private"}}`), &input)
		clean := playbackTrack(input)
		data, _ := json.Marshal(clean)
		if !strings.Contains(string(data), "测试专辑") || strings.Contains(string(data), "private") || strings.Contains(string(data), "token") {
			t.Fatalf("invalid album metadata filtering: %s", data)
		}
	}
}

func TestPlaybackRejectsLateWritesAndHandlesConcurrentSaves(t *testing.T) {
	server := New(product.Load(), "test", "instance", t.TempDir(), true)
	var wg sync.WaitGroup
	for i := 1; i <= 30; i++ {
		wg.Add(1)
		go func(sequence int) {
			defer wg.Done()
			if code := putPlayback(t, server, sequence, float64(sequence)); code != 200 {
				t.Errorf("save %d: %d", sequence, code)
			}
		}(i)
	}
	wg.Wait()
	if saved := getPlayback(t, server); saved == nil || saved.Position != 30 {
		t.Fatalf("late save overwrote newest state: %#v", saved)
	}
	if code := putPlayback(t, server, 1, 0); code != 200 || getPlayback(t, server).Position != 30 {
		t.Fatal("duplicate save replaced final progress")
	}
}

func TestPlaybackMalformedStateAndWriteFailure(t *testing.T) {
	dir := t.TempDir()
	server := New(product.Load(), "test", "instance", dir, true)
	for _, data := range []string{`{"schema":1,"track":{"id":"song"}`, `{"schema":99,"track":{"id":"song"}}`, `{"schema":1,"track":{"id":"song"},"position":-5}`} {
		if err := os.WriteFile(filepath.Join(dir, "playback.json"), []byte(data), 0600); err != nil {
			t.Fatal(err)
		}
		if getPlayback(t, server) != nil {
			t.Fatalf("accepted corrupt state %s", data)
		}
	}
	if putPlayback(t, server, 1, 12) != 200 {
		t.Fatal("cannot replace corrupt state")
	}
	for _, body := range []string{`{}`, `{"clientId":"x","sequence":1,"snapshot":{"schema":1,"track":{"id":"x"},"position":-1}}`, strings.Repeat("x", (1<<20)+1)} {
		w := httptest.NewRecorder()
		server.ServeHTTP(w, httptest.NewRequest(http.MethodPut, "/api/playback", strings.NewReader(body)))
		if w.Code != 400 && w.Code != 413 {
			t.Errorf("invalid request status: %d", w.Code)
		}
		if getPlayback(t, server).Position != 12 {
			t.Fatal("invalid request destroyed saved state")
		}
	}
	blocked := filepath.Join(dir, "not-a-directory")
	if err := os.WriteFile(blocked, []byte("file"), 0600); err != nil {
		t.Fatal(err)
	}
	broken := New(product.Load(), "test", "instance", blocked, true)
	if code := putPlayback(t, broken, 1, 10); code != 500 {
		t.Fatalf("disk failure incorrectly reported success: %d", code)
	}
}
