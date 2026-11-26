package main

import (
	"context"
	"database/sql"
	"errors"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"go.mau.fi/whatsmeow/types/events"
	waLog "go.mau.fi/whatsmeow/util/log"
)

func testStore(t *testing.T) *AccountStore {
	t.Helper()
	db, err := sql.Open("sqlite3", "file:"+filepath.Join(t.TempDir(), "t.db")+"?_foreign_keys=on")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	s := NewAccountStore(db, false)
	if err := s.Migrate(context.Background()); err != nil {
		t.Fatal(err)
	}
	return s
}

const testToken = "test-token-0123456789-abcdefghij"

func testManager(t *testing.T, max int) *Manager {
	t.Helper()
	cfg := Config{Token: testToken, MaxAccounts: max, LinkTimeout: 5}
	m := NewManager(cfg, nil, testStore(t), waLog.Noop)
	if err := m.msgs.Migrate(context.Background()); err != nil {
		t.Fatal(err)
	}
	return m
}

func TestUpsertKeepsJIDWhenStateOnly(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	if err := s.Upsert(ctx, "u1", "972500000000:1@s.whatsapp.net", StatePairing, ""); err != nil {
		t.Fatal(err)
	}
	if err := s.Upsert(ctx, "u1", "", StateConnected, ""); err != nil {
		t.Fatal(err)
	}
	a, err := s.Get(ctx, "u1")
	if err != nil {
		t.Fatal(err)
	}
	if a.JID != "972500000000:1@s.whatsapp.net" || a.State != StateConnected || a.LinkedAt == 0 {
		t.Fatalf("unexpected account: %+v", a)
	}
	if _, err := s.Get(ctx, "nobody"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("want ErrNotFound, got %v", err)
	}
}

func TestPhoneNumberNeverInJSON(t *testing.T) {
	a := Account{UserID: "u", JID: "972500000000:1@s.whatsapp.net", State: StateConnected}
	srv := &Server{cfg: Config{Token: testToken}, m: testManager(t, 5)}
	if err := srv.m.accounts.Upsert(context.Background(), a.UserID, a.JID, a.State, ""); err != nil {
		t.Fatal(err)
	}
	rec := do(srv, "GET", "/v1/users/u", testToken, "")
	if rec.Code != 200 || strings.Contains(rec.Body.String(), "972500000000") {
		t.Fatalf("status leaked or failed: %d %s", rec.Code, rec.Body.String())
	}
}

func do(srv *Server, method, path, token, body string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, req)
	return rec
}

func TestHTTPAuthAndValidation(t *testing.T) {
	srv := &Server{cfg: Config{Token: testToken}, m: testManager(t, 1)}
	if c := do(srv, "GET", "/healthz", "", "").Code; c != 200 {
		t.Fatalf("healthz %d", c)
	}
	if c := do(srv, "GET", "/v1/users/u1", "", "").Code; c != 401 {
		t.Fatalf("no token: %d", c)
	}
	if c := do(srv, "GET", "/v1/users/u1", "wrong-token", "").Code; c != 401 {
		t.Fatalf("wrong token: %d", c)
	}
	rec := do(srv, "GET", "/v1/users/u1", testToken, "")
	if rec.Code != 200 || !strings.Contains(rec.Body.String(), `"unlinked"`) {
		t.Fatalf("unlinked: %d %s", rec.Code, rec.Body.String())
	}
	if c := do(srv, "GET", "/v1/users/bad%20id", testToken, "").Code; c != 400 {
		t.Fatalf("bad id: %d", c)
	}
	if c := do(srv, "POST", "/v1/users/u1/link", testToken, `{"mode":"sms"}`).Code; c != 400 {
		t.Fatalf("bad mode: %d", c)
	}
	if c := do(srv, "POST", "/v1/users/u1/link", testToken, `{"mode":"code","phone":"123"}`).Code; c != 400 {
		t.Fatalf("bad phone: %d", c)
	}
}

func TestLinkRefusedWhenAlreadyLinkedOrFull(t *testing.T) {
	m := testManager(t, 1)
	ctx := context.Background()
	if err := m.accounts.Upsert(ctx, "a", "972500000001:1@s.whatsapp.net", StateConnected, ""); err != nil {
		t.Fatal(err)
	}
	if _, err := m.StartLink(ctx, "a", "qr", ""); !errors.Is(err, ErrAlreadyLinked) {
		t.Fatalf("want ErrAlreadyLinked, got %v", err)
	}
	if _, err := m.StartLink(ctx, "b", "qr", ""); !errors.Is(err, ErrAccountLimit) {
		t.Fatalf("want ErrAccountLimit, got %v", err)
	}
}

func TestEventsMapToStates(t *testing.T) {
	m := testManager(t, 5)
	ctx := context.Background()
	l := &live{userID: "u"}
	cases := []struct {
		evt  any
		want State
	}{
		{&events.Connected{}, StateConnected},
		{&events.Disconnected{}, StateReconnecting},
		{&events.TemporaryBan{Code: 1, Expire: time.Hour}, StateBanned},
		{&events.StreamReplaced{}, StateConflict},
		{&events.ClientOutdated{}, StateClientOutdated},
		{&events.ConnectFailure{Reason: events.ConnectFailureUnknownLogout}, StateBanned},
	}
	for _, c := range cases {
		m.onEvent(l, c.evt)
		a, err := m.accounts.Get(ctx, "u")
		if err != nil || a.State != c.want {
			t.Fatalf("%T: want %s, got %+v (%v)", c.evt, c.want, a, err)
		}
	}
}

func TestUnlinkWithNothingLinkedIsFine(t *testing.T) {
	m := testManager(t, 5)
	if err := m.Unlink(context.Background(), "ghost"); err != nil {
		t.Fatal(err)
	}
	_ = http.StatusOK
}
