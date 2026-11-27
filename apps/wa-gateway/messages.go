package main

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"strings"
	"time"
)

// MessageStore keeps the last RetentionDays of each user's messages. It never stores audio: a voice note keeps only the
// encrypted media pointer until it is transcribed on request, then only the transcript.
type MessageStore struct {
	db     *sql.DB
	pg     bool
	sealer *Sealer // nil = plaintext (tests only; LoadConfig refuses it unless WA_ALLOW_PLAINTEXT=1)
}

func NewMessageStore(db *sql.DB, postgres bool, sealer *Sealer) *MessageStore {
	return &MessageStore{db: db, pg: postgres, sealer: sealer}
}

func (s *MessageStore) q(query string) string { return rebind(s.pg, query) }

func (s *MessageStore) Migrate(ctx context.Context) error {
	blob := "BLOB"
	if s.pg {
		blob = "BYTEA"
	}
	stmts := []string{
		`CREATE TABLE IF NOT EXISTS wa_chats (
			user_id  TEXT NOT NULL,
			ref      TEXT NOT NULL,
			jid      TEXT NOT NULL,
			name     TEXT NOT NULL DEFAULT '',
			is_group INTEGER NOT NULL DEFAULT 0,
			last_ts  BIGINT NOT NULL DEFAULT 0,
			PRIMARY KEY (user_id, ref)
		)`,
		`CREATE UNIQUE INDEX IF NOT EXISTS wa_chats_jid ON wa_chats (user_id, jid)`,
		`CREATE TABLE IF NOT EXISTS wa_messages (
			user_id     TEXT NOT NULL,
			chat_ref    TEXT NOT NULL,
			msg_id      TEXT NOT NULL,
			sender_name TEXT NOT NULL DEFAULT '',
			from_me     INTEGER NOT NULL DEFAULT 0,
			ts          BIGINT NOT NULL,
			kind        TEXT NOT NULL,
			body        TEXT NOT NULL DEFAULT '',
			transcript  TEXT,
			media       ` + blob + `,
			expires_at  BIGINT NOT NULL,
			PRIMARY KEY (user_id, chat_ref, msg_id)
		)`,
		`CREATE INDEX IF NOT EXISTS wa_messages_chat_ts ON wa_messages (user_id, chat_ref, ts)`,
		`CREATE INDEX IF NOT EXISTS wa_messages_expiry ON wa_messages (expires_at)`,
		`CREATE TABLE IF NOT EXISTS wa_sends (user_id TEXT NOT NULL, chat_ref TEXT NOT NULL, ts BIGINT NOT NULL)`, // no content, only counts for the caps
		`CREATE INDEX IF NOT EXISTS wa_sends_user_ts ON wa_sends (user_id, ts)`,
	}
	for _, st := range stmts {
		if _, err := s.db.ExecContext(ctx, st); err != nil {
			return err
		}
	}
	return nil
}

// ChatRef is the opaque handle rolly-api uses for a chat. It is derived, so the phone number never leaves the gateway.
func ChatRef(userID, jid string) string {
	h := sha256.Sum256([]byte(userID + "|" + jid))
	return hex.EncodeToString(h[:])[:16]
}

type Chat struct {
	Ref     string `json:"ref"`
	Name    string `json:"name"`
	IsGroup bool   `json:"is_group"`
	LastTS  int64  `json:"last_ts"`
	Unnamed bool   `json:"unnamed,omitempty"` // a 1:1 chat with someone who is not in the contacts
}

type StoredMessage struct {
	ID              string `json:"id"`
	TS              int64  `json:"ts"`
	FromMe          bool   `json:"from_me"`
	Sender          string `json:"sender,omitempty"`
	Kind            string `json:"kind"` // text, voice, audio, image, video, document, sticker, location, contact, poll, other
	Text            string `json:"text,omitempty"`
	Transcript      string `json:"transcript,omitempty"`
	CanTranscribe   bool   `json:"can_transcribe,omitempty"` // a voice note whose transcript has not been made yet
	TranscribeError string `json:"transcribe_error,omitempty"`
}

// UpsertChat creates the chat or refreshes its name/last timestamp (a non-empty name wins; last_ts only moves forward).
func (s *MessageStore) UpsertChat(ctx context.Context, userID, jid, name string, isGroup bool, ts int64) (string, error) {
	ref := ChatRef(userID, jid)
	g := 0
	if isGroup {
		g = 1
	}
	_, err := s.db.ExecContext(ctx, s.q(`INSERT INTO wa_chats (user_id, ref, jid, name, is_group, last_ts) VALUES (?, ?, ?, ?, ?, ?)
		ON CONFLICT (user_id, ref) DO UPDATE SET
			name = CASE WHEN excluded.name <> '' THEN excluded.name ELSE wa_chats.name END,
			last_ts = CASE WHEN excluded.last_ts > wa_chats.last_ts THEN excluded.last_ts ELSE wa_chats.last_ts END`),
		userID, ref, jid, name, g, ts)
	return ref, err
}

