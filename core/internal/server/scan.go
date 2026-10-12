package server

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/aston314/mingming-music-tv/ui"
	qrcode "github.com/skip2/go-qrcode"
)

const scanTTL = 5 * time.Minute

type scanSession struct {
	ID, Scope, Code, State, Value, Message string
	Expires                                time.Time
	Connected                              bool
	Cancel                                 context.CancelFunc
	Context                                context.Context
	CaptchaID                              string
	CaptchaSVG                             string
	CaptchaVersion                         uint64
	Pending                                map[string]any
	Devices                                []any
}
type scanManager struct {
	sync.Mutex
	Sessions map[string]*scanSession
	Port     int
	Now      func() time.Time
}

func (m *scanManager) now() time.Time {
	if m.Now != nil {
		return m.Now()
	}
	return time.Now()
}
func (m *scanManager) expire(v *scanSession) {
	if !m.now().Before(v.Expires) && v.State != "expired" {
		v.State = "expired"
		v.Value = ""
		v.Pending = nil
		v.Devices = nil
		v.CaptchaID, v.CaptchaSVG = "", ""
		v.Cancel()
	}
}
func (m *scanManager) cancelAll() {
	for _, v := range m.Sessions {
		if v.State != "complete" {
			v.State = "cancelled"
		}
		v.Value = ""
		v.Pending = nil
		v.Devices = nil
		v.CaptchaID, v.CaptchaSVG = "", ""
		v.Cancel()
	}
}
func scanOpen(v *scanSession) bool {
	return v.State == "waiting" || v.State == "processing" || v.State == "device_limit"
}
func scanView(v *scanSession, now time.Time) map[string]any {
	remaining := int(v.Expires.Sub(now).Seconds())
	if remaining < 0 {
		remaining = 0
	}
	return map[string]any{"id": v.ID, "scope": v.Scope, "code": v.Code, "state": v.State, "connected": v.Connected, "remaining": remaining, "expiresAt": v.Expires.UnixMilli(), "value": v.Value, "message": v.Message}
}

