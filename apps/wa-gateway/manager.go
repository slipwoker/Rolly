package main

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"

	"go.mau.fi/whatsmeow"
	"go.mau.fi/whatsmeow/proto/waE2E"
	"go.mau.fi/whatsmeow/store/sqlstore"
	"go.mau.fi/whatsmeow/types"
	"go.mau.fi/whatsmeow/types/events"
	waLog "go.mau.fi/whatsmeow/util/log"
	"google.golang.org/protobuf/proto"
)

var (
	ErrAlreadyLinked = errors.New("this user already has a linked WhatsApp")
	ErrAccountLimit  = errors.New("account limit reached")
	ErrBadMode       = errors.New("mode must be qr or code")
	ErrConsent       = errors.New("the user must accept the linking terms first")
	ErrBadPhone      = errors.New("phone number must be digits with country code, for example 972501234567")
)

// live is the in-memory side of an account: the connected client and the link attempt in progress.
type live struct {
	userID string
	client *whatsmeow.Client

	mu       sync.Mutex
	qr       string // current QR payload while pairing by QR
	code     string // pairing code while pairing by code
	deadline time.Time
	cancel   context.CancelFunc // stops the link-attempt timer
}

// Manager owns every user's WhatsApp connection. There must be exactly ONE gateway instance: a linked device cannot be
// connected twice (the second connection replaces the first and both fight).
type Manager struct {
	cfg       Config
	container *sqlstore.Container
	accounts  *AccountStore
	msgs      *MessageStore
	ingest    *Ingester
	stt       *Transcriber
	log       waLog.Logger

	now          func() time.Time
	drafts       drafts
	sendOverride func(userID string) (sender, error) // tests

	mu   sync.Mutex
	live map[string]*live
}

func NewManager(cfg Config, container *sqlstore.Container, accounts *AccountStore, log waLog.Logger) *Manager {
	msgs := NewMessageStore(accounts.db, accounts.pg, cfg.Sealer)
	retention := time.Duration(cfg.RetentionDays) * 24 * time.Hour
	if cfg.RetentionDays <= 0 {
		retention = 30 * 24 * time.Hour
	}
	return &Manager{
		cfg: cfg, container: container, accounts: accounts, log: log, live: map[string]*live{}, now: time.Now,
		msgs:   msgs,
		ingest: &Ingester{msgs: msgs, retention: retention, now: time.Now},
		stt:    &Transcriber{URL: cfg.STTURL, Token: cfg.STTToken, Language: cfg.STTLanguage},
	}
}

// Start reconnects every linked account, staggered so a restart does not look like a burst.
func (m *Manager) Start(ctx context.Context) error {
	list, err := m.accounts.List(ctx)
	if err != nil {
		return err
	}
	for _, a := range list {
		switch {
		case a.JID == "": // a link attempt that never finished before the restart
			_ = m.accounts.Delete(ctx, a.UserID)
		case a.State == StateNeedsRelink || a.State == StateBanned || a.State == StateClientOutdated:
			// stays as it is; the user relinks, or the library gets updated
		default:
			if err := m.resume(ctx, a); err != nil {
				m.log.Errorf("resume %s: %v", a.UserID, err)
			}
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-time.After(400 * time.Millisecond):
			}
		}
	}
	return nil
}

func (m *Manager) resume(ctx context.Context, a Account) error {
	jid, err := types.ParseJID(a.JID)
	if err != nil {
		return m.accounts.Upsert(ctx, a.UserID, "", StateNeedsRelink, "stored device id is invalid")
	}
	dev, err := m.container.GetDevice(ctx, jid)
	if err != nil {
		return err
	}
	if dev == nil {
		return m.accounts.Upsert(ctx, a.UserID, "", StateNeedsRelink, "session keys are missing")
	}
	l := m.attach(a.UserID, whatsmeow.NewClient(dev, m.log.Sub(a.UserID)))
	if err := l.client.Connect(); err != nil {
		return m.accounts.Upsert(ctx, a.UserID, "", StateReconnecting, err.Error())
	}
	return nil
}

func (m *Manager) attach(userID string, c *whatsmeow.Client) *live {
	l := &live{userID: userID, client: c}
	m.mu.Lock()
	m.live[userID] = l
	m.mu.Unlock()
	c.AddEventHandler(func(e any) { m.onEvent(l, e) })
	return l
}

