package server

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	product "github.com/aston314/mingming-music-tv"
	"github.com/aston314/mingming-music-tv/ui"
)

type Server struct {
	cfg                        product.Config
	version, instance, dataDir string
	fixture                    bool
	client                     *http.Client
	mu                         sync.RWMutex
	token                      string
	handler                    http.Handler
	scans                      scanManager
	playbackMu                 sync.Mutex
	playbackSequences          map[string]uint64
}

func New(cfg product.Config, version, instance, dataDir string, fixture bool) *Server {
	s := &Server{cfg: cfg, version: version, instance: instance, dataDir: dataDir, fixture: fixture, client: &http.Client{Timeout: 18 * time.Second}}
	mux := http.NewServeMux()
	mux.HandleFunc("/health", s.health)
	mux.HandleFunc("/api/status", s.health)
	mux.HandleFunc("/api/carousel", s.proxyGet)
	mux.HandleFunc("/api/netease/catalogue", s.proxyGet)
	mux.HandleFunc("/api/netease/catplaylists", s.proxyGet)
	mux.HandleFunc("/api/netease/comments", s.proxyGet)
	mux.HandleFunc("/api/aimusic/square", s.proxyGet)
	mux.HandleFunc("/api/aimusic/song", s.proxyGet)
	mux.HandleFunc("/api/comment", s.proxyGetOrPost)
	mux.HandleFunc("/api/captcha", s.proxyGet)
	mux.HandleFunc("/api/music/search", s.proxyPost)
	mux.HandleFunc("/api/music/list", s.proxyPost)
	mux.HandleFunc("/api/music/url", s.proxyPost)
	mux.HandleFunc("/api/music/pic", s.proxyPost)
	mux.HandleFunc("/api/music/lrc", s.proxyPost)
	mux.HandleFunc("/api/word-lyric", s.proxyGet)
	// Account requests are the only upstream calls that carry the private session.
	mux.HandleFunc("/api/user", s.user)
	mux.HandleFunc("/api/logout", s.logout)
	mux.HandleFunc("/api/library", s.library)
	mux.HandleFunc("/api/playback", s.playback)
	mux.HandleFunc("/api/scan", s.scanAPI)
	mux.HandleFunc("/api/scan/", s.scanAPI)
	mux.HandleFunc("/media", s.media)
	mux.HandleFunc("/", s.assets)
	s.handler = withHeaders(mux)
	return s
}

func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) { s.handler.ServeHTTP(w, r) }

func withHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("X-Mingming-Core", "1")
		next.ServeHTTP(w, r)
	})
}

func (s *Server) health(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"ready": true, "service": "mingming-music-core", "instance_id": s.instance, "version": s.version, "product": s.cfg, "capabilities": map[string]bool{"music": true, "account": true, "playback": true, "fixture": s.fixture}})
}

func (s *Server) assets(w http.ResponseWriter, r *http.Request) {
	name := strings.TrimPrefix(r.URL.Path, "/")
	if name == "" {
		name = "index.html"
	}
	data, err := ui.Files.ReadFile(name)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	contentType := "text/plain; charset=utf-8"
	if strings.HasSuffix(name, ".html") {
		contentType = "text/html; charset=utf-8"
	} else if strings.HasSuffix(name, ".css") {
		contentType = "text/css; charset=utf-8"
	} else if strings.HasSuffix(name, ".js") {
		contentType = "application/javascript; charset=utf-8"
	}
	w.Header().Set("Content-Type", contentType)
	_, _ = w.Write(data)
}

func (s *Server) proxyGet(w http.ResponseWriter, r *http.Request) {
	if s.fixture {
		s.fixtureResponse(w, r)
		return
	}
	s.forward(w, r, http.MethodGet, nil)
}
func (s *Server) proxyGetOrPost(w http.ResponseWriter, r *http.Request) {
	if s.fixture {
		s.fixtureResponse(w, r)
		return
	}
	s.forward(w, r, r.Method, readBody(r))
}
func (s *Server) proxyPost(w http.ResponseWriter, r *http.Request) {
	if s.fixture {
		s.fixtureResponse(w, r)
		return
	}
	s.forward(w, r, http.MethodPost, readBody(r))
}

func readBody(r *http.Request) []byte { b, _ := io.ReadAll(io.LimitReader(r.Body, 256<<10)); return b }