// The phone listener intentionally exposes only scoped pairing pages, never the
// TV's account/library/media API. Its port is dynamic on Android and in preview.
func (s *Server) StartCompanion(ctx context.Context) error {
	listener, err := net.Listen("tcp4", "0.0.0.0:0")
	if err != nil {
		return err
	}
	s.scans.Lock()
	s.scans.Port = listener.Addr().(*net.TCPAddr).Port
	s.scans.Unlock()
	service := &http.Server{Handler: s.PhoneHandler(), ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 25 * time.Second, WriteTimeout: 25 * time.Second, IdleTimeout: 30 * time.Second, MaxHeaderBytes: 16 << 10}
	go func() { <-ctx.Done(); s.scans.Lock(); s.scans.cancelAll(); s.scans.Unlock(); _ = service.Close() }()
	go func() { _ = service.Serve(listener) }()
	go func() {
		ticker := time.NewTicker(time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				s.scans.Lock()
				for id, v := range s.scans.Sessions {
					s.scans.expire(v)
					if !s.scans.now().Before(v.Expires.Add(time.Minute)) {
						delete(s.scans.Sessions, id)
					}
				}
				s.scans.Unlock()
			}
		}
	}()
	return nil
}
func lanAddress() string {
	interfaces, _ := net.Interfaces()
	for _, iface := range interfaces {
		if iface.Flags&net.FlagUp == 0 || iface.Flags&net.FlagLoopback != 0 || strings.HasPrefix(iface.Name, "utun") || strings.HasPrefix(iface.Name, "tun") {
			continue
		}
		addresses, _ := iface.Addrs()
		for _, address := range addresses {
			ip, _, err := net.ParseCIDR(address.String())
			if err == nil && ip.To4() != nil && ip.IsPrivate() {
				return ip.String()
			}
		}
	}
	// Android may restrict interface enumeration; UDP connect selects a route
	// without transmitting a packet or requiring a Java networking bridge.
	connection, err := net.Dial("udp4", "192.0.2.1:80")
	if err == nil {
		defer connection.Close()
		ip := connection.LocalAddr().(*net.UDPAddr).IP
		if ip.IsPrivate() {
			return ip.String()
		}
	}
	return ""
}
func sameOrigin(r *http.Request) bool {
	origin := r.Header.Get("Origin")
	if origin == "" {
		return true
	}
	u, err := url.Parse(origin)
	return err == nil && u.Host == r.Host && (u.Scheme == "http" || u.Scheme == "https")
}
func scanDecode(w http.ResponseWriter, r *http.Request, value any) bool {
	if !sameOrigin(r) {
		writeJSON(w, 403, map[string]any{"error": "来源无效"})
		return false
	}
	if !strings.HasPrefix(r.Header.Get("Content-Type"), "application/json") {
		writeJSON(w, 415, map[string]any{"error": "请使用 JSON 提交"})
		return false
	}
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096))
	decoder.DisallowUnknownFields()
	if decoder.Decode(value) != nil || decoder.Decode(new(any)) != io.EOF {
		writeJSON(w, 400, map[string]any{"error": "输入无效或过长"})
		return false
	}
	return true
}
func (s *Server) scanAPI(w http.ResponseWriter, r *http.Request) {
	if !sameOrigin(r) {
		writeJSON(w, 403, map[string]any{"error": "来源无效"})
		return
	}
	if r.URL.Path == "/api/scan/cancel" && r.Method == http.MethodPost {
		s.scans.Lock()
		s.scans.cancelAll()
		s.scans.Unlock()
		writeJSON(w, 200, map[string]any{"success": true})
		return
	}
	if r.URL.Path == "/api/scan" && r.Method == http.MethodPost {
		var input struct {
			Scope string `json:"scope"`
		}
		if !scanDecode(w, r, &input) {
			return
		}
		if input.Scope != "search" && input.Scope != "login" && input.Scope != "register" {
			writeJSON(w, 400, map[string]any{"error": "不支持的扫码操作"})
			return
		}
		ip := lanAddress()
		s.scans.Lock()
		defer s.scans.Unlock()
		if s.scans.Port == 0 || ip == "" {
			writeJSON(w, 503, map[string]any{"error": "未连接可用局域网，请连接 Wi-Fi 或使用遥控器输入"})
			return
		}
		s.scans.cancelAll()
		for id, v := range s.scans.Sessions {
			if !s.scans.now().Before(v.Expires.Add(time.Minute)) {
				delete(s.scans.Sessions, id)
			}
		}
		random := make([]byte, 24)
		if _, err := rand.Read(random); err != nil {
			writeJSON(w, 500, map[string]any{"error": "无法创建二维码"})
			return
		}
		id := base64.RawURLEncoding.EncodeToString(random)
		ctx, cancel := context.WithDeadline(context.Background(), time.Now().Add(scanTTL))
		v := &scanSession{ID: id, Scope: input.Scope, Code: strings.ToUpper(hex.EncodeToString(random[:3])), State: "waiting", Expires: s.scans.now().Add(scanTTL), Context: ctx, Cancel: cancel}
		if s.scans.Sessions == nil {
			s.scans.Sessions = make(map[string]*scanSession)
		}
		s.scans.Sessions[id] = v
		link := "http://" + net.JoinHostPort(ip, strconv.Itoa(s.scans.Port)) + "/phone/" + id
		png, err := qrcode.Encode(link, qrcode.Medium, 320)
		if err != nil {
			v.State = "failed"
			cancel()
			writeJSON(w, 500, map[string]any{"error": "无法生成二维码"})
			return
		}
		view := scanView(v, s.scans.now())
		view["url"] = link
		view["qr"] = "data:image/png;base64," + base64.StdEncoding.EncodeToString(png)
		writeJSON(w, 200, view)
		return
	}
	id := strings.TrimPrefix(r.URL.Path, "/api/scan/")
	s.scans.Lock()
	defer s.scans.Unlock()
	v := s.scans.Sessions[id]
	if v == nil {
		writeJSON(w, 404, map[string]any{"error": "二维码不存在"})
		return
	}
	s.scans.expire(v)
	switch r.Method {
	case http.MethodGet:
		writeJSON(w, 200, scanView(v, s.scans.now()))
	case http.MethodDelete:
		v.State = "cancelled"
		v.Value = ""
		v.Pending = nil
		v.Devices = nil
		v.CaptchaID, v.CaptchaSVG = "", ""
		v.Cancel()
		writeJSON(w, 200, map[string]any{"success": true})
	default:
		writeJSON(w, 405, map[string]any{"error": "方法不支持"})
	}
}

