package server

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/cookiejar"
	"net/url"
	"strings"
	"sync"
	"time"
)

// Only anonymous music reads use this jar. Account Bearer tokens and external
// media requests keep their existing clients and never receive these cookies.
type musicPassState struct {
	mu         sync.Mutex
	revision   uint64
	refreshing chan struct{}
	lastError  error
	retryAfter time.Time
}

func newMusicClient(base *http.Client) *http.Client {
	client := *base
	client.Jar, _ = cookiejar.New(nil)
	client.CheckRedirect = func(req *http.Request, via []*http.Request) error {
		if len(via) >= 10 {
			return errors.New("too many music service redirects")
		}
		if len(via) > 0 && (req.URL.Scheme != via[0].URL.Scheme || req.URL.Host != via[0].URL.Host) {
			return http.ErrUseLastResponse
		}
		return nil
	}
	return &client
}

func musicPassRequired(path string) bool {
	switch path {
	case "/api/music/search", "/api/music/list", "/api/music/url", "/api/music/pic", "/api/music/lrc", "/api/word-lyric":
		return true
	}
	return false
}

func (s *Server) musicRequest(req *http.Request) (*http.Response, error) {
	s.musicPass.mu.Lock()
	revision := s.musicPass.revision
	s.musicPass.mu.Unlock()
	resp, err := s.musicClient.Do(req)
	if err != nil || resp.StatusCode != http.StatusUnauthorized {
		return resp, err
	}
	// A 401 can have other meanings. Refresh only the explicit anonymous-pass
	// error, preserving other upstream errors instead of treating them as login.
	body, err := io.ReadAll(io.LimitReader(resp.Body, 2<<20))
	resp.Body.Close()
	if err != nil {
		return nil, err
	}
	resp.Body = io.NopCloser(bytes.NewReader(body))
	var result struct {
		Error string `json:"error"`
	}
	if json.Unmarshal(body, &result) != nil || result.Error != "NEED_PASS" {
		return resp, nil
	}
	if err := s.refreshMusicPass(req.Context(), revision); err != nil {
		// Keep the original error usable by the UI and avoid exposing cookie or
		// ticket values. Subsequent calls can retry after the short cooldown.
		if req.Context().Err() != nil {
			return nil, req.Context().Err()
		}
		return resp, nil
	}
	retry := req.Clone(req.Context())
	// Client.Do added the old jar cookies to the first request's header. Let
	// the jar supply only the refreshed values; duplicate mm_pass cookies can
	// otherwise make the upstream read the revoked value first.
	retry.Header.Del("Cookie")
	if req.GetBody != nil {
		retry.Body, err = req.GetBody()
		if err != nil {
			return nil, err
		}
	}
	// At most one replay: a continued NEED_PASS is returned to the caller.
	return s.musicClient.Do(retry)
}

func (s *Server) refreshMusicPass(ctx context.Context, revision uint64) error {
	pass := &s.musicPass
	pass.mu.Lock()
	if pass.revision != revision {
		pass.mu.Unlock()
		return nil
	}
	if pass.refreshing != nil {
		done := pass.refreshing
		pass.mu.Unlock()
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-done:
			pass.mu.Lock()
			err := pass.lastError
			pass.mu.Unlock()
			return err
		}
	}
	if time.Now().Before(pass.retryAfter) {
		err := pass.lastError
		pass.mu.Unlock()
		return err
	}
	done := make(chan struct{})
	pass.refreshing = done
	pass.mu.Unlock()

	err := s.acquireMusicPass(ctx)
	pass.mu.Lock()
	pass.lastError = err
	if err == nil {
		pass.revision++
		pass.retryAfter = time.Time{}
	} else {
		pass.retryAfter = time.Now().Add(2 * time.Second)
	}
	pass.refreshing = nil
	close(done)
	pass.mu.Unlock()
	return err
}

func (s *Server) acquireMusicPass(ctx context.Context) error {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	u, err := url.Parse(strings.TrimRight(s.cfg.Upstream, "/") + "/api/music-pass")
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return err
	}
	req.Header.Set("User-Agent", "MingmingMusicTV/"+s.cfg.VersionName)
	resp, err := s.musicClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return errors.New("music pass unavailable")
	}
	var result struct {
		Success bool `json:"success"`
	}
	if json.NewDecoder(io.LimitReader(resp.Body, 16<<10)).Decode(&result) != nil || !result.Success {
		return errors.New("invalid music pass response")
	}
	for _, issued := range resp.Cookies() {
		if issued.Name == "mm_pass" && issued.Value != "" {
			for _, stored := range s.musicClient.Jar.Cookies(u) {
				if stored.Name == issued.Name && stored.Value == issued.Value {
					return nil
				}
			}
		}
	}
	return errors.New("music pass cookie missing")
}