// onEvent maps library events to the small State set. It never logs message content or phone numbers.
func (m *Manager) onEvent(l *live, e any) {
	ctx := context.Background()
	set := func(s State, msg string) {
		if err := m.accounts.Upsert(ctx, l.userID, "", s, msg); err != nil {
			m.log.Errorf("state %s -> %s: %v", l.userID, s, err)
		}
	}
	switch v := e.(type) {
	case *events.PairSuccess:
		// remember which device belongs to this user as soon as it exists, so a restart can resume it
		if err := m.accounts.Upsert(ctx, l.userID, v.ID.String(), StatePairing, ""); err != nil {
			m.log.Errorf("save jid %s: %v", l.userID, err)
		}
	case *events.Message:
		if err := m.ingest.Message(ctx, l.userID, clientDir{l.client}, v, ""); err != nil {
			m.log.Errorf("store message %s: %v", l.userID, err) // never log the message itself
		}
	case *events.HistorySync:
		go func() { // can be hundreds of chats; must not block the event queue
			n, err := m.ingest.History(context.Background(), l.userID, l.client, clientDir{l.client}, v)
			if err != nil {
				m.log.Errorf("history %s: %v", l.userID, err)
			}
			m.log.Infof("history sync %s: stored %d messages", l.userID, n)
		}()
	case *events.Connected:
		set(StateConnected, "") // first: the link-attempt timer below reads this state when it is cancelled
		l.mu.Lock()
		l.qr, l.code = "", ""
		if l.cancel != nil {
			l.cancel()
			l.cancel = nil
		}
		l.mu.Unlock()
	case *events.Disconnected:
		if a, err := m.accounts.Get(ctx, l.userID); err == nil && a.State == StateConnected {
			set(StateReconnecting, "")
		}
	case *events.LoggedOut:
		set(StateNeedsRelink, fmt.Sprintf("logged out (%v)", v.Reason))
		m.forget(ctx, l)
	case *events.TemporaryBan:
		set(StateBanned, v.String())
	case *events.StreamReplaced:
		set(StateConflict, "another connection replaced this one")
	case *events.ClientOutdated:
		set(StateClientOutdated, "WhatsApp rejected this client version")
	case *events.ConnectFailure:
		switch {
		case v.Reason == events.ConnectFailureUnknownLogout:
			set(StateBanned, v.Reason.String())
		case v.Reason.IsLoggedOut():
			set(StateNeedsRelink, v.Reason.String())
			m.forget(ctx, l)
		}
	}
}

// forget drops the live client and its device keys (they are useless after a logout).
func (m *Manager) forget(ctx context.Context, l *live) {
	l.client.Disconnect()
	if l.client.Store != nil && l.client.Store.ID != nil {
		_ = m.container.DeleteDevice(ctx, l.client.Store)
	}
	m.mu.Lock()
	if m.live[l.userID] == l {
		delete(m.live, l.userID)
	}
	m.mu.Unlock()
}

// LinkInfo is what the app shows: a QR payload (to render as a QR code) or a pairing code (to type in WhatsApp).
type LinkInfo struct {
	State   State  `json:"state"`
	Mode    string `json:"mode"`
	QR      string `json:"qr,omitempty"`
	Code    string `json:"code,omitempty"`
	Seconds int    `json:"expires_in_s"`
}