func (s *Server) PhoneHandler() http.Handler {
	return withHeaders(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Referrer-Policy", "no-referrer")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Content-Security-Policy", "default-src 'self'; img-src 'self' data:; script-src 'self'; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'")
		if r.URL.Path == "/phone-assets/app.js" && r.Method == http.MethodGet {
			data, _ := ui.Files.ReadFile("phone.js")
			w.Header().Set("Content-Type", "application/javascript; charset=utf-8")
			_, _ = w.Write(data)
			return
		}
		parts := strings.Split(strings.Trim(r.URL.Path, "/"), "/")
		if len(parts) < 2 || len(parts) > 3 || parts[0] != "phone" {
			http.NotFound(w, r)
			return
		}
		id := parts[1]
		action := ""
		if len(parts) == 3 {
			action = parts[2]
		}
		s.scans.Lock()
		v := s.scans.Sessions[id]
		if v == nil {
			s.scans.Unlock()
			writeJSON(w, 404, map[string]any{"error": "二维码不存在，请在电视重新打开"})
			return
		}
		s.scans.expire(v)
		if !scanOpen(v) {
			s.scans.Unlock()
			writeJSON(w, 410, map[string]any{"error": "二维码已失效，请在电视刷新"})
			return
		}
		if action == "" && r.Method == http.MethodGet {
			v.Connected = true
			config, _ := json.Marshal(map[string]any{"scope": v.Scope, "code": v.Code, "remaining": int(v.Expires.Sub(s.scans.now()).Seconds())})
			s.scans.Unlock()
			data, _ := ui.Files.ReadFile("phone.html")
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			_, _ = w.Write(bytes.Replace(data, []byte("__PAIR_CONFIG__"), config, 1))
			return
		}
		if action == "captcha" && r.Method == http.MethodGet && v.Scope == "register" && v.State == "waiting" {
			s.scans.Unlock()
			s.phoneCaptcha(w, r, v)
			return
		}
		if action == "captcha-image" && r.Method == http.MethodGet && v.Scope == "register" && v.State == "waiting" {
			version, err := strconv.ParseUint(r.URL.Query().Get("v"), 10, 64)
			if err != nil || version != v.CaptchaVersion || v.CaptchaSVG == "" {
				s.scans.Unlock()
				writeJSON(w, 409, map[string]any{"error": "验证码已更新，请点击换一张"})
				return
			}
			svg := v.CaptchaSVG
			s.scans.Unlock()
			w.Header().Set("Content-Type", "image/svg+xml; charset=utf-8")
			w.Header().Set("Content-Security-Policy", "sandbox; default-src 'none'; style-src 'unsafe-inline'")
			_, _ = io.WriteString(w, svg)
			return
		}
		s.scans.Unlock()
		if action == "submit" && r.Method == http.MethodPost {
			s.phoneSubmit(w, r, v, false)
			return
		}
		if action == "resolve" && r.Method == http.MethodPost {
			s.phoneSubmit(w, r, v, true)
			return
		}
		writeJSON(w, 405, map[string]any{"error": "此二维码不支持该操作"})
	}))
}
func (s *Server) phoneCaptcha(w http.ResponseWriter, r *http.Request, v *scanSession) {
	s.scans.Lock()
	s.scans.expire(v)
	if v.State != "waiting" {
		s.scans.Unlock()
		writeJSON(w, 410, map[string]any{"error": "二维码已失效，请在电视刷新"})
		return
	}
	v.CaptchaVersion++
	version := v.CaptchaVersion
	v.CaptchaID, v.CaptchaSVG = "", ""
	s.scans.Unlock()
	var data []byte
	var status = 200
	var err error
	if s.fixture {
		data = []byte(`{"captchaId":"fixture-captcha","svg":"<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"180\" height=\"60\"><rect width=\"180\" height=\"60\" fill=\"white\"/><text x=\"20\" y=\"40\" font-size=\"28\">A7K2</text></svg>"}`)
	} else {
		ctx, cancel := context.WithTimeout(v.Context, 10*time.Second)
		defer cancel()
		req, requestErr := http.NewRequestWithContext(ctx, http.MethodGet, strings.TrimRight(s.cfg.Upstream, "/")+"/api/captcha", nil)
		if requestErr != nil {
			writeJSON(w, 502, map[string]any{"error": "验证码加载失败，请点击换一张重试"})
			return
		}
		req.Header.Set("Accept", "application/json")
		req.Header.Set("User-Agent", "MingmingMusicTV/"+s.cfg.VersionName)
		var resp *http.Response
		resp, err = s.client.Do(req)
		if err == nil {
			defer resp.Body.Close()
			status = resp.StatusCode
			data, err = io.ReadAll(io.LimitReader(resp.Body, 128<<10))
		}
	}
	var result struct {
		CaptchaID string `json:"captchaId"`
		SVG       string `json:"svg"`
	}
	s.scans.Lock()
	defer s.scans.Unlock()
	s.scans.expire(v)
	if v.State != "waiting" {
		writeJSON(w, 410, map[string]any{"error": "二维码已失效"})
		return
	}
	if version != v.CaptchaVersion {
		writeJSON(w, 409, map[string]any{"error": "验证码已更新，请点击换一张"})
		return
	}
	if err != nil || status >= 400 || json.Unmarshal(data, &result) != nil || result.CaptchaID == "" || result.SVG == "" {
		writeJSON(w, 502, map[string]any{"error": "验证码服务暂时不可用，请点击换一张重试"})
		return
	}
	v.CaptchaID = result.CaptchaID
	v.CaptchaSVG = result.SVG
	writeJSON(w, 200, map[string]any{"image": "/phone/" + v.ID + "/captcha-image?v=" + strconv.FormatUint(version, 10)})
}

