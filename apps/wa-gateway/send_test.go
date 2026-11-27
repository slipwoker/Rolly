package main

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

	"go.mau.fi/whatsmeow/types"
)

type fakeSender struct {
	mu    sync.Mutex
	sent  []string
	to    []types.JID
	fail  error
	calls int
}

func (f *fakeSender) Send(_ context.Context, to types.JID, text string) (string, time.Time, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls++
	if f.fail != nil {
		return "", time.Time{}, f.fail
	}
	f.sent = append(f.sent, text)
	f.to = append(f.to, to)
	return "SENT" + string(rune('A'+len(f.sent))), time.Unix(1_800_000_100, 0), nil
}

// sendFixture: a manager with one chat ("דני"), a fake sender and a clock the test controls.
func sendFixture(t *testing.T) (*Manager, *fakeSender, string, *time.Time) {
	t.Helper()
	m := testManager(t, 5)
	clock := time.Unix(1_800_000_000, 0)
	m.now = func() time.Time { return clock }
	fs := &fakeSender{}
	m.sendOverride = func(string) (sender, error) { return fs, nil }
	ref, err := m.msgs.UpsertChat(context.Background(), "u", danLID.String(), "דני", false, clock.Unix())
	if err != nil {
		t.Fatal(err)
	}
	return m, fs, ref, &clock
}

func TestDraftSendsNothingAndConfirmSendsOnce(t *testing.T) {
	m, fs, ref, _ := sendFixture(t)
	ctx := context.Background()
	d, err := m.CreateDraft(ctx, "u", ref, "  אאחר בעשר דקות  ")
	if err != nil || d.ChatName != "דני" || d.Text != "אאחר בעשר דקות" {
		t.Fatalf("draft: %+v %v", d, err)
	}
	if fs.calls != 0 {
		t.Fatal("a draft must not send")
	}
	sent, err := m.ConfirmDraft(ctx, "u", d.ID)
	if err != nil || sent.ChatName != "דני" || fs.calls != 1 || fs.to[0] != danLID {
		t.Fatalf("confirm: %+v %v calls=%d", sent, err, fs.calls)
	}
	if _, err := m.ConfirmDraft(ctx, "u", d.ID); !errors.Is(err, ErrDraftNotFound) && !errors.Is(err, ErrDraftUsed) {
		t.Fatalf("second confirm must fail: %v", err)
	}
	if fs.calls != 1 {
		t.Fatalf("sent twice: %d", fs.calls)
	}
	msgs, _ := m.msgs.Messages(ctx, "u", ref, 0, 0, 10)
	if len(msgs) != 1 || !msgs[0].FromMe || msgs[0].Text != "אאחר בעשר דקות" {
		t.Fatalf("own message not kept in history: %+v", msgs)
	}
}

func TestDraftIsBoundToUserAndExpires(t *testing.T) {
	m, fs, ref, clock := sendFixture(t)
	ctx := context.Background()
	d, _ := m.CreateDraft(ctx, "u", ref, "שלום")
	if _, err := m.ConfirmDraft(ctx, "someone-else", d.ID); !errors.Is(err, ErrDraftNotFound) {
		t.Fatalf("another user must not confirm: %v", err)
	}
	*clock = clock.Add(3 * time.Minute) // past the 120 s default
	if _, err := m.ConfirmDraft(ctx, "u", d.ID); !errors.Is(err, ErrDraftNotFound) {
		t.Fatalf("expired draft must fail: %v", err)
	}
	if fs.calls != 0 {
		t.Fatal("nothing should have been sent")
	}
	d2, _ := m.CreateDraft(ctx, "u", ref, "שלום")
	m.CancelDraft("u", d2.ID)
	if _, err := m.ConfirmDraft(ctx, "u", d2.ID); !errors.Is(err, ErrDraftNotFound) {
		t.Fatalf("cancelled draft must fail: %v", err)
	}
}

func TestTextValidation(t *testing.T) {
	m, _, ref, _ := sendFixture(t)
	ctx := context.Background()
	for _, bad := range []string{"", "   ", "‮​", strings.Repeat("א", 1001)} {
		if _, err := m.CreateDraft(ctx, "u", ref, bad); !errors.Is(err, ErrBadText) {
			t.Fatalf("%q should be refused: %v", bad, err)
		}
	}
	d, err := m.CreateDraft(ctx, "u", ref, "שלום‮ עולם\u0007")
	if err != nil || d.Text != "שלום עולם" {
		t.Fatalf("control and bidi-override characters must be stripped: %q %v", d.Text, err)
	}
	if _, err := m.CreateDraft(ctx, "u", "0123456789abcdef", "שלום"); !errors.Is(err, ErrChatNotFound) {
		t.Fatalf("unknown chat: %v", err)
	}
	if _, err := m.CreateDraft(ctx, "other", ref, "שלום"); !errors.Is(err, ErrChatNotFound) {
		t.Fatalf("another user's chat must not be addressable: %v", err)
	}
	// status/broadcast and channels are never valid targets
	bref, _ := m.msgs.UpsertChat(ctx, "u", "status@broadcast", "סטטוס", false, 1)
	if _, err := m.CreateDraft(ctx, "u", bref, "שלום"); !errors.Is(err, ErrChatNotFound) {
		t.Fatalf("broadcast must be refused: %v", err)
	}
}