func (s *Server) forward(w http.ResponseWriter, r *http.Request, method string, body []byte) {
	u, err := url.Parse(strings.TrimRight(s.cfg.Upstream, "/") + r.URL.Path)
	if err != nil {
		http.Error(w, "上游地址无效", 502)
		return
	}
	u.RawQuery = r.URL.RawQuery
	req, err := http.NewRequestWithContext(r.Context(), method, u.String(), bytes.NewReader(body))
	if err != nil {
		http.Error(w, "请求创建失败", 502)
		return
	}
	for _, key := range []string{"Content-Type", "Accept", "User-Agent"} {
		if v := r.Header.Get(key); v != "" {
			req.Header.Set(key, v)
		}
	}
	req.Header.Set("User-Agent", "MingmingMusicTV/"+s.cfg.VersionName)
	if auth := s.authHeader(); auth != "" && r.URL.Path == "/api/comment" {
		req.Header.Set("Authorization", auth)
	}
	resp, err := s.client.Do(req)
	if err != nil {
		http.Error(w, "音乐服务暂时不可用", 502)
		return
	}
	defer resp.Body.Close()
	w.Header().Set("Content-Type", resp.Header.Get("Content-Type"))
	w.WriteHeader(resp.StatusCode)
	_, _ = io.Copy(w, io.LimitReader(resp.Body, 2<<20))
}

func (s *Server) user(w http.ResponseWriter, r *http.Request) {
	body := readBody(r)
	var input map[string]any
	_ = json.Unmarshal(body, &input)
	if r.Method == http.MethodPost {
		if err := validateAccount(input); err != nil {
			writeJSON(w, 400, map[string]any{"error": err.Error(), "success": false})
			return
		}
	}
	if s.fixture {
		s.fixtureResponse(w, r)
		return
	}
	if r.Method == http.MethodGet {
		body = nil
	}
	data, status, err := s.accountRequest(r.Context(), r.Method, r.URL.RawQuery, body)
	if err != nil {
		http.Error(w, "账号服务暂时不可用", 502)
		return
	}
	if r.Method == http.MethodPost && status < 400 {
		s.captureToken(data)
	}
	var out any
	if json.Unmarshal(data, &out) != nil {
		http.Error(w, "账号响应无效", 502)
		return
	}
	scrubToken(out)
	writeJSON(w, status, out)
}

