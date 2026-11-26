package main

import (
	"context"
	"encoding/base64"
	"strings"
	"testing"
	"time"

	"go.mau.fi/whatsmeow"
	"go.mau.fi/whatsmeow/store"
	"go.mau.fi/whatsmeow/types"
	"go.mau.fi/whatsmeow/types/events"
	waLog "go.mau.fi/whatsmeow/util/log"
)

func testKey() string {
	return base64.StdEncoding.EncodeToString([]byte("0123456789abcdef0123456789abcdef"))
}

func TestSealerRoundTripAndBinding(t *testing.T) {
	s, err := NewSealer(testKey(), false)
	if err != nil {
		t.Fatal(err)
	}
	c, err := s.SealString("u1", "שלום עולם")
	if err != nil || strings.Contains(c, "שלום") || !strings.HasPrefix(c, "v1:") {
		t.Fatalf("not sealed: %q %v", c, err)
	}
	if p, err := s.OpenString("u1", c); err != nil || p != "שלום עולם" {
		t.Fatalf("round trip: %q %v", p, err)
	}
	if _, err := s.OpenString("u2", c); err == nil {
		t.Fatal("another user's key must not open it")
	}
	c2, _ := s.SealString("u1", "שלום עולם")
	if c == c2 {
		t.Fatal("nonce must differ per seal")
	}
	b := []byte(c)
	b[len(b)-3] ^= 1 // tamper
	if _, err := s.OpenString("u1", string(b)); err == nil {
		t.Fatal("tampering must be detected")
	}
	if e, _ := s.SealString("u1", ""); e != "" {
		t.Fatal("empty stays empty")
	}
}

func TestSealerConfigRules(t *testing.T) {
	if _, err := NewSealer("", false); err == nil {
		t.Fatal("a missing key must be refused unless plaintext is explicitly allowed")
	}
	if s, err := NewSealer("", true); err != nil || !s.plain {
		t.Fatalf("explicit plaintext: %v", err)
	}
	if _, err := NewSealer("c2hvcnQ=", false); err == nil {
		t.Fatal("a short key must be refused")
	}
}

func TestDatabaseHoldsOnlyCiphertext(t *testing.T) {
	m := testManager(t, 5)
	s, _ := NewSealer(testKey(), false)
	m.msgs.sealer = s
	ctx := context.Background()
	ref, _ := m.msgs.UpsertChat(ctx, "u", danLID.String(), "דני", false, 1)
	if err := m.msgs.AddMessage(ctx, "u", ref, StoredMessage{ID: "1", TS: 1, Kind: "voice", Text: "סוד גדול"}, []byte("media-pointer"), 9_999_999_999); err != nil {
		t.Fatal(err)
	}
	var body string
	var media []byte
	if err := m.msgs.db.QueryRow(`SELECT body, media FROM wa_messages WHERE msg_id = '1'`).Scan(&body, &media); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(body, "סוד") || strings.Contains(string(media), "media-pointer") {
		t.Fatalf("plaintext in the database: %q %q", body, media)
	}
	got, _ := m.msgs.Messages(ctx, "u", ref, 0, 0, 10)
	if len(got) != 1 || got[0].Text != "סוד גדול" {
		t.Fatalf("reading back: %+v", got)
	}
	if b, _ := m.msgs.Media(ctx, "u", ref, "1"); string(b) != "media-pointer" {
		t.Fatalf("media: %q", b)
	}
	if err := m.msgs.SetTranscript(ctx, "u", ref, "1", "תמליל פרטי"); err != nil {
		t.Fatal(err)
	}
	var tr string
	_ = m.msgs.db.QueryRow(`SELECT transcript FROM wa_messages WHERE msg_id = '1'`).Scan(&tr)
	if strings.Contains(tr, "תמליל") {
		t.Fatalf("transcript stored in the clear: %q", tr)
	}
	got, _ = m.msgs.Messages(ctx, "u", ref, 0, 0, 10)
	if got[0].Transcript != "תמליל פרטי" {
		t.Fatalf("transcript read back: %+v", got[0])
	}
}

