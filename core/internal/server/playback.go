package server

import (
	"encoding/json"
	"io"
	"math"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// Playback belongs to this device, independently of account library sync and
// the loopback port. Only metadata is stored; media URLs must be resolved anew.
type playbackSnapshot struct {
	Schema     int              `json:"schema"`
	Track      map[string]any   `json:"track"`
	Position   float64          `json:"position"`
	Duration   float64          `json:"duration"`
	Mode       string           `json:"mode"`
	List       []map[string]any `json:"list"`
	ListSource string           `json:"listSource"`
	UpdatedAt  int64            `json:"updatedAt"`
}

func (s *Server) playback(w http.ResponseWriter, r *http.Request) {
	s.playbackMu.Lock()
	defer s.playbackMu.Unlock()
	path := filepath.Join(s.dataDir, "playback.json")
	if r.Method == http.MethodGet {
		var saved *playbackSnapshot
		var candidate playbackSnapshot
		if data, err := os.ReadFile(path); err == nil && json.Unmarshal(data, &candidate) == nil {
			saved = normalizePlayback(candidate)
		}
		writeJSON(w, http.StatusOK, map[string]any{"snapshot": saved})
		return
	}
	if r.Method != http.MethodPut {
		w.Header().Set("Allow", "GET, PUT")
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var input struct {
		Snapshot playbackSnapshot `json:"snapshot"`
		ClientID string           `json:"clientId"`
		Sequence uint64           `json:"sequence"`
	}
	data, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 1<<20))
	if err != nil {
		http.Error(w, "playback too large", http.StatusRequestEntityTooLarge)
		return
	}
	saved := (*playbackSnapshot)(nil)
	if json.Unmarshal(data, &input) == nil {
		saved = normalizePlayback(input.Snapshot)
	}
	if saved == nil || input.ClientID == "" || len(input.ClientID) > 80 || input.Sequence == 0 {
		http.Error(w, "invalid playback", http.StatusBadRequest)
		return
	}
	if s.playbackSequences[input.ClientID] >= input.Sequence {
		writeJSON(w, http.StatusOK, map[string]bool{"saved": true})
		return
	}
	saved.UpdatedAt = time.Now().UnixMilli()
	encoded, _ := json.Marshal(saved)
	if err := writePlaybackFile(path, encoded); err != nil {
		http.Error(w, "保存播放记录失败", http.StatusInternalServerError)
		return
	}
	if s.playbackSequences == nil || len(s.playbackSequences) >= 64 {
		s.playbackSequences = make(map[string]uint64)
	}
	s.playbackSequences[input.ClientID] = input.Sequence
	writeJSON(w, http.StatusOK, map[string]bool{"saved": true})
}

func normalizePlayback(value playbackSnapshot) *playbackSnapshot {
	value.Track = playbackTrack(value.Track)
	if value.Schema != 1 || value.Track == nil || !validPlaybackTime(value.Position) || !validPlaybackTime(value.Duration) {
		return nil
	}
	if value.Duration > 0 && value.Position > value.Duration {
		value.Position = value.Duration
	}
	if value.Mode != "one" && value.Mode != "shuffle" {
		value.Mode = "list"
	}
	if value.ListSource != "queue" && value.ListSource != "recent" && value.ListSource != "favorites" && value.ListSource != "search" && value.ListSource != "recommend" && value.ListSource != "playlists" {
		value.ListSource = ""
	}
	list := make([]map[string]any, 0, len(value.List))
	for _, track := range value.List {
		if clean := playbackTrack(track); clean != nil {
			list = append(list, clean)
			if len(list) == 500 {
				break
			}
		}
	}
	value.List = list
	return &value
}

func validPlaybackTime(value float64) bool {
	return !math.IsNaN(value) && !math.IsInf(value, 0) && value >= 0 && value <= 7*24*60*60
}

func playbackTrack(track map[string]any) map[string]any {
	var id any
	switch value := track["id"].(type) {
	case string:
		if value != "" && len(value) <= 256 {
			id = value
		}
	case float64:
		if value > 0 && !math.IsNaN(value) && !math.IsInf(value, 0) {
			id = value
		}
	}
	if id == nil {
		return nil
	}
	clean := map[string]any{"id": id}
	for _, key := range []string{"name", "title", "mainTitle", "artist", "album", "type", "provider", "source", "picUrl", "coverPath", "image", "pic", "pic_id"} {
		if text, ok := track[key].(string); ok && len(text) <= 2048 {
			clean[key] = text
		}
	}
	for _, key := range []string{"dt", "duration", "interval", "time"} {
		if number, ok := track[key].(float64); ok && number >= 0 && number <= 604800000 {
			clean[key] = number
		}
	}
	for _, key := range []string{"ar", "artists"} {
		if artists, ok := track[key].([]any); ok {
			items := []any{}
			for _, artist := range artists {
				if text, ok := artist.(string); ok && len(text) <= 256 {
					items = append(items, text)
				} else if fields, ok := artist.(map[string]any); ok {
					if name, ok := fields["name"].(string); ok && len(name) <= 256 {
						items = append(items, map[string]any{"name": name})
					}
				}
				if len(items) == 20 {
					break
				}
			}
			clean[key] = items
		}
	}
	if album, ok := track["al"].(map[string]any); ok {
		fields := map[string]any{}
		for _, key := range []string{"name", "picUrl"} {
			if text, ok := album[key].(string); ok && len(text) <= 2048 {
				fields[key] = text
			}
		}
		clean["al"] = fields
	}
	return clean
}

// Rename only a complete, flushed file so an interrupted write leaves the
// previous playback state usable.
func writePlaybackFile(path string, data []byte) error {
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return err
	}
	file, err := os.CreateTemp(filepath.Dir(path), ".playback-*")
	if err != nil {
		return err
	}
	defer os.Remove(file.Name())
	_, err = io.Copy(file, strings.NewReader(string(data)))
	if err == nil {
		err = file.Sync()
	}
	if closeErr := file.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		return err
	}
	return os.Rename(file.Name(), path)
}