// Both TV and phone use this account adapter. It never publishes a session itself.
func (s *Server) accountRequest(ctx context.Context, method, query string, body []byte) ([]byte, int, error) {
	if s.fixture {
		return []byte(`{"success":true,"token":"fixture-private-session"}`), 200, nil
	}
	u, err := url.Parse(strings.TrimRight(s.cfg.Upstream, "/") + "/api/user")
	if err != nil {
		return nil, 502, err
	}
	u.RawQuery = query
	req, err := http.NewRequestWithContext(ctx, method, u.String(), bytes.NewReader(body))
	if err != nil {
		return nil, 502, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", "MingmingMusicTV/"+s.cfg.VersionName)
	if auth := s.authHeader(); auth != "" {
		req.Header.Set("Authorization", auth)
	}
	resp, err := s.client.Do(req)
	if err != nil {
		return nil, 502, err
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(io.LimitReader(resp.Body, 2<<20))
	return data, resp.StatusCode, err
}

func (s *Server) captureToken(data []byte) {
	var v any
	if json.Unmarshal(data, &v) != nil {
		return
	}
	if token := findToken(v); token != "" {
		s.mu.Lock()
		s.token = token
		s.mu.Unlock()
		_ = os.MkdirAll(s.dataDir, 0700)
		_ = os.WriteFile(filepath.Join(s.dataDir, "session.token"), []byte(token), 0600)
	}
}
func (s *Server) authHeader() string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	token := s.token
	if token == "" {
		if b, err := os.ReadFile(filepath.Join(s.dataDir, "session.token")); err == nil {
			token = string(b)
		}
	}
	if token == "" {
		return ""
	}
	return "Bearer " + token
}

func (s *Server) logout(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	s.mu.Lock()
	s.token = ""
	err := os.Remove(filepath.Join(s.dataDir, "session.token"))
	s.mu.Unlock()
	if err != nil && !os.IsNotExist(err) {
		http.Error(w, "退出登录失败", http.StatusInternalServerError)
		return
	}
	library := s.readLibrary()
	library["favorites"] = []any{}
	library["playlists"] = []any{}
	library["authenticated"] = false
	library["synced"] = false
	if err := s.writeLibrary(library); err != nil {
		http.Error(w, "保存失败", http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, library)
}

func findToken(v any) string {
	switch x := v.(type) {
	case map[string]any:
		for k, value := range x {
			if strings.EqualFold(k, "token") || strings.EqualFold(k, "access_token") {
				if t, ok := value.(string); ok {
					return t
				}
			}
			if t := findToken(value); t != "" {
				return t
			}
		}
	case []any:
		for _, value := range x {
			if t := findToken(value); t != "" {
				return t
			}
		}
	}
	return ""
}
func scrubToken(v any) {
	switch x := v.(type) {
	case map[string]any:
		for k := range x {
			if strings.EqualFold(k, "token") || strings.EqualFold(k, "access_token") {
				delete(x, k)
			} else {
				scrubToken(x[k])
			}
		}
	case []any:
		for _, value := range x {
			scrubToken(value)
		}
	}
}

func (s *Server) library(w http.ResponseWriter, r *http.Request) {
	// Guests use the private store. Once a session exists, the same endpoint mirrors
	// the upstream account fields used by the website: favorites and playlist.
	if r.Method == http.MethodGet {
		local := s.readLibrary()
		if cloud, ok := s.downloadLibrary(r.Context()); ok {
			local = map[string]any{
				"favorites":     cloud.favorites,
				"playlists":     cloud.playlist,
				"recent":        libraryArray(s.readLibrary(), "recent"),
				"authenticated": true,
				"synced":        true,
			}
			s.writeLibrary(local)
		} else {
			local["authenticated"] = s.authHeader() != ""
			local["synced"] = false
		}
		writeJSON(w, http.StatusOK, local)
		return
	}
	if r.Method != http.MethodPut {
		http.Error(w, "method not allowed", 405)
		return
	}
	body := readBody(r)
	var input map[string]any
	if json.Unmarshal(body, &input) != nil {
		http.Error(w, "invalid library", 400)
		return
	}
	if len(body) > 2<<20 {
		http.Error(w, "library too large", 413)
		return
	}
	local := normalizeLibrary(input)
	synced := false
	if s.authHeader() != "" {
		merge, _ := input["merge"].(bool)
		if cloud, ok := s.uploadLibrary(r.Context(), local, merge); ok {
			local = map[string]any{
				"favorites":     cloud.favorites,
				"playlists":     cloud.playlist,
				"recent":        libraryArray(local, "recent"),
				"authenticated": true,
				"synced":        true,
			}
			synced = true
		}
	}
	if !synced {
		local["authenticated"] = s.authHeader() != ""
		local["synced"] = false
	}
	if err := s.writeLibrary(local); err != nil {
		http.Error(w, "保存失败", 500)
		return
	}
	writeJSON(w, http.StatusOK, local)
}

type cloudLibrary struct {
	userID    string
	favorites []any
	playlist  []any
}

func (s *Server) readLibrary() map[string]any {
	data, err := os.ReadFile(filepath.Join(s.dataDir, "library.json"))
	if err != nil {
		return map[string]any{"favorites": []any{}, "playlists": []any{}}
	}
	var value map[string]any
	if json.Unmarshal(data, &value) != nil {
		return map[string]any{"favorites": []any{}, "playlists": []any{}}
	}
	return normalizeLibrary(value)
}

func (s *Server) writeLibrary(value map[string]any) error {
	data, err := json.Marshal(normalizeLibrary(value))
	if err != nil {
		return err
	}
	if err := os.MkdirAll(s.dataDir, 0700); err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(s.dataDir, "library.json"), data, 0600)
}

func normalizeLibrary(value map[string]any) map[string]any {
	if value == nil {
		value = map[string]any{}
	}
	favorites, ok := value["favorites"].([]any)
	if !ok || favorites == nil {
		favorites = []any{}
	}
	playlists, ok := value["playlists"].([]any)
	if !ok || playlists == nil {
		playlists = []any{}
	}
	recent, ok := value["recent"].([]any)
	if !ok || recent == nil {
		recent = []any{}
	}
	return map[string]any{"favorites": favorites, "playlists": playlists, "recent": recent}
}

func libraryArray(value map[string]any, key string) []any {
	items, _ := value[key].([]any)
	if items == nil {
		return []any{}
	}
	return items
}

func (s *Server) downloadLibrary(ctx context.Context) (cloudLibrary, bool) {
	if s.fixture {
		local := s.readLibrary()
		return cloudLibrary{userID: "fixture-user", favorites: libraryArray(local, "favorites"), playlist: libraryArray(local, "playlists")}, s.authHeader() != ""
	}
	if s.authHeader() == "" {
		return cloudLibrary{}, false
	}
	u, err := url.Parse(strings.TrimRight(s.cfg.Upstream, "/") + "/api/user")
	if err != nil {
		return cloudLibrary{}, false
	}
	q := u.Query()
	q.Set("action", "me")
	u.RawQuery = q.Encode()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return cloudLibrary{}, false
	}
	req.Header.Set("Authorization", s.authHeader())
	req.Header.Set("User-Agent", "MingmingMusicTV/"+s.cfg.VersionName)
	resp, err := s.client.Do(req)
	if err != nil {
		return cloudLibrary{}, false
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return cloudLibrary{}, false
	}
	var value map[string]any
	if json.NewDecoder(io.LimitReader(resp.Body, 2<<20)).Decode(&value) != nil {
		return cloudLibrary{}, false
	}
	userValue, exists := value["userId"]
	if !exists || userValue == nil {
		return cloudLibrary{}, false
	}
	userID := fmt.Sprint(userValue)
	if userID == "" {
		return cloudLibrary{}, false
	}
	favorites, favOK := value["favorites"].([]any)
	playlist, playlistOK := value["playlist"].([]any)
	if !favOK {
		favorites = []any{}
	}
	if !playlistOK {
		playlist = []any{}
	}
	return cloudLibrary{userID: userID, favorites: favorites, playlist: playlist}, true
}