func TestLinkNeedsConsent(t *testing.T) {
	m := testManager(t, 5)
	if _, err := m.StartLink(context.Background(), "u", "qr", "", false); err != ErrConsent {
		t.Fatalf("want ErrConsent, got %v", err)
	}
	srv := &Server{cfg: Config{Token: testToken}, m: m}
	if c := do(srv, "POST", "/v1/users/u/link", testToken, `{"mode":"qr"}`).Code; c != 400 {
		t.Fatalf("without consent: %d", c)
	}
}

func TestStatsHaveNoUserData(t *testing.T) {
	m := testManager(t, 5)
	ctx := context.Background()
	_ = m.accounts.Upsert(ctx, "secret-user-id", "972500000000:1@s.whatsapp.net", StateConnected, "")
	g := &Ingester{msgs: m.msgs, retention: time.Hour, now: time.Now}
	_ = g.Message(ctx, "secret-user-id", testDir(), textEvt(noaPN, noaPN, "x", "שלום", false, time.Now()), "")
	srv := &Server{cfg: Config{Token: testToken}, m: m}
	rec := do(srv, "GET", "/v1/stats", testToken, "")
	body := rec.Body.String()
	if rec.Code != 200 || !strings.Contains(body, `"connected":1`) || !strings.Contains(body, `"messages":1`) {
		t.Fatalf("stats: %d %s", rec.Code, body)
	}
	if strings.Contains(body, "secret-user-id") || strings.Contains(body, "972500000000") || strings.Contains(body, "שלום") {
		t.Fatalf("stats leak user data: %s", body)
	}
	if c := do(srv, "GET", "/v1/stats", "", "").Code; c != 401 {
		t.Fatalf("stats need the token: %d", c)
	}
}

// ---- regression: a freshly paired session was deleted by the link-attempt timer (found on a real account, 2026-11-26)

func pairedClient() *whatsmeow.Client {
	jid := types.NewJID("972500000000", types.DefaultUserServer)
	jid.Device = 3
	return whatsmeow.NewClient(&store.Device{ID: &jid}, waLog.Noop)
}

func TestExpireLinkNeverTouchesAPairedClient(t *testing.T) {
	m := testManager(t, 5)
	ctx := context.Background()
	l := &live{userID: "u", client: pairedClient()}
	m.live["u"] = l
	_ = m.accounts.Upsert(ctx, "u", "972500000000:3@s.whatsapp.net", StatePairing, "") // the state is still "pairing" for a moment
	m.expireLink(l)
	if _, still := m.live["u"]; !still {
		t.Fatal("a paired client was dropped by the expiry timer")
	}
	if a, _ := m.accounts.Get(ctx, "u"); a == nil || a.JID == "" {
		t.Fatalf("the account of a paired client was deleted: %+v", a)
	}
}

func TestExpireLinkCleansAnUnfinishedAttempt(t *testing.T) {
	m := testManager(t, 5)
	ctx := context.Background()
	l := &live{userID: "u", client: whatsmeow.NewClient(&store.Device{}, waLog.Noop)} // never paired
	m.live["u"] = l
	_ = m.accounts.Upsert(ctx, "u", "", StatePairing, "")
	m.expireLink(l)
	if _, still := m.live["u"]; still {
		t.Fatal("an unfinished attempt must be dropped")
	}
	if _, err := m.accounts.Get(ctx, "u"); err != ErrNotFound {
		t.Fatalf("the half-made account must be removed: %v", err)
	}
}

func TestConnectedSetsStateBeforeCancellingTheTimer(t *testing.T) {
	m := testManager(t, 5)
	ctx := context.Background()
	_ = m.accounts.Upsert(ctx, "u", "", StatePairing, "")
	var stateWhenCancelled State
	l := &live{userID: "u", client: pairedClient(), cancel: func() {
		a, _ := m.accounts.Get(ctx, "u")
		stateWhenCancelled = a.State
	}}
	m.onEvent(l, &events.Connected{})
	if stateWhenCancelled != StateConnected {
		t.Fatalf("the timer was cancelled while the state was %q: it would read 'pairing' and delete the session", stateWhenCancelled)
	}
}
