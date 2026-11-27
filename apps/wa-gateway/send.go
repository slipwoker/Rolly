package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"
	"unicode"
	"unicode/utf8"

	"go.mau.fi/whatsmeow"
	"go.mau.fi/whatsmeow/proto/waE2E"
	"go.mau.fi/whatsmeow/types"
	"google.golang.org/protobuf/proto"
)

// Sending is two steps on purpose. rolly-api creates a DRAFT (recipient + exact text), the assistant reads it back, and
// only a spoken "yes" leads to CONFIRM. The gateway enforces the protocol and the caps; it cannot judge what the user said.

var (
	ErrBadText       = errors.New("message text is empty or too long")
	ErrChatNotFound  = errors.New("chat not found")
	ErrDraftNotFound = errors.New("draft not found or expired")
	ErrDraftUsed     = errors.New("draft was already sent")
)

// RateLimitError says when the next send is allowed.
type RateLimitError struct {
	Reason     string // "daily_cap" | "too_fast"
	RetryAfter time.Duration
}

func (e *RateLimitError) Error() string { return "send limit: " + e.Reason }

// sender abstracts the WhatsApp client so the protocol can be tested without WhatsApp.
type sender interface {
	Send(ctx context.Context, to types.JID, text string) (id string, ts time.Time, err error)
}

type clientSender struct{ c *whatsmeow.Client }

func (s clientSender) Send(ctx context.Context, to types.JID, text string) (string, time.Time, error) {
	// show "typing…" for a moment proportional to the text, like a person would; failures here do not matter
	pause := time.Duration(utf8.RuneCountInString(text)) * 25 * time.Millisecond
	if pause > 2500*time.Millisecond {
		pause = 2500 * time.Millisecond
	}
	if pause < 600*time.Millisecond {
		pause = 600 * time.Millisecond
	}
	_ = s.c.SendChatPresence(ctx, to, types.ChatPresenceComposing, types.ChatPresenceMediaText)
	select {
	case <-ctx.Done():
		return "", time.Time{}, ctx.Err()
	case <-time.After(pause):
	}
	resp, err := s.c.SendMessage(ctx, to, &waE2E.Message{Conversation: proto.String(text)})
	_ = s.c.SendChatPresence(context.Background(), to, types.ChatPresencePaused, types.ChatPresenceMediaText)
	if err != nil {
		return "", time.Time{}, err
	}
	return resp.ID, resp.Timestamp, nil
}

// Draft is what rolly-api reads back to the user before asking for confirmation.
type Draft struct {
	ID        string `json:"draft_id"`
	ChatRef   string `json:"chat_ref"`
	ChatName  string `json:"chat_name"`
	IsGroup   bool   `json:"is_group"`
	Text      string `json:"text"`
	ExpiresIn int    `json:"expires_in_s"`

	userID  string
	expires time.Time
	state   int // 0 open, 1 sending, 2 sent
}

type drafts struct {
	mu sync.Mutex
	m  map[string]*Draft
}

func (d *drafts) sweep(now time.Time) {
	for id, x := range d.m {
		if now.After(x.expires.Add(time.Minute)) {
			delete(d.m, id)
		}
	}
}

// cleanText trims, removes control characters and bounds the length. Empty after cleaning is refused.
func cleanText(s string, max int) (string, error) {
	s = strings.Map(func(r rune) rune {
		if r == '\n' || r == '\t' {
			return r
		}
		if unicode.IsControl(r) || r == '‮' || r == '​' { // bidi override and zero-width are never wanted here
			return -1
		}
		return r
	}, s)
	s = strings.TrimSpace(s)
	if s == "" || utf8.RuneCountInString(s) > max {
		return "", ErrBadText
	}
	return s, nil
}

func newDraftID() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

// CreateDraft checks the chat exists and the text is sane. Nothing is sent.
func (m *Manager) CreateDraft(ctx context.Context, userID, chatRef, text string) (*Draft, error) {
	text, err := cleanText(text, m.cfg.maxSendChars())
	if err != nil {
		return nil, err
	}
	name, ok := m.msgs.ChatName(ctx, userID, chatRef)
	if !ok {
		return nil, ErrChatNotFound
	}
	jid, err := m.msgs.ChatJID(ctx, userID, chatRef)
	if err != nil {
		return nil, ErrChatNotFound
	}
	if pj, perr := types.ParseJID(jid); perr != nil || pj.Server == types.BroadcastServer || pj.Server == types.NewsletterServer {
		return nil, ErrChatNotFound // only people and groups
	}
	ttl := time.Duration(m.cfg.draftTTL()) * time.Second
	now := m.now()
	d := &Draft{ID: newDraftID(), ChatRef: chatRef, ChatName: name, IsGroup: strings.HasSuffix(jid, "@"+types.GroupServer),
		Text: text, ExpiresIn: int(ttl.Seconds()), userID: userID, expires: now.Add(ttl)}
	m.drafts.mu.Lock()
	defer m.drafts.mu.Unlock()
	if m.drafts.m == nil {
		m.drafts.m = map[string]*Draft{}
	}
	m.drafts.sweep(now)
	m.drafts.m[d.ID] = d
	return d, nil
}

