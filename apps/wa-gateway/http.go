package main

import (
	"crypto/subtle"
	"encoding/json"
	"errors"
	"net/http"
	"regexp"
	"strings"
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
	mux.Handle("POST /v1/users/{uid}/link", s.auth(http.HandlerFunc(s.link)))
	mux.Handle("GET /v1/users/{uid}", s.auth(http.HandlerFunc(s.status)))
	mux.Handle("DELETE /v1/users/{uid}", s.auth(http.HandlerFunc(s.unlink)))
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
		Mode  string `json:"mode"`
		Phone string `json:"phone"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&body); err != nil {
		writeJSON(w, 400, map[string]string{"error": "invalid JSON"})
		return
	}
	info, err := s.m.StartLink(r.Context(), id, body.Mode, body.Phone)
	switch {
	case errors.Is(err, ErrAlreadyLinked):
		writeJSON(w, 409, map[string]string{"error": err.Error()})
	case errors.Is(err, ErrAccountLimit):
		writeJSON(w, 429, map[string]string{"error": err.Error()})
	case errors.Is(err, ErrBadPhone), errors.Is(err, ErrBadMode):
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
