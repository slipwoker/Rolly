package main

import (
	"context"
	"encoding/hex"
	"sort"
	"strings"

	"go.mau.fi/whatsmeow/types"
)

// TEMPORARY, admin-only diagnostics (added 2026-11-27 to see how a contact is really stored when a name search finds nothing).
// Reached only through rolly-api's /v1/admin/whatsapp/lookup (the owner's token). It returns the shape of the stored data, never
// message text, never a phone number or a chat address: a name, its bytes (to spot hidden characters), whether it is a group,
// the kind of address the chat is keyed by, and the names WhatsApp knows for a number. REMOVE when the question is answered.

type DebugChat struct {
	Name        string `json:"name"`
	NameHex     string `json:"name_hex"` // the UTF-8 bytes: shows direction marks and look-alike letters
	IsGroup     bool   `json:"is_group"`
	AddressKind string `json:"address_kind"` // lid | phone | group | other
	LastTS      int64  `json:"last_ts"`
	Messages    int    `json:"messages"`
	// what WhatsApp knows about this chat's contact (needs the live connection); nil = nothing found or not connected
	Contact    *DebugContact `json:"contact,omitempty"`
	PhoneKnown bool          `json:"phone_known"` // for a LID chat: WhatsApp has told us which phone number it is
}

type DebugContact struct {
	Address      string `json:"address"` // "phone" or "lid": which form of the number this entry is for
	Found        bool   `json:"found"`
	FullName     string `json:"full_name,omitempty"`
	FirstName    string `json:"first_name,omitempty"`
	PushName     string `json:"push_name,omitempty"`
	BusinessName string `json:"business_name,omitempty"`
}

type DebugResult struct {
	Chats        []DebugChat    `json:"chats"`
	Contacts     []DebugContact `json:"contacts,omitempty"`
	TotalChats   int            `json:"total_chats"`
	UnnamedChats int            `json:"unnamed_chats"`
	Connected    bool           `json:"connected"` // contact names need the live connection
}

func addressKind(jid string) string {
	switch {
	case strings.HasSuffix(jid, "@lid"):
		return "lid"
	case strings.HasSuffix(jid, "@s.whatsapp.net"):
		return "phone"
	case strings.HasSuffix(jid, "@g.us"):
		return "group"
	}
	return "other"
}

// debugJIDs are the addresses a number can be keyed by: the phone form and, if WhatsApp has told us, the LID.
func (m *Manager) debugJIDs(ctx context.Context, userID, phone string) (pn types.JID, lid types.JID) {
	pn = types.NewJID(digits(phone), types.DefaultUserServer)
	m.mu.Lock()
	l := m.live[userID]
	m.mu.Unlock()
	if l != nil && l.client.Store != nil && l.client.Store.LIDs != nil {
		if got, err := l.client.Store.LIDs.GetLIDForPN(ctx, pn); err == nil && !got.IsEmpty() {
			lid = got
		}
	}
	return pn, lid
}

// DebugLookup finds chats by name (the same matching as the search) and/or by phone number, and says what WhatsApp knows
// about the number. At most 10 chats.
func (m *Manager) DebugLookup(ctx context.Context, userID, q, phone string, listUnnamed bool) (*DebugResult, error) {
	res := &DebugResult{Chats: []DebugChat{}}
	m.mu.Lock()
	l := m.live[userID]
	m.mu.Unlock()
	res.Connected = l != nil && l.client.IsConnected()

	total, unnamed, err := m.msgs.chatCounts(ctx, userID)
	if err != nil {
		return nil, err
	}
	res.TotalChats, res.UnnamedChats = total, unnamed

	want := map[string]bool{}
	if strings.TrimSpace(q) != "" {
		found, err := m.msgs.Chats(ctx, userID, q, nil, 10)
		if err != nil {
			return nil, err
		}
		for _, c := range found {
			want[c.Ref] = true
		}
	}
	if d := digits(phone); len(d) >= 8 {
		pn, lid := m.debugJIDs(ctx, userID, d)
		for _, j := range []types.JID{pn, lid} {
			if j.IsEmpty() {
				continue
			}
			want[ChatRef(userID, j.String())] = true
			if l != nil && l.client.Store != nil && l.client.Store.Contacts != nil {
				ci, cerr := l.client.Store.Contacts.GetContact(ctx, j)
				kind := "phone"
				if j.Server == types.HiddenUserServer {
					kind = "lid"
				}
				dc := DebugContact{Address: kind}
				if cerr == nil && ci.Found {
					dc = DebugContact{Address: kind, Found: true, FullName: ci.FullName, FirstName: ci.FirstName, PushName: ci.PushName, BusinessName: ci.BusinessName}
				}
				res.Contacts = append(res.Contacts, dc)
			}
		}
	}
	if listUnnamed { // the most recent 1:1 chats that have no name stored
		refs, err := m.msgs.unnamedRefs(ctx, userID, 10)
		if err != nil {
			return nil, err
		}
		for _, r := range refs {
			want[r] = true
		}
	}
	for ref := range want {
		if len(res.Chats) >= 10 {
			break
		}
		c, ok, err := m.msgs.debugChat(ctx, userID, ref)
		if err != nil {
			return nil, err
		}
		if !ok {
			continue
		}
		if jidStr, err := m.msgs.ChatJID(ctx, userID, ref); err == nil && l != nil {
			c.Contact, c.PhoneKnown = m.debugContactFor(ctx, l, jidStr)
		}
		res.Chats = append(res.Chats, c)
	}
	sort.Slice(res.Chats, func(i, j int) bool { return res.Chats[i].LastTS > res.Chats[j].LastTS })
	return res, nil
}