// StartLink opens a link attempt. mode is "qr" or "code" (code needs phone: digits with country code).
func (m *Manager) StartLink(ctx context.Context, userID, mode, phone string, consent bool) (*LinkInfo, error) {
	if mode != "qr" && mode != "code" {
		return nil, ErrBadMode
	}
	if !consent {
		return nil, ErrConsent // the app shows the terms; the gateway refuses to link without the user's yes
	}
	phone = digits(phone)
	if mode == "code" && (len(phone) < 8 || len(phone) > 15) {
		return nil, ErrBadPhone
	}
	existing, err := m.accounts.Get(ctx, userID)
	switch {
	case err == nil && (existing.State == StateConnected || existing.State == StateReconnecting):
		return nil, ErrAlreadyLinked
	case errors.Is(err, ErrNotFound):
		if n, cerr := m.accounts.Count(ctx); cerr == nil && n >= m.cfg.MaxAccounts {
			return nil, ErrAccountLimit
		}
	case err != nil:
		return nil, err
	}
	m.abandon(ctx, userID) // an earlier unfinished attempt

	lctx, cancel := context.WithTimeout(context.Background(), time.Duration(m.cfg.LinkTimeout)*time.Second)
	l := m.attach(userID, whatsmeow.NewClient(m.container.NewDevice(), m.log.Sub(userID)))
	l.mu.Lock()
	l.cancel = cancel
	l.deadline = time.Now().Add(time.Duration(m.cfg.LinkTimeout) * time.Second)
	l.mu.Unlock()
	if err := m.accounts.Upsert(ctx, userID, "", StatePairing, ""); err != nil {
		cancel()
		return nil, err
	}
	_ = m.accounts.MarkConsent(ctx, userID, m.now())

	qrCh, err := l.client.GetQRChannel(lctx)
	if err != nil {
		cancel()
		return nil, err
	}
	if err := l.client.Connect(); err != nil {
		cancel()
		m.abandon(ctx, userID)
		return nil, err
	}
	go m.watchQR(l, qrCh)
	go func() { // when the attempt runs out and nothing was linked, clean up
		<-lctx.Done()
		m.expireLink(l)
	}()

	if mode == "code" {
		time.Sleep(2500 * time.Millisecond) // the socket must be up before the code can be requested
		code, err := l.client.PairPhone(ctx, phone, true, whatsmeow.PairClientChrome, "Chrome (Linux)")
		if err != nil {
			cancel()
			m.abandon(ctx, userID)
			return nil, fmt.Errorf("pairing code: %w", err)
		}
		l.mu.Lock()
		l.code = code
		l.mu.Unlock()
		return &LinkInfo{State: StatePairing, Mode: mode, Code: code, Seconds: m.cfg.LinkTimeout}, nil
	}
	// qr: the first code arrives within a second or two
	for i := 0; i < 30; i++ {
		l.mu.Lock()
		qr := l.qr
		l.mu.Unlock()
		if qr != "" {
			return &LinkInfo{State: StatePairing, Mode: mode, QR: qr, Seconds: m.cfg.LinkTimeout}, nil
		}
		time.Sleep(200 * time.Millisecond)
	}
	return &LinkInfo{State: StatePairing, Mode: mode, Seconds: m.cfg.LinkTimeout}, nil
}

// expireLink ends a link attempt that did not finish. It must never touch a client that has paired: the timer is also
// cancelled when the link succeeds, and acting on a half-updated state there deleted a fresh session.
func (m *Manager) expireLink(l *live) {
	if l.client.Store != nil && l.client.Store.ID != nil {
		return // paired: the account lives on
	}
	m.mu.Lock()
	current := m.live[l.userID] == l
	m.mu.Unlock()
	if !current {
		return // replaced by a newer attempt or already removed
	}
	if a, err := m.accounts.Get(context.Background(), l.userID); err == nil && a.State == StatePairing {
		m.abandon(context.Background(), l.userID)
	}
}

func (m *Manager) watchQR(l *live, ch <-chan whatsmeow.QRChannelItem) {
	for item := range ch {
		if item.Event == whatsmeow.QRChannelEventCode {
			l.mu.Lock()
			l.qr = item.Code
			l.mu.Unlock()
		}
	}
}

// Status is the state plus, while pairing, the current QR or code (QR payloads rotate).
func (m *Manager) Status(ctx context.Context, userID string) (State, string, *LinkInfo, error) {
	a, err := m.accounts.Get(ctx, userID)
	if errors.Is(err, ErrNotFound) {
		return StateUnlinked, "", nil, nil
	}
	if err != nil {
		return "", "", nil, err
	}
	var info *LinkInfo
	if a.State == StatePairing {
		m.mu.Lock()
		l := m.live[userID]
		m.mu.Unlock()
		if l != nil {
			l.mu.Lock()
			left := int(time.Until(l.deadline).Seconds())
			if left < 0 {
				left = 0
			}
			mode := "qr"
			if l.code != "" {
				mode = "code"
			}
			info = &LinkInfo{State: StatePairing, Mode: mode, QR: l.qr, Code: l.code, Seconds: left}
			l.mu.Unlock()
		}
	}
	return a.State, a.LastError, info, nil
}