type phoneInput struct {
	Scope       string `json:"scope"`
	Value       string `json:"value"`
	Username    string `json:"username"`
	Password    string `json:"password"`
	CaptchaCode string `json:"captchaCode"`
	KickTail    string `json:"kickTail"`
}

func (s *Server) phoneSubmit(w http.ResponseWriter, r *http.Request, v *scanSession, resolve bool) {
	var input phoneInput
	if !scanDecode(w, r, &input) {
		return
	}
	s.scans.Lock()
	s.scans.expire(v)
	if input.Scope != v.Scope {
		s.scans.Unlock()
		writeJSON(w, 400, map[string]any{"error": "扫码操作不匹配"})
		return
	}
	expected := "waiting"
	if resolve {
		expected = "device_limit"
	}
	if v.State != expected {
		s.scans.Unlock()
		writeJSON(w, 409, map[string]any{"error": "该二维码已提交或失效，请在电视刷新"})
		return
	}
	if v.Scope == "search" {
		value := strings.TrimSpace(input.Value)
		if resolve || value == "" || utf8.RuneCountInString(value) > 100 || strings.ContainsAny(value, "\x00\r\n") || input.Username != "" || input.Password != "" {
			s.scans.Unlock()
			writeJSON(w, 400, map[string]any{"error": "请输入 1–100 个字的搜索关键词"})
			return
		}
		v.Value = value
		v.State = "complete"
		v.Cancel()
		s.scans.Unlock()
		writeJSON(w, 200, map[string]any{"success": true, "message": "已发送到电视"})
		return
	}
	var body map[string]any
	if resolve {
		allowed := false
		for _, item := range v.Devices {
			device, _ := item.(map[string]any)
			if tail, _ := device["tokenTail"].(string); tail != "" && tail == input.KickTail {
				allowed = true
			}
		}
		if !allowed || v.Pending == nil {
			s.scans.Unlock()
			writeJSON(w, 400, map[string]any{"error": "请选择列表中的设备"})
			return
		}
		body = v.Pending
		body["action"] = "kickAndLogin"
		body["kickTail"] = input.KickTail
	} else {
		username := strings.TrimSpace(input.Username)
		action := "login"
		if strings.Contains(username, "@") {
			action = "loginByEmail"
		}
		if v.Scope == "register" {
			action = "register"
		}
		body = map[string]any{"action": action, "password": input.Password}
		if action == "loginByEmail" {
			body["email"] = username
		} else {
			body["username"] = username
		}
		if v.Scope == "register" {
			body["captchaId"] = v.CaptchaID
			body["captchaCode"] = input.CaptchaCode
		}
	}
	if err := validateAccount(body); err != nil {
		s.scans.Unlock()
		writeJSON(w, 400, map[string]any{"error": err.Error()})
		return
	}
	v.State = "processing"
	s.scans.Unlock()
	raw, _ := json.Marshal(body)
	data, status, err := s.accountRequest(v.Context, http.MethodPost, "", raw)
	var result map[string]any
	parsed := json.Unmarshal(data, &result) == nil
	s.scans.Lock()
	defer s.scans.Unlock()
	s.scans.expire(v)
	if v.State != "processing" {
		writeJSON(w, 410, map[string]any{"error": "操作已取消或二维码已过期"})
		return
	}
	if err == nil && parsed && result["deviceLimit"] == true && v.Scope == "login" {
		scrubToken(result)
		v.Pending = body
		v.Devices, _ = result["devices"].([]any)
		v.State = "device_limit"
		v.Message = "请在手机选择一台设备下线"
		writeJSON(w, 200, result)
		return
	}
	if resolve && (err != nil || status >= 500) {
		v.State = "device_limit"
		v.Message = "下线登录暂时失败，请重试或选择其它设备"
		writeJSON(w, 502, map[string]any{"error": v.Message, "retryable": true})
		return
	}
	v.Pending = nil
	v.Devices = nil
	success := err == nil && parsed && status < 400 && result["success"] != false && result["code"] != float64(0) && findToken(result) != ""
	if success {
		// Publish only after checking cancellation/expiry, never from a late response.
		s.captureToken(data)
		v.State = "complete"
		v.Message = "账号操作成功"
		v.Cancel()
		writeJSON(w, 200, map[string]any{"success": true, "message": "已完成，电视正在同步账号"})
		return
	}
	v.State = "failed"
	v.Cancel()
	v.Message = "账号操作失败，请在电视刷新二维码重试"
	if parsed {
		for _, key := range []string{"error", "message", "msg"} {
			if msg, ok := result[key].(string); ok && msg != "" {
				v.Message = msg
				break
			}
		}
	}
	writeJSON(w, 400, map[string]any{"error": v.Message})
}

func validateAccount(input map[string]any) error {
	action, _ := input["action"].(string)
	switch action {
	case "login", "loginByEmail", "register", "kickAndLogin":
		username, _ := input["username"].(string)
		if action == "loginByEmail" || username == "" {
			username, _ = input["email"].(string)
		}
		password, _ := input["password"].(string)
		if strings.TrimSpace(username) == "" || len(username) > 128 || strings.ContainsAny(username, "\x00\r\n") {
			return errors.New("请输入有效的用户名或邮箱")
		}
		if password == "" || len(password) > 256 || strings.ContainsRune(password, 0) {
			return errors.New("请输入有效的密码")
		}
		if action == "register" {
			id, _ := input["captchaId"].(string)
			code, _ := input["captchaCode"].(string)
			if id == "" || strings.TrimSpace(code) == "" || len(id) > 256 || len(code) > 32 {
				return errors.New("请输入图片验证码")
			}
		}
		if action == "kickAndLogin" {
			tail, _ := input["kickTail"].(string)
			if tail == "" || len(tail) > 128 {
				return errors.New("请选择要下线的设备")
			}
		}
	}
	return nil
}
