package main

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

var userIDRe = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)

// Server is the private HTTP API for rolly-api. It is never exposed to the internet or to the app.
type Server struct {
	cfg Config
	m   *Manager
}

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) { writeJSON(w, 200, map[string]any{"ok": true}) })
	mux.Handle("GET /v1/stats", s.auth(http.HandlerFunc(s.stats)))
	mux.Handle("POST /v1/users/{uid}/link", s.auth(http.HandlerFunc(s.link)))
	mux.Handle("GET /v1/users/{uid}", s.auth(http.HandlerFunc(s.status)))
	mux.Handle("DELETE /v1/users/{uid}", s.auth(http.HandlerFunc(s.unlink)))
	mux.Handle("POST /v1/users/{uid}/send/draft", s.auth(http.HandlerFunc(s.draft)))
	mux.Handle("POST /v1/users/{uid}/send/confirm", s.auth(http.HandlerFunc(s.confirm)))
	mux.Handle("DELETE /v1/users/{uid}/send/drafts/{id}", s.auth(http.HandlerFunc(s.cancelDraft)))
	mux.Handle("GET /v1/users/{uid}/chats", s.auth(http.HandlerFunc(s.chats)))
	mux.Handle("GET /v1/users/{uid}/chats/{ref}/messages", s.auth(http.HandlerFunc(s.messages)))
	return mux
}

func (s *Server) auth(next http.Handler) http.Handler {
	want := []byte(s.cfg.Token)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got := []byte(strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer "))
		if subtle.ConstantTimeCompare(got, want) != 1 {
			writeJSON(w, 401, map[string]string{"error": "unauthorized"})
			return
		}
		next.ServeHTTP(w, r)
	})
}

func uid(w http.ResponseWriter, r *http.Request) (string, bool) {
	id := r.PathValue("uid")
	if !userIDRe.MatchString(id) {
		writeJSON(w, 400, map[string]string{"error": "bad user id"})
		return "", false
	}
	return id, true
}

// POST /v1/users/{uid}/link  {"mode":"qr"} | {"mode":"code","phone":"9725..."}
func (s *Server) link(w http.ResponseWriter, r *http.Request) {
	id, ok := uid(w, r)
	if !ok {
		return
	}
	var body struct {
		Mode    string `json:"mode"`
		Phone   string `json:"phone"`
		Consent bool   `json:"consent"` // the user accepted the terms shown in the app
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&body); err != nil {
		writeJSON(w, 400, map[string]string{"error": "invalid JSON"})
		return
	}
	info, err := s.m.StartLink(r.Context(), id, body.Mode, body.Phone, body.Consent)
	switch {
	case errors.Is(err, ErrAlreadyLinked):
		writeJSON(w, 409, map[string]string{"error": err.Error()})
	case errors.Is(err, ErrAccountLimit):
		writeJSON(w, 429, map[string]string{"error": err.Error()})
	case errors.Is(err, ErrBadPhone), errors.Is(err, ErrBadMode), errors.Is(err, ErrConsent):
		writeJSON(w, 400, map[string]string{"error": err.Error()})
	case err != nil:
		writeJSON(w, 502, map[string]string{"error": err.Error()})
	default:
		writeJSON(w, 202, info)
	}
}

// GET /v1/users/{uid} -> {"state":"connected"} ; while pairing also the current qr/code
func (s *Server) status(w http.ResponseWriter, r *http.Request) {
	id, ok := uid(w, r)
	if !ok {
		return
	}
	state, lastErr, info, err := s.m.Status(r.Context(), id)
	if err != nil {
		writeJSON(w, 500, map[string]string{"error": "internal error"})
		return
	}
	out := map[string]any{"user_id": id, "state": state}
	if lastErr != "" {
		out["last_error"] = lastErr
	}
	if info != nil {
		out["link"] = info
	}
	writeJSON(w, 200, out)
}