func TestMinimumGapAndDailyCap(t *testing.T) {
	m, fs, ref, clock := sendFixture(t)
	m.cfg.SendPerDay, m.cfg.SendMinGapS = 3, 4
	ctx := context.Background()
	send := func() error {
		d, err := m.CreateDraft(ctx, "u", ref, "היי")
		if err != nil {
			t.Fatal(err)
		}
		_, err = m.ConfirmDraft(ctx, "u", d.ID)
		return err
	}
	if err := send(); err != nil {
		t.Fatal(err)
	}
	var rl *RateLimitError
	if err := send(); !errors.As(err, &rl) || rl.Reason != "too_fast" || rl.RetryAfter <= 0 || rl.RetryAfter > 4*time.Second {
		t.Fatalf("second send right away must be too_fast: %v", err)
	}
	if fs.calls != 1 {
		t.Fatalf("rate-limited send went out: %d", fs.calls)
	}
	*clock = clock.Add(5 * time.Second)
	if err := send(); err != nil {
		t.Fatal(err)
	}
	*clock = clock.Add(5 * time.Second)
	if err := send(); err != nil {
		t.Fatal(err)
	}
	*clock = clock.Add(5 * time.Second)
	if err := send(); !errors.As(err, &rl) || rl.Reason != "daily_cap" || rl.RetryAfter < 23*time.Hour {
		t.Fatalf("fourth send in 24 h must hit the cap: %v", err)
	}
	*clock = clock.Add(24 * time.Hour)
	if err := send(); err != nil {
		t.Fatalf("a day later it must work again: %v", err)
	}
}

func TestFailedSendCanBeRetriedAndNotConnected(t *testing.T) {
	m, fs, ref, clock := sendFixture(t)
	ctx := context.Background()
	d, _ := m.CreateDraft(ctx, "u", ref, "היי")
	fs.fail = errors.New("network")
	if _, err := m.ConfirmDraft(ctx, "u", d.ID); err == nil {
		t.Fatal("want an error")
	}
	fs.fail = nil
	*clock = clock.Add(5 * time.Second)
	if _, err := m.ConfirmDraft(ctx, "u", d.ID); err != nil {
		t.Fatalf("the draft must stay usable after a failed send: %v", err)
	}
	m.sendOverride = func(string) (sender, error) { return nil, ErrNotConnected }
	d2, _ := m.CreateDraft(ctx, "u", ref, "היי")
	if _, err := m.ConfirmDraft(ctx, "u", d2.ID); !errors.Is(err, ErrNotConnected) {
		t.Fatalf("want not connected: %v", err)
	}
}

func TestSendHTTPFlow(t *testing.T) {
	m, fs, ref, _ := sendFixture(t)
	srv := &Server{cfg: Config{Token: testToken}, m: m}
	rec := do(srv, "POST", "/v1/users/u/send/draft", testToken, `{"chat_ref":"`+ref+`","text":"אני בדרך"}`)
	if rec.Code != http.StatusCreated || strings.Contains(rec.Body.String(), "972") || strings.Contains(rec.Body.String(), "111222333") {
		t.Fatalf("draft: %d %s", rec.Code, rec.Body.String())
	}
	id := between(rec.Body.String(), `"draft_id":"`, `"`)
	if c := do(srv, "POST", "/v1/users/u/send/confirm", "", `{"draft_id":"`+id+`"}`).Code; c != 401 {
		t.Fatalf("confirm needs the token: %d", c)
	}
	if fs.calls != 0 {
		t.Fatal("nothing sent before confirm")
	}
	rec = do(srv, "POST", "/v1/users/u/send/confirm", testToken, `{"draft_id":"`+id+`"}`)
	if rec.Code != 200 || fs.calls != 1 {
		t.Fatalf("confirm: %d %s", rec.Code, rec.Body.String())
	}
	if c := do(srv, "POST", "/v1/users/u/send/confirm", testToken, `{"draft_id":"`+id+`"}`).Code; c != 404 && c != 409 {
		t.Fatalf("reuse: %d", c)
	}
	d2 := do(srv, "POST", "/v1/users/u/send/draft", testToken, `{"chat_ref":"`+ref+`","text":"עוד אחת"}`)
	id2 := between(d2.Body.String(), `"draft_id":"`, `"`)
	rec = do(srv, "POST", "/v1/users/u/send/confirm", testToken, `{"draft_id":"`+id2+`"}`)
	if rec.Code != 429 || rec.Header().Get("Retry-After") == "" || !strings.Contains(rec.Body.String(), "too_fast") {
		t.Fatalf("want 429 too_fast with Retry-After: %d %s %v", rec.Code, rec.Body.String(), rec.Header())
	}
}

func between(s, a, b string) string {
	i := strings.Index(s, a)
	if i < 0 {
		return ""
	}
	s = s[i+len(a):]
	return s[:strings.Index(s, b)]
}
