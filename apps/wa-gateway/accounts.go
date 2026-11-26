package main

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"
)

// State is what rolly-api sees. It is deliberately small: the assistant must be able to tell the user what is wrong.
type State string

const (
	StateUnlinked       State = "unlinked"        // no WhatsApp linked
	StatePairing        State = "pairing"         // a link attempt is open (QR or code issued)
	StateConnected      State = "connected"       // linked and online
	StateReconnecting   State = "reconnecting"    // linked, connection dropped, the library is retrying
	StateNeedsRelink    State = "needs_relink"    // the phone removed the device, or WhatsApp logged it out
	StateBanned         State = "banned"          // WhatsApp restricted the account (temporary or permanent)
	StateConflict       State = "conflict"        // another process connected with the same device (a second gateway instance)
	StateClientOutdated State = "client_outdated" // WhatsApp rejects this library version: needs an update, not the user
)

// Account is one Rolly user's WhatsApp link.
type Account struct {
	UserID    string `json:"user_id"`
	JID       string `json:"-"` // never leaves the gateway: it contains the user's phone number
	State     State  `json:"state"`
	LastError string `json:"last_error,omitempty"`
	LinkedAt  int64  `json:"linked_at,omitempty"` // unix seconds
	UpdatedAt int64  `json:"updated_at"`
}

var ErrNotFound = errors.New("account not found")

// AccountStore keeps the user -> device mapping and the last known state, next to whatsmeow's own tables.
type AccountStore struct {
	db      *sql.DB
	pg      bool
	nowFunc func() time.Time
}

func NewAccountStore(db *sql.DB, postgres bool) *AccountStore {
	return &AccountStore{db: db, pg: postgres, nowFunc: time.Now}
}

func (s *AccountStore) Migrate(ctx context.Context) error {
	_, err := s.db.ExecContext(ctx, `CREATE TABLE IF NOT EXISTS wa_accounts (
		user_id    TEXT PRIMARY KEY,
		jid        TEXT NOT NULL DEFAULT '',
		state      TEXT NOT NULL,
		last_error TEXT NOT NULL DEFAULT '',
		linked_at  BIGINT NOT NULL DEFAULT 0,
		updated_at BIGINT NOT NULL
	)`)
	return err
}

// rebind turns ? placeholders into $1.. for Postgres.
func (s *AccountStore) rebind(q string) string {
	if !s.pg {
		return q
	}
	var b strings.Builder
	n := 0
	for _, r := range q {
		if r == '?' {
			n++
			fmt.Fprintf(&b, "$%d", n)
		} else {
			b.WriteRune(r)
		}
	}
	return b.String()
}

func (s *AccountStore) Get(ctx context.Context, userID string) (*Account, error) {
	a := &Account{}
	err := s.db.QueryRowContext(ctx, s.rebind(`SELECT user_id, jid, state, last_error, linked_at, updated_at FROM wa_accounts WHERE user_id = ?`), userID).
		Scan(&a.UserID, &a.JID, &a.State, &a.LastError, &a.LinkedAt, &a.UpdatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	return a, err
}

func (s *AccountStore) List(ctx context.Context) ([]Account, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT user_id, jid, state, last_error, linked_at, updated_at FROM wa_accounts ORDER BY user_id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Account
	for rows.Next() {
		var a Account
		if err := rows.Scan(&a.UserID, &a.JID, &a.State, &a.LastError, &a.LinkedAt, &a.UpdatedAt); err != nil {
			return nil, err
		}
		out = append(out, a)
	}
	return out, rows.Err()
}

// Upsert writes state (and jid when non-empty) for a user.
func (s *AccountStore) Upsert(ctx context.Context, userID, jid string, state State, lastErr string) error {
	now := s.nowFunc().Unix()
	linked := int64(0)
	if state == StateConnected {
		linked = now
	}
	_, err := s.db.ExecContext(ctx, s.rebind(`INSERT INTO wa_accounts (user_id, jid, state, last_error, linked_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
		ON CONFLICT (user_id) DO UPDATE SET
			jid = CASE WHEN excluded.jid <> '' THEN excluded.jid ELSE wa_accounts.jid END,
			state = excluded.state,
			last_error = excluded.last_error,
			linked_at = CASE WHEN wa_accounts.linked_at = 0 AND excluded.linked_at > 0 THEN excluded.linked_at ELSE wa_accounts.linked_at END,
			updated_at = excluded.updated_at`), userID, jid, string(state), lastErr, linked, now)
	return err
}

func (s *AccountStore) Delete(ctx context.Context, userID string) error {
	_, err := s.db.ExecContext(ctx, s.rebind(`DELETE FROM wa_accounts WHERE user_id = ?`), userID)
	return err
}

func (s *AccountStore) Count(ctx context.Context) (int, error) {
	var n int
	err := s.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM wa_accounts`).Scan(&n)
	return n, err
}