// DELETE /v1/users/{uid}: unlink on WhatsApp's side and delete everything stored for the user.
func (s *Server) unlink(w http.ResponseWriter, r *http.Request) {
	id, ok := uid(w, r)
	if !ok {
		return
	}
	if err := s.m.Unlink(r.Context(), id); err != nil {
		writeJSON(w, 500, map[string]string{"error": "internal error"})
		return
	}
	writeJSON(w, 200, map[string]any{"user_id": id, "state": StateUnlinked})
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

var refRe = regexp.MustCompile(`^[0-9a-f]{16}$`)

func intParam(r *http.Request, name string, def, min, max int) int {
	v, err := strconv.Atoi(r.URL.Query().Get(name))
	if err != nil {
		return def
	}
	if v < min {
		return min
	}
	if v > max {
		return max
	}
	return v
}

func int64Param(r *http.Request, name string) int64 {
	v, _ := strconv.ParseInt(r.URL.Query().Get(name), 10, 64)
	return v
}

// GET /v1/users/{uid}/chats?q=name&groups=1|0&limit=20  -> chats, newest first. Chats are addressed by an opaque ref.
func (s *Server) chats(w http.ResponseWriter, r *http.Request) {
	id, ok := uid(w, r)
	if !ok {
		return
	}
	var groups *bool
	switch r.URL.Query().Get("groups") {
	case "1":
		t := true
		groups = &t
	case "0":
		f := false
		groups = &f
	}
	q := r.URL.Query().Get("q")
	list, err := s.m.msgs.Chats(r.Context(), id, q, groups, intParam(r, "limit", 20, 1, 100))
	if err != nil {
		writeJSON(w, 500, map[string]string{"error": "internal error"})
		return
	}
	if strings.TrimSpace(q) != "" && len(list) == 0 {
		log.Printf("chat search found nothing (query of %d characters)", len([]rune(q))) // never the name itself
	}
	writeJSON(w, 200, map[string]any{"chats": list})
}

// GET /v1/users/{uid}/chats/{ref}/messages?since=<unix>&before=<unix>&limit=30&transcribe=1
// Returns the newest `limit` messages in the window, oldest first. transcribe=1 transcribes up to 5 voice notes of the page.
func (s *Server) messages(w http.ResponseWriter, r *http.Request) {
	id, ok := uid(w, r)
	if !ok {
		return
	}
	ref := r.PathValue("ref")
	if !refRe.MatchString(ref) {
		writeJSON(w, 400, map[string]string{"error": "bad chat ref"})
		return
	}
	name, found := s.m.msgs.ChatName(r.Context(), id, ref)
	if !found {
		writeJSON(w, 404, map[string]string{"error": "chat not found"})
		return
	}
	list, err := s.m.msgs.Messages(r.Context(), id, ref, int64Param(r, "since"), int64Param(r, "before"), intParam(r, "limit", 30, 1, 200))
	if err != nil {
		writeJSON(w, 500, map[string]string{"error": "internal error"})
		return
	}
	if r.URL.Query().Get("transcribe") == "1" {
		s.transcribePage(r.Context(), id, ref, list)
	}
	if list == nil {
		list = []StoredMessage{}
	}
	writeJSON(w, 200, map[string]any{"chat": map[string]any{"ref": ref, "name": name}, "messages": list})
}

// transcribePage fills in transcripts for the voice notes of one page: at most 5, three at a time, 25 s in total.
func (s *Server) transcribePage(ctx context.Context, userID, ref string, list []StoredMessage) {
	ctx, cancel := context.WithTimeout(ctx, 25*time.Second)
	defer cancel()
	var wg sync.WaitGroup
	sem := make(chan struct{}, 3)
	n := 0
	for i := len(list) - 1; i >= 0 && n < 5; i-- { // newest voice notes first
		if !list[i].CanTranscribe {
			continue
		}
		n++
		wg.Add(1)
		go func(m *StoredMessage) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()
			text, err := s.m.Transcribe(ctx, userID, ref, m.ID)
			switch {
			case err == nil:
				m.Transcript, m.CanTranscribe = text, false
			case errors.Is(err, ErrNotConnected):
				m.TranscribeError = "not_connected"
			case errors.Is(err, ErrSTTDisabled):
				m.TranscribeError = "stt_disabled"
			default:
				m.TranscribeError = "failed"
			}
		}(&list[i])
	}
	wg.Wait()
}

