package server

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"testing"

	product "github.com/aston314/mingming-music-tv"
)

func TestMediaStreamsFullResponseAndRangeHeaders(t *testing.T) {
	full := bytes.Repeat([]byte("0123456789abcdef"), 8192)
	source := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "audio/mpeg")
		w.Header().Set("Accept-Ranges", "bytes")
		w.Header().Set("ETag", "test-etag")
		rangeValue := r.Header.Get("Range")
		if rangeValue == "" {
			w.Header().Set("Content-Length", strconv.Itoa(len(full)))
			_, _ = w.Write(full)
			return
		}
		if rangeValue != "bytes=32-95" {
			http.Error(w, "unexpected range", http.StatusBadRequest)
			return
		}
		part := full[32:96]
		w.Header().Set("Content-Length", strconv.Itoa(len(part)))
		w.Header().Set("Content-Range", "bytes 32-95/"+strconv.Itoa(len(full)))
		w.WriteHeader(http.StatusPartialContent)
		_, _ = w.Write(part)
	}))
	defer source.Close()

	h := New(product.Load(), "test", "media", t.TempDir(), false)
	fullURL := "/media?url=" + url.QueryEscape(source.URL+"/song.mp3")
	fullRequest := httptest.NewRequest(http.MethodGet, fullURL, nil)
	fullRecorder := httptest.NewRecorder()
	h.ServeHTTP(fullRecorder, fullRequest)
	if fullRecorder.Code != http.StatusOK {
		t.Fatalf("full status = %d", fullRecorder.Code)
	}
	if got := fullRecorder.Header().Get("Content-Length"); got != strconv.Itoa(len(full)) {
		t.Fatalf("full Content-Length = %q", got)
	}
	if !bytes.Equal(fullRecorder.Body.Bytes(), full) {
		t.Fatalf("full body length = %d, want %d", fullRecorder.Body.Len(), len(full))
	}

	rangeRequest := httptest.NewRequest(http.MethodGet, fullURL, nil)
	rangeRequest.Header.Set("Range", "bytes=32-95")
	rangeRecorder := httptest.NewRecorder()
	h.ServeHTTP(rangeRecorder, rangeRequest)
	if rangeRecorder.Code != http.StatusPartialContent {
		t.Fatalf("range status = %d", rangeRecorder.Code)
	}
	if got := rangeRecorder.Header().Get("Content-Range"); got != "bytes 32-95/"+strconv.Itoa(len(full)) {
		t.Fatalf("Content-Range = %q", got)
	}
	if got := rangeRecorder.Header().Get("Content-Length"); got != "64" {
		t.Fatalf("range Content-Length = %q", got)
	}
	if !bytes.Equal(rangeRecorder.Body.Bytes(), full[32:96]) {
		t.Fatalf("range body = %d bytes", rangeRecorder.Body.Len())
	}
}

func TestMediaClientHasNoTotalBodyTimeout(t *testing.T) {
	h := New(product.Load(), "test", "media", t.TempDir(), false)
	if h.mediaClient == nil || h.mediaClient.Timeout != 0 {
		t.Fatalf("media client timeout = %v, want no total body timeout", h.mediaClient.Timeout)
	}
	if h.mediaClient.Transport == nil {
		t.Fatal("media client has no transport")
	}
	transport, ok := h.mediaClient.Transport.(*http.Transport)
	if !ok || transport.ResponseHeaderTimeout <= 0 {
		t.Fatal("media client must bound response headers while allowing body streaming")
	}
}