// ChatJID returns the WhatsApp address of a chat (needed to send; never returned over the API).
func (s *MessageStore) ChatJID(ctx context.Context, userID, ref string) (string, error) {
	var jid string
	err := s.db.QueryRowContext(ctx, s.q(`SELECT jid FROM wa_chats WHERE user_id = ? AND ref = ?`), userID, ref).Scan(&jid)
	if errors.Is(err, sql.ErrNoRows) {
		return "", ErrNotFound
	}
	return jid, err
}

func (s *MessageStore) ChatName(ctx context.Context, userID, ref string) (string, bool) {
	var name string
	err := s.db.QueryRowContext(ctx, s.q(`SELECT name FROM wa_chats WHERE user_id = ? AND ref = ?`), userID, ref).Scan(&name)
	return name, err == nil
}

// AddMessage stores one message; a message that is already stored is left alone.
func (s *MessageStore) AddMessage(ctx context.Context, userID, chatRef string, m StoredMessage, media []byte, expiresAt int64) error {
	from := 0
	if m.FromMe {
		from = 1
	}
	body, err := s.sealer.SealString(userID, m.Text)
	if err != nil {
		return err
	}
	sealedMedia, err := s.sealer.SealBytes(userID, media)
	if err != nil {
		return err
	}
	_, err = s.db.ExecContext(ctx, s.q(`INSERT INTO wa_messages (user_id, chat_ref, msg_id, sender_name, from_me, ts, kind, body, media, expires_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (user_id, chat_ref, msg_id) DO NOTHING`),
		userID, chatRef, m.ID, m.Sender, from, m.TS, m.Kind, body, sealedMedia, expiresAt)
	return err
}

// Chats lists chats, newest first. q matches the name: first as plain text (case, direction marks and punctuation ignored), then,
// only if that finds nothing, by consonant skeleton across Hebrew and Latin letters (translit.go), so "אלכס דומסקי" finds "Alex Dumsky".
func (s *MessageStore) Chats(ctx context.Context, userID, q string, groups *bool, limit int) ([]Chat, error) {
	query := `SELECT ref, name, is_group, last_ts FROM wa_chats WHERE user_id = ?`
	args := []any{userID}
	if groups != nil {
		g := 0
		if *groups {
			g = 1
		}
		query += ` AND is_group = ?`
		args = append(args, g)
	}
	q = strings.TrimSpace(q)
	if q == "" { // no name: just the most recent chats
		query += ` ORDER BY last_ts DESC LIMIT ?`
		args = append(args, limit)
		return s.scanChats(ctx, query, args)
	}
	if fold(q) == "" {
		return []Chat{}, nil // nothing searchable in it (for example only punctuation): never "everything"
	}
	query += ` ORDER BY last_ts DESC LIMIT 5000` // an address book fits; matching happens in Go
	all, err := s.scanChats(ctx, query, args)
	if err != nil {
		return nil, err
	}
	var plain, fuzzy []Chat
	for _, c := range all {
		switch nameMatches(c.Name, q) {
		case 1:
			plain = append(plain, c)
		case 2:
			fuzzy = append(fuzzy, c)
		}
	}
	out := plain
	if len(out) == 0 {
		out = fuzzy // the loose match is only a fallback: a plain match is never mixed with guesses
	}
	if len(out) > limit {
		out = out[:limit]
	}
	if out == nil {
		out = []Chat{}
	}
	return out, nil
}