func (s *Server) uploadLibrary(ctx context.Context, local map[string]any, merge bool) (cloudLibrary, bool) {
	cloud, hasCloud := s.downloadLibrary(ctx)
	favorites, _ := local["favorites"].([]any)
	playlists, _ := local["playlists"].([]any)
	if merge && hasCloud {
		favorites = mergeLibraryItems(cloud.favorites, favorites)
		playlists = mergeLibraryItems(cloud.playlist, playlists)
	}
	if !hasCloud {
		return cloudLibrary{}, false
	}
	if s.fixture {
		return cloudLibrary{userID: cloud.userID, favorites: favorites, playlist: playlists}, true
	}
	now := time.Now().UnixMilli()
	body, err := json.Marshal(map[string]any{
		"userId":             cloud.userID,
		"favorites":          favorites,
		"playlist":           playlists,
		"favoritesUpdatedAt": now,
		"playlistUpdatedAt":  now,
	})
	if err != nil {
		return cloudLibrary{}, false
	}
	u := strings.TrimRight(s.cfg.Upstream, "/") + "/api/user"
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, u, bytes.NewReader(body))
	if err != nil {
		return cloudLibrary{}, false
	}
	req.Header.Set("Authorization", s.authHeader())
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", "MingmingMusicTV/"+s.cfg.VersionName)
	resp, err := s.client.Do(req)
	if err != nil {
		return cloudLibrary{}, false
	}
	defer resp.Body.Close()
	var result map[string]any
	_ = json.NewDecoder(io.LimitReader(resp.Body, 2<<20)).Decode(&result)
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return cloudLibrary{}, false
	}
	if success, exists := result["success"].(bool); exists && !success {
		return cloudLibrary{}, false
	}
	return cloudLibrary{userID: cloud.userID, favorites: favorites, playlist: playlists}, true
}

func mergeLibraryItems(first, second []any) []any {
	result := make([]any, 0, len(first)+len(second))
	seen := map[string]bool{}
	for _, item := range append(append([]any{}, first...), second...) {
		key := libraryItemKey(item)
		if seen[key] {
			continue
		}
		seen[key] = true
		result = append(result, item)
	}
	return result
}

func libraryItemKey(item any) string {
	if value, ok := item.(map[string]any); ok {
		for _, field := range []string{"id", "songId", "musicId", "url_id"} {
			if id, exists := value[field]; exists {
				return field + ":" + fmt.Sprint(id)
			}
		}
	}
	data, err := json.Marshal(item)
	if err != nil {
		return fmt.Sprintf("%#v", item)
	}
	return string(data)
}

