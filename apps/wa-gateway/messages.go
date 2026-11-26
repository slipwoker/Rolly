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
	db *sql.DB
	pg bool
}

func NewMessageStore(db *sql.DB, postgres bool) *MessageStore {
	return &MessageStore{db: db, pg: postgres}
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
	_, err := s.db.ExecContext(ctx, s.q(`INSERT INTO wa_messages (user_id, chat_ref, msg_id, sender_name, from_me, ts, kind, body, media, expires_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (user_id, chat_ref, msg_id) DO NOTHING`),
		userID, chatRef, m.ID, m.Sender, from, m.TS, m.Kind, m.Text, media, expiresAt)
	return err
}

// Chats lists chats, newest first. q matches the name (case-insensitive, substring).
func (s *MessageStore) Chats(ctx context.Context, userID, q string, groups *bool, limit int) ([]Chat, error) {
	query := `SELECT ref, name, is_group, last_ts FROM wa_chats WHERE user_id = ?`
	args := []any{userID}
	if q = strings.TrimSpace(q); q != "" {
		query += ` AND lower(name) LIKE ? ESCAPE '\'`
		args = append(args, "%"+likeEscape(strings.ToLower(q))+"%")
	}
	if groups != nil {
		g := 0
		if *groups {
			g = 1
		}
		query += ` AND is_group = ?`
		args = append(args, g)
	}
	query += ` ORDER BY last_ts DESC LIMIT ?`
	args = append(args, limit)
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
		m.Transcript = tr.String
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
	return b, err
}

// SetTranscript stores the transcript and drops the media pointer: nothing to download from here on.
func (s *MessageStore) SetTranscript(ctx context.Context, userID, chatRef, msgID, text string) error {
	_, err := s.db.ExecContext(ctx, s.q(`UPDATE wa_messages SET transcript = ?, media = NULL WHERE user_id = ? AND chat_ref = ? AND msg_id = ?`),
		text, userID, chatRef, msgID)
	return err
}

// Purge deletes expired messages and chats that no longer hold any message. Returns the number of messages removed.
func (s *MessageStore) Purge(ctx context.Context, now time.Time) (int64, error) {
	res, err := s.db.ExecContext(ctx, s.q(`DELETE FROM wa_messages WHERE expires_at <= ?`), now.Unix())
	if err != nil {
		return 0, err
	}
	n, _ := res.RowsAffected()
	_, err = s.db.ExecContext(ctx, `DELETE FROM wa_chats WHERE NOT EXISTS (SELECT 1 FROM wa_messages m WHERE m.user_id = wa_chats.user_id AND m.chat_ref = wa_chats.ref)`)
	return n, err
}

// DeleteUser removes everything stored for the user.
func (s *MessageStore) DeleteUser(ctx context.Context, userID string) error {
	for _, t := range []string{"wa_messages", "wa_chats"} {
		if _, err := s.db.ExecContext(ctx, s.q(`DELETE FROM `+t+` WHERE user_id = ?`), userID); err != nil {
			return err
		}
	}
	return nil
}