// POST /v1/users/{uid}/send/draft {"chat_ref","text"} -> the draft to read back to the user. Sends nothing.
func (s *Server) draft(w http.ResponseWriter, r *http.Request) {
	id, ok := uid(w, r)
	if !ok {
		return
	}
	var body struct {
		ChatRef string `json:"chat_ref"`
		Text    string `json:"text"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 16384)).Decode(&body); err != nil || !refRe.MatchString(body.ChatRef) {
		writeJSON(w, 400, map[string]string{"error": "chat_ref and text are required"})
		return
	}
	d, err := s.m.CreateDraft(r.Context(), id, body.ChatRef, body.Text)
	switch {
	case errors.Is(err, ErrBadText):
		writeJSON(w, 400, map[string]string{"error": err.Error()})
	case errors.Is(err, ErrChatNotFound):
		writeJSON(w, 404, map[string]string{"error": err.Error()})
	case err != nil:
		writeJSON(w, 500, map[string]string{"error": "internal error"})
	default:
		writeJSON(w, 201, d)
	}
}

// POST /v1/users/{uid}/send/confirm {"draft_id"}: call ONLY after the user said yes to the read-back.
func (s *Server) confirm(w http.ResponseWriter, r *http.Request) {
	id, ok := uid(w, r)
	if !ok {
		return
	}
	var body struct {
		DraftID string `json:"draft_id"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&body); err != nil || body.DraftID == "" {
		writeJSON(w, 400, map[string]string{"error": "draft_id is required"})
		return
	}
	sent, err := s.m.ConfirmDraft(r.Context(), id, body.DraftID)
	var rl *RateLimitError
	switch {
	case err == nil:
		writeJSON(w, 200, sent)
	case errors.Is(err, ErrDraftNotFound):
		writeJSON(w, 404, map[string]string{"error": err.Error()})
	case errors.Is(err, ErrDraftUsed):
		writeJSON(w, 409, map[string]string{"error": err.Error()})
	case errors.Is(err, ErrNotConnected):
		writeJSON(w, 409, map[string]string{"error": err.Error(), "state": "not_connected"})
	case errors.As(err, &rl):
		w.Header().Set("Retry-After", strconv.Itoa(int(rl.RetryAfter.Seconds())+1))
		writeJSON(w, 429, map[string]any{"error": rl.Error(), "reason": rl.Reason, "retry_after_s": int(rl.RetryAfter.Seconds()) + 1})
	case errors.Is(err, ErrChatNotFound):
		writeJSON(w, 404, map[string]string{"error": err.Error()})
	default:
		writeJSON(w, 502, map[string]string{"error": "send failed"})
	}
}

// DELETE /v1/users/{uid}/send/drafts/{id}: the user said no.
func (s *Server) cancelDraft(w http.ResponseWriter, r *http.Request) {
	id, ok := uid(w, r)
	if !ok {
		return
	}
	s.m.CancelDraft(id, r.PathValue("id"))
	writeJSON(w, 200, map[string]bool{"ok": true})
}

// GET /v1/stats: counts only, for monitoring and alerts.
func (s *Server) stats(w http.ResponseWriter, r *http.Request) {
	st, err := s.m.Stats(r.Context())
	if err != nil {
		writeJSON(w, 500, map[string]string{"error": "internal error"})
		return
	}
	writeJSON(w, 200, st)
}