func (s *Server) media(w http.ResponseWriter, r *http.Request) {
	target := r.URL.Query().Get("url")
	parsed, err := url.Parse(target)
	if err != nil {
		http.Error(w, "媒体地址无效", 400)
		return
	}
	if parsed.Scheme == "" && strings.HasPrefix(parsed.Path, "/") {
		base, baseErr := url.Parse(strings.TrimRight(s.cfg.Upstream, "/"))
		if baseErr != nil {
			http.Error(w, "媒体地址无效", 400)
			return
		}
		target = base.ResolveReference(parsed).String()
		parsed, _ = url.Parse(target)
	}
	if parsed.Scheme != "https" && parsed.Scheme != "http" {
		http.Error(w, "媒体地址无效", 400)
		return
	}
	req, err := http.NewRequestWithContext(r.Context(), http.MethodGet, target, nil)
	if err != nil {
		http.Error(w, "媒体请求失败", 400)
		return
	}
	if rangeValue := r.Header.Get("Range"); rangeValue != "" {
		req.Header.Set("Range", rangeValue)
	}
	resp, err := s.client.Do(req)
	if err != nil {
		http.Error(w, "媒体暂时不可用", 502)
		return
	}
	defer resp.Body.Close()
	w.Header().Set("Content-Type", resp.Header.Get("Content-Type"))
	if v := resp.Header.Get("Content-Range"); v != "" {
		w.Header().Set("Content-Range", v)
	}
	if v := resp.Header.Get("Accept-Ranges"); v != "" {
		w.Header().Set("Accept-Ranges", v)
	}
	w.WriteHeader(resp.StatusCode)
	_, _ = io.CopyN(w, resp.Body, 64<<20)
}

func (s *Server) fixtureResponse(w http.ResponseWriter, r *http.Request) {
	path := r.URL.Path
	switch {
	case path == "/api/carousel":
		writeJSON(w, 200, map[string]any{"success": true, "items": []any{
			map[string]any{"imageUrl": "https://picsum.photos/seed/mingming-banner-1/1200/360", "searchText": "华语精选"},
			map[string]any{"imageUrl": "https://picsum.photos/seed/mingming-banner-2/1200/360", "searchText": "夜晚氛围"},
			map[string]any{"imageUrl": "https://picsum.photos/seed/mingming-banner-3/1200/360", "searchText": "通勤歌单"},
		}})
	case path == "/api/netease/catalogue":
		writeJSON(w, 200, map[string]any{"sub": fixtureCatalogue()})
	case path == "/api/netease/catplaylists":
		writeJSON(w, 200, map[string]any{"code": 200, "playlists": fixturePlaylists(r.URL.Query().Get("cat"))})
	case path == "/api/music/list":
		writeJSON(w, 200, map[string]any{"code": 200, "data": map[string]any{"playlist": map[string]any{"tracks": fixturePlaylistTracks()}}})
	case path == "/api/aimusic/square":
		writeJSON(w, 200, map[string]any{"code": 1, "data": fixtureSongs()})
	case path == "/api/music/search":
		writeJSON(w, 200, map[string]any{"code": 1, "msg": "获取成功", "data": fixtureSongs()})
	case path == "/api/music/url":
		writeJSON(w, 200, map[string]any{"code": 1, "data": "https://www.soundhelix.com/examples/mp3/SoundHelix-Song-1.mp3"})
	case path == "/api/music/lrc":
		writeJSON(w, 200, map[string]any{"code": 1, "data": "[00:00.00] 明明音乐\n[00:08.00] 预览歌词"})
	case path == "/api/comment" || path == "/api/netease/comments":
		all := fixtureComments()
		offset, _ := strconv.Atoi(r.URL.Query().Get("offset"))
		limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
		if offset < 0 {
			offset = 0
		}
		if limit <= 0 || limit > 50 {
			limit = 10
		}
		if offset > len(all) {
			offset = len(all)
		}
		end := offset + limit
		if end > len(all) {
			end = len(all)
		}
		writeJSON(w, 200, map[string]any{"code": 1, "comments": all[offset:end], "total": len(all), "more": end < len(all)})
	case path == "/api/user":
		writeJSON(w, 200, map[string]any{"code": 1, "msg": "登录成功", "data": map[string]any{"username": "预览用户"}})
	case path == "/api/captcha":
		writeJSON(w, 200, map[string]any{"captchaId": "fixture-captcha", "svg": "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"180\" height=\"60\"><rect width=\"180\" height=\"60\" fill=\"#ffffff\"/><text x=\"20\" y=\"40\" font-size=\"28\" fill=\"#182319\">A7K2</text></svg>"})
	default:
		writeJSON(w, 200, map[string]any{"code": 1, "data": []any{}})
	}
}
func fixtureSongs() []map[string]any {
	return []map[string]any{{"id": "287398", "name": "晴天", "artist": "周杰伦", "album": "叶惠美", "pic_id": "https://picsum.photos/seed/song1/300/300"}, {"id": "509781655", "name": "稻香", "artist": "周杰伦", "album": "魔杰座", "pic_id": "https://picsum.photos/seed/song2/300/300"}, {"id": "1308454685", "name": "夜曲", "artist": "周杰伦", "album": "十一月的萧邦", "pic_id": "https://picsum.photos/seed/song3/300/300"}}
}