// CancelDraft forgets a draft (the user said no). Unknown drafts are fine.
func (m *Manager) CancelDraft(userID, draftID string) {
	m.drafts.mu.Lock()
	defer m.drafts.mu.Unlock()
	if d, ok := m.drafts.m[draftID]; ok && d.userID == userID {
		delete(m.drafts.m, draftID)
	}
}

type SentInfo struct {
	MessageID string `json:"message_id"`
	TS        int64  `json:"ts"`
	ChatName  string `json:"chat_name"`
}

// ConfirmDraft sends the draft once. It enforces: the draft belongs to the user and has not expired, WhatsApp is
// connected, no more than SendPerDay in 24 h, and a minimum gap between sends.
func (m *Manager) ConfirmDraft(ctx context.Context, userID, draftID string) (*SentInfo, error) {
	now := m.now()
	m.drafts.mu.Lock()
	d, ok := m.drafts.m[draftID]
	if !ok || d.userID != userID || now.After(d.expires) {
		m.drafts.mu.Unlock()
		return nil, ErrDraftNotFound
	}
	if d.state != 0 {
		m.drafts.mu.Unlock()
		return nil, ErrDraftUsed
	}
	d.state = 1 // claimed: a double tap or a retry cannot send twice
	m.drafts.mu.Unlock()
	release := func() { // back to open after a failure that did not send anything
		m.drafts.mu.Lock()
		d.state = 0
		m.drafts.mu.Unlock()
	}

	snd, err := m.senderFor(userID)
	if err != nil {
		release()
		return nil, err
	}
	if rl := m.checkSendLimits(ctx, userID, now); rl != nil {
		release()
		return nil, rl
	}
	jidStr, err := m.msgs.ChatJID(ctx, userID, d.ChatRef)
	if err != nil {
		release()
		return nil, ErrChatNotFound
	}
	jid, err := types.ParseJID(jidStr)
	if err != nil {
		release()
		return nil, ErrChatNotFound
	}
	if err := m.msgs.RecordSend(ctx, userID, d.ChatRef, now); err != nil { // counted before sending: a crash must not allow extras
		release()
		return nil, err
	}
	id, ts, err := snd.Send(ctx, jid, d.Text)
	if err != nil {
		release()
		return nil, fmt.Errorf("send: %w", err)
	}
	m.drafts.mu.Lock()
	d.state = 2
	delete(m.drafts.m, d.ID)
	m.drafts.mu.Unlock()

	// keep our own message in the history so the assistant can see what it sent
	_ = m.msgs.AddMessage(ctx, userID, d.ChatRef, StoredMessage{ID: id, TS: ts.Unix(), FromMe: true, Kind: "text", Text: d.Text}, nil,
		now.Add(m.ingest.retention).Unix())
	_, _ = m.msgs.UpsertChat(ctx, userID, jidStr, "", d.IsGroup, ts.Unix())
	return &SentInfo{MessageID: id, TS: ts.Unix(), ChatName: d.ChatName}, nil
}

func (m *Manager) checkSendLimits(ctx context.Context, userID string, now time.Time) *RateLimitError {
	last, count, oldest, err := m.msgs.SendStats(ctx, userID, now.Add(-24*time.Hour))
	if err != nil {
		return &RateLimitError{Reason: "too_fast", RetryAfter: 5 * time.Second} // fail closed
	}
	if gap := time.Duration(m.cfg.sendMinGap()) * time.Second; !last.IsZero() && now.Sub(last) < gap {
		return &RateLimitError{Reason: "too_fast", RetryAfter: gap - now.Sub(last)}
	}
	if count >= m.cfg.sendPerDay() {
		return &RateLimitError{Reason: "daily_cap", RetryAfter: oldest.Add(24 * time.Hour).Sub(now)}
	}
	return nil
}

func (m *Manager) senderFor(userID string) (sender, error) {
	if m.sendOverride != nil {
		return m.sendOverride(userID)
	}
	m.mu.Lock()
	l := m.live[userID]
	m.mu.Unlock()
	if l == nil || !l.client.IsConnected() || !l.client.IsLoggedIn() {
		return nil, ErrNotConnected
	}
	return clientSender{l.client}, nil
}