// abandon drops an unfinished link attempt without touching a linked account.
func (m *Manager) abandon(ctx context.Context, userID string) {
	m.mu.Lock()
	l := m.live[userID]
	delete(m.live, userID)
	m.mu.Unlock()
	if l == nil {
		return
	}
	l.mu.Lock()
	if l.cancel != nil {
		l.cancel()
	}
	l.mu.Unlock()
	l.client.Disconnect()
	if l.client.Store != nil && l.client.Store.ID != nil {
		_ = m.container.DeleteDevice(ctx, l.client.Store)
	}
	if a, err := m.accounts.Get(ctx, userID); err == nil && a.JID == "" {
		_ = m.accounts.Delete(ctx, userID)
	}
}

// Unlink logs the device out on WhatsApp's side (it disappears from the phone's Linked devices) and deletes everything
// stored for the user. Safe to call when nothing is linked.
func (m *Manager) Unlink(ctx context.Context, userID string) error {
	m.mu.Lock()
	l := m.live[userID]
	delete(m.live, userID)
	m.mu.Unlock()
	if l != nil {
		if l.client.IsLoggedIn() {
			_ = l.client.Logout(ctx) // also removes the device keys
		} else {
			l.client.Disconnect()
			if l.client.Store != nil && l.client.Store.ID != nil {
				_ = m.container.DeleteDevice(ctx, l.client.Store)
			}
		}
	}
	if err := m.msgs.DeleteUser(ctx, userID); err != nil {
		return err
	}
	return m.accounts.Delete(ctx, userID)
}

// Shutdown disconnects everything without logging out: sessions stay valid for the next start.
func (m *Manager) Shutdown() {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, l := range m.live {
		l.client.Disconnect()
	}
}

func digits(s string) string {
	var b strings.Builder
	for _, r := range s {
		if r >= '0' && r <= '9' {
			b.WriteRune(r)
		}
	}
	return b.String()
}

var (
	ErrNotConnected = errors.New("WhatsApp is not connected for this user")
	ErrNoVoiceNote  = errors.New("no voice note waiting for transcription")
	ErrSTTDisabled  = errors.New("transcription is not configured")
)

// Transcribe downloads one stored voice note, transcribes it and keeps only the transcript.
func (m *Manager) Transcribe(ctx context.Context, userID, chatRef, msgID string) (string, error) {
	if !m.stt.Enabled() {
		return "", ErrSTTDisabled
	}
	raw, err := m.msgs.Media(ctx, userID, chatRef, msgID)
	if err != nil || len(raw) == 0 {
		return "", ErrNoVoiceNote
	}
	m.mu.Lock()
	l := m.live[userID]
	m.mu.Unlock()
	if l == nil || !l.client.IsConnected() {
		return "", ErrNotConnected
	}
	var audio waE2E.AudioMessage
	if err := proto.Unmarshal(raw, &audio); err != nil {
		return "", ErrNoVoiceNote
	}
	data, err := l.client.Download(ctx, &audio)
	if err != nil {
		return "", fmt.Errorf("download: %w", err)
	}
	text, err := m.stt.Transcribe(ctx, data)
	if err != nil {
		return "", err
	}
	if err := m.msgs.SetTranscript(ctx, userID, chatRef, msgID, text); err != nil {
		return "", err
	}
	return text, nil
}

// Stats is for monitoring and has no user data in it.
type Stats struct {
	Accounts      map[State]int `json:"accounts"`
	Live          int           `json:"live_connections"`
	Messages      int           `json:"messages"`
	Chats         int           `json:"chats"`
	OldestMessage int64         `json:"oldest_message_ts,omitempty"`
	Sends24h      int           `json:"sends_24h"`
	STT           bool          `json:"transcription_configured"`
}

func (m *Manager) Stats(ctx context.Context) (*Stats, error) {
	counts, err := m.accounts.StateCounts(ctx)
	if err != nil {
		return nil, err
	}
	s := &Stats{Accounts: counts, STT: m.stt.Enabled()}
	m.mu.Lock()
	for _, l := range m.live {
		if l.client.IsConnected() {
			s.Live++
		}
	}
	m.mu.Unlock()
	s.Messages, s.Chats, s.OldestMessage, s.Sends24h, err = m.msgs.Totals(ctx, m.now().Add(-24*time.Hour))
	return s, err
}