func fixtureCatalogue() []map[string]any {
	items := []map[string]any{}
	for _, name := range []string{"华语", "欧美", "日语", "韩语", "粤语"} {
		items = append(items, map[string]any{"name": name, "category": 0})
	}
	for _, name := range []string{"流行", "摇滚", "民谣", "电子", "古典"} {
		items = append(items, map[string]any{"name": name, "category": 1})
	}
	for _, name := range []string{"学习", "工作", "旅行", "运动", "睡眠"} {
		items = append(items, map[string]any{"name": name, "category": 2})
	}
	for _, name := range []string{"放松", "快乐", "伤感", "治愈", "浪漫"} {
		items = append(items, map[string]any{"name": name, "category": 3})
	}
	for _, name := range []string{"经典", "怀旧", "儿童", "游戏", "影视原声"} {
		items = append(items, map[string]any{"name": name, "category": 4})
	}
	return items
}

func fixturePlaylists(cat string) []map[string]any {
	if cat == "" {
		cat = "华语"
	}
	return []map[string]any{
		{"id": "fixture-" + cat + "-1", "name": cat + " · 私藏精选", "coverImgUrl": "https://picsum.photos/seed/playlist-" + cat + "-1/360/360", "creator": map[string]any{"nickname": "明明音乐"}, "trackCount": 12, "playCount": 18342},
		{"id": "fixture-" + cat + "-2", "name": cat + " · 热门循环", "coverImgUrl": "https://picsum.photos/seed/playlist-" + cat + "-2/360/360", "creator": map[string]any{"nickname": "音乐编辑部"}, "trackCount": 24, "playCount": 9265},
		{"id": "fixture-" + cat + "-3", "name": cat + " · 新歌上架", "coverImgUrl": "https://picsum.photos/seed/playlist-" + cat + "-3/360/360", "creator": map[string]any{"nickname": "今日推荐"}, "trackCount": 18, "playCount": 6411},
	}
}

func fixturePlaylistTracks() []map[string]any {
	return []map[string]any{
		{"id": 287398, "name": "晴天", "ar": []map[string]any{{"name": "周杰伦"}}, "al": map[string]any{"name": "叶惠美", "picUrl": "https://picsum.photos/seed/song1/300/300"}},
		{"id": 509781655, "name": "稻香", "ar": []map[string]any{{"name": "周杰伦"}}, "al": map[string]any{"name": "魔杰座", "picUrl": "https://picsum.photos/seed/song2/300/300"}},
		{"id": 1308454685, "name": "夜曲", "ar": []map[string]any{{"name": "周杰伦"}}, "al": map[string]any{"name": "十一月的萧邦", "picUrl": "https://picsum.photos/seed/song3/300/300"}},
	}
}

func fixtureComments() []map[string]any {
	items := make([]map[string]any, 0, 24)
	for i := 1; i <= 24; i++ {
		items = append(items, map[string]any{
			"content":    "这是明明音乐 TV 预览的第 " + strconv.Itoa(i) + " 条评论",
			"timeStr":    "2026-10-11",
			"likedCount": 10 + i,
			"user": map[string]any{
				"nickname":  "预览用户" + strconv.Itoa(i),
				"avatarUrl": "https://picsum.photos/seed/mingming-user-" + strconv.Itoa(i) + "/80/80",
			},
		})
	}
	return items
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	data, _ := json.Marshal(value)
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_, _ = w.Write(data)
}