func (s *MessageStore) scanChats(ctx context.Context, query string, args []any) ([]Chat, error) {
	rows, err := s.db.QueryContext(ctx, s.q(query), args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Chat{}
	for rows.Next() {
		var c Chat
		var g int
		if err := rows.Scan(&c.Ref, &c.Name, &g, &c.LastTS); err != nil {
			return nil, err
		}
		c.IsGroup = g == 1
		c.Unnamed = c.Name == "" && !c.IsGroup
		out = append(out, c)
	}
	return out, rows.Err()
}

func likeEscape(s string) string {
	r := strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`)
	return r.Replace(s)
}

// Messages returns up to limit messages of a chat in [since, before) as the NEWEST limit of that window, oldest first.
func (s *MessageStore) Messages(ctx context.Context, userID, chatRef string, since, before int64, limit int) ([]StoredMessage, error) {
	query := `SELECT msg_id, ts, from_me, sender_name, kind, body, transcript, (media IS NOT NULL AND kind IN ('voice','audio'))
		FROM wa_messages WHERE user_id = ? AND chat_ref = ? AND ts >= ?`
	args := []any{userID, chatRef, since}
	if before > 0 {
		query += ` AND ts < ?`
		args = append(args, before)
	}
	query += ` ORDER BY ts DESC LIMIT ?`
	args = append(args, limit)
	rows, err := s.db.QueryContext(ctx, s.q(query), args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []StoredMessage
	for rows.Next() {
		var m StoredMessage
		var from int
		var tr sql.NullString
		var can bool
		if err := rows.Scan(&m.ID, &m.TS, &from, &m.Sender, &m.Kind, &m.Text, &tr, &can); err != nil {
			return nil, err
		}
		m.FromMe = from == 1
		if m.Text, err = s.sealer.OpenString(userID, m.Text); err != nil {
			return nil, err
		}
		if tr.Valid {
			if m.Transcript, err = s.sealer.OpenString(userID, tr.String); err != nil {
				return nil, err
			}
		}
		m.CanTranscribe = can && !tr.Valid
		out = append(out, m)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	for i, j := 0, len(out)-1; i < j; i, j = i+1, j-1 { // oldest first
		out[i], out[j] = out[j], out[i]
	}
	return out, nil
}

func (s *MessageStore) Media(ctx context.Context, userID, chatRef, msgID string) ([]byte, error) {
	var b []byte
	err := s.db.QueryRowContext(ctx, s.q(`SELECT media FROM wa_messages WHERE user_id = ? AND chat_ref = ? AND msg_id = ?`), userID, chatRef, msgID).Scan(&b)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return s.sealer.OpenBytes(userID, b)
}

// SetTranscript stores the transcript and drops the media pointer: nothing to download from here on.
func (s *MessageStore) SetTranscript(ctx context.Context, userID, chatRef, msgID, text string) error {
	sealed, err := s.sealer.SealString(userID, text)
	if err != nil {
		return err
	}
	_, err = s.db.ExecContext(ctx, s.q(`UPDATE wa_messages SET transcript = ?, media = NULL WHERE user_id = ? AND chat_ref = ? AND msg_id = ?`),
		sealed, userID, chatRef, msgID)
	return err
}

// Purge deletes expired messages and chats that no longer hold any message. Returns the number of messages removed.
func (s *MessageStore) Purge(ctx context.Context, now time.Time) (int64, error) {
	res, err := s.db.ExecContext(ctx, s.q(`DELETE FROM wa_messages WHERE expires_at <= ?`), now.Unix())
	if err != nil {
		return 0, err
	}
	n, _ := res.RowsAffected()
	_, _ = s.db.ExecContext(ctx, s.q(`DELETE FROM wa_sends WHERE ts < ?`), now.Add(-48*time.Hour).UnixMilli())
	_, err = s.db.ExecContext(ctx, `DELETE FROM wa_chats WHERE NOT EXISTS (SELECT 1 FROM wa_messages m WHERE m.user_id = wa_chats.user_id AND m.chat_ref = wa_chats.ref)`)
	return n, err
}

// DeleteUser removes everything stored for the user.
func (s *MessageStore) DeleteUser(ctx context.Context, userID string) error {
	for _, t := range []string{"wa_messages", "wa_chats", "wa_sends"} {
		if _, err := s.db.ExecContext(ctx, s.q(`DELETE FROM `+t+` WHERE user_id = ?`), userID); err != nil {
			return err
		}
	}
	return nil
}

// RecordSend logs that a message was sent (no content) so the caps can be enforced across restarts.
func (s *MessageStore) RecordSend(ctx context.Context, userID, chatRef string, at time.Time) error {
	_, err := s.db.ExecContext(ctx, s.q(`INSERT INTO wa_sends (user_id, chat_ref, ts) VALUES (?, ?, ?)`), userID, chatRef, at.UnixMilli())
	return err
}

// SendStats returns the time of the last send and the number of sends since the cutoff (and the oldest of them).
func (s *MessageStore) SendStats(ctx context.Context, userID string, since time.Time) (last time.Time, count int, oldest time.Time, err error) {
	var maxTS, minTS sql.NullInt64
	err = s.db.QueryRowContext(ctx, s.q(`SELECT MAX(ts), MIN(CASE WHEN ts >= ? THEN ts END), COUNT(CASE WHEN ts >= ? THEN 1 END) FROM wa_sends WHERE user_id = ?`),
		since.UnixMilli(), since.UnixMilli(), userID).Scan(&maxTS, &minTS, &count)
	if maxTS.Valid {
		last = time.UnixMilli(maxTS.Int64)
	}
	if minTS.Valid {
		oldest = time.UnixMilli(minTS.Int64)
	}
	return
}

// Totals are counts for monitoring.
func (s *MessageStore) Totals(ctx context.Context, since time.Time) (messages, chats, unnamed int, oldest int64, sends int, err error) {
	var o sql.NullInt64
	if err = s.db.QueryRowContext(ctx, `SELECT COUNT(*), MIN(ts) FROM wa_messages`).Scan(&messages, &o); err != nil {
		return
	}
	oldest = o.Int64
	if err = s.db.QueryRowContext(ctx, `SELECT COUNT(*), COUNT(CASE WHEN name = '' AND is_group = 0 THEN 1 END) FROM wa_chats`).Scan(&chats, &unnamed); err != nil {
		return
	}
	err = s.db.QueryRowContext(ctx, s.q(`SELECT COUNT(*) FROM wa_sends WHERE ts >= ?`), since.UnixMilli()).Scan(&sends)
	return
}

func isNoRows(err error) bool { return errors.Is(err, sql.ErrNoRows) }