// debugContactFor asks WhatsApp's own contact store about the number behind a chat, through both of its addresses.
func (m *Manager) debugContactFor(ctx context.Context, l *live, jidStr string) (*DebugContact, bool) {
	if l.client.Store == nil || l.client.Store.Contacts == nil {
		return nil, false
	}
	jid, err := types.ParseJID(jidStr)
	if err != nil {
		return nil, false
	}
	cands := []types.JID{jid}
	phoneKnown := jid.Server == types.DefaultUserServer
	if l.client.Store.LIDs != nil {
		if jid.Server == types.HiddenUserServer {
			if pn, err := l.client.Store.LIDs.GetPNForLID(ctx, jid); err == nil && !pn.IsEmpty() {
				cands, phoneKnown = append(cands, pn), true
			}
		} else if jid.Server == types.DefaultUserServer {
			if lid, err := l.client.Store.LIDs.GetLIDForPN(ctx, jid); err == nil && !lid.IsEmpty() {
				cands = append(cands, lid)
			}
		}
	}
	for _, c := range cands {
		if ci, err := l.client.Store.Contacts.GetContact(ctx, c); err == nil && ci.Found {
			return &DebugContact{Address: addressKind(c.String()), Found: true, FullName: ci.FullName, FirstName: ci.FirstName, PushName: ci.PushName, BusinessName: ci.BusinessName}, phoneKnown
		}
	}
	return nil, phoneKnown
}

func (s *MessageStore) unnamedRefs(ctx context.Context, userID string, limit int) ([]string, error) {
	rows, err := s.db.QueryContext(ctx, s.q(`SELECT ref FROM wa_chats WHERE user_id = ? AND name = '' AND is_group = 0 ORDER BY last_ts DESC LIMIT ?`), userID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var r string
		if err := rows.Scan(&r); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

func (s *MessageStore) chatCounts(ctx context.Context, userID string) (total, unnamed int, err error) {
	err = s.db.QueryRowContext(ctx, s.q(`SELECT COUNT(*), COUNT(CASE WHEN name = '' AND is_group = 0 THEN 1 END) FROM wa_chats WHERE user_id = ?`), userID).Scan(&total, &unnamed)
	return
}

func (s *MessageStore) debugChat(ctx context.Context, userID, ref string) (DebugChat, bool, error) {
	var c DebugChat
	var jid string
	var g int
	err := s.db.QueryRowContext(ctx, s.q(`SELECT name, is_group, jid, last_ts FROM wa_chats WHERE user_id = ? AND ref = ?`), userID, ref).Scan(&c.Name, &g, &jid, &c.LastTS)
	if err != nil {
		if isNoRows(err) {
			return c, false, nil
		}
		return c, false, err
	}
	c.IsGroup = g == 1
	c.NameHex = hex.EncodeToString([]byte(c.Name))
	c.AddressKind = addressKind(jid)
	if err := s.db.QueryRowContext(ctx, s.q(`SELECT COUNT(*) FROM wa_messages WHERE user_id = ? AND chat_ref = ?`), userID, ref).Scan(&c.Messages); err != nil {
		return c, false, err
	}
	return c, true, nil
}
