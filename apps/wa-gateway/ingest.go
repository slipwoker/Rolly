package main

import (
	"context"
	"strings"
	"time"

	"go.mau.fi/whatsmeow"
	"go.mau.fi/whatsmeow/proto/waE2E"
	"go.mau.fi/whatsmeow/proto/waHistorySync"
	"go.mau.fi/whatsmeow/types"
	"go.mau.fi/whatsmeow/types/events"
	"google.golang.org/protobuf/proto"
)

// directory answers "who is this" for the ingest step. The real one asks the WhatsApp client; tests use a fake.
type directory interface {
	Canonical(ctx context.Context, jid types.JID) types.JID // the stable address of a chat (LID when known)
	ContactName(ctx context.Context, jid types.JID) string  // saved name, else push name, else ""
	GroupName(ctx context.Context, jid types.JID) string
}

type clientDir struct{ c *whatsmeow.Client }

func (d clientDir) Canonical(ctx context.Context, jid types.JID) types.JID {
	jid = jid.ToNonAD()
	if jid.Server == types.DefaultUserServer {
		if lid, err := d.c.Store.LIDs.GetLIDForPN(ctx, jid); err == nil && !lid.IsEmpty() {
			return lid
		}
	}
	return jid
}

func (d clientDir) ContactName(ctx context.Context, jid types.JID) string {
	try := []types.JID{jid.ToNonAD()}
	if jid.Server == types.HiddenUserServer {
		if pn, err := d.c.Store.LIDs.GetPNForLID(ctx, jid); err == nil && !pn.IsEmpty() {
			try = append(try, pn)
		}
	}
	for _, j := range try {
		if ci, err := d.c.Store.Contacts.GetContact(ctx, j); err == nil && ci.Found {
			for _, n := range []string{ci.FullName, ci.FirstName, ci.PushName, ci.BusinessName} {
				if n != "" {
					return n
				}
			}
		}
	}
	return ""
}

func (d clientDir) GroupName(ctx context.Context, jid types.JID) string {
	cctx, cancel := context.WithTimeout(ctx, 8*time.Second)
	defer cancel()
	if info, err := d.c.GetGroupInfo(cctx, jid); err == nil {
		return info.Name
	}
	return ""
}

// Ingester turns library events into stored messages.
type Ingester struct {
	msgs      *MessageStore
	retention time.Duration
	now       func() time.Time
}

// extract returns what Rolly can read aloud. ok=false for protocol noise (reactions, key exchanges, receipts as messages).
func extract(m *waE2E.Message) (kind, text string, media []byte, ok bool) {
	switch {
	case m == nil:
		return "", "", nil, false
	case m.GetConversation() != "":
		return "text", m.GetConversation(), nil, true
	case m.GetExtendedTextMessage() != nil:
		return "text", m.GetExtendedTextMessage().GetText(), nil, true
	case m.GetAudioMessage() != nil:
		a := m.GetAudioMessage()
		kind = "audio"
		if a.GetPTT() {
			kind = "voice"
		}
		b, err := proto.Marshal(a)
		if err != nil {
			return kind, "", nil, true
		}
		return kind, "", b, true
	case m.GetImageMessage() != nil:
		return "image", m.GetImageMessage().GetCaption(), nil, true
	case m.GetVideoMessage() != nil:
		return "video", m.GetVideoMessage().GetCaption(), nil, true
	case m.GetDocumentMessage() != nil:
		d := m.GetDocumentMessage()
		return "document", strings.TrimSpace(d.GetFileName() + " " + d.GetCaption()), nil, true
	case m.GetStickerMessage() != nil:
		return "sticker", "", nil, true
	case m.GetLocationMessage() != nil:
		return "location", strings.TrimSpace(m.GetLocationMessage().GetName() + " " + m.GetLocationMessage().GetAddress()), nil, true
	case m.GetContactMessage() != nil:
		return "contact", m.GetContactMessage().GetDisplayName(), nil, true
	case m.GetPollCreationMessage() != nil:
		return "poll", m.GetPollCreationMessage().GetName(), nil, true
	}
	return "", "", nil, false // reactions, protocol messages, key distribution, ...
}

// Message stores one message. chatName is a hint from history sync (empty for live messages).
func (g *Ingester) Message(ctx context.Context, userID string, dir directory, evt *events.Message, chatName string) error {
	if evt == nil || evt.Message == nil {
		return nil
	}
	chat := evt.Info.Chat
	if chat.Server == types.BroadcastServer || chat.Server == types.NewsletterServer || chat.User == "status" {
		return nil // status updates and channels are not conversations
	}
	kind, text, media, ok := extract(evt.Message)
	if !ok {
		return nil
	}
	chat = dir.Canonical(ctx, chat)
	isGroup := chat.Server == types.GroupServer
	ts := evt.Info.Timestamp.Unix()

	name := chatName
	if name == "" {
		if known, found := g.msgs.ChatName(ctx, userID, ChatRef(userID, chat.String())); !found || known == "" {
			if isGroup {
				name = dir.GroupName(ctx, chat)
			} else {
				name = dir.ContactName(ctx, chat)
			}
		}
	}
	ref, err := g.msgs.UpsertChat(ctx, userID, chat.String(), name, isGroup, ts)
	if err != nil {
		return err
	}
	sender := ""
	if !evt.Info.IsFromMe && isGroup {
		if sender = dir.ContactName(ctx, evt.Info.Sender); sender == "" {
			sender = evt.Info.PushName
		}
	}
	return g.msgs.AddMessage(ctx, userID, ref, StoredMessage{
		ID: evt.Info.ID, TS: ts, FromMe: evt.Info.IsFromMe, Sender: sender, Kind: kind, Text: text,
	}, media, g.now().Add(g.retention).Unix())
}

// History handles the conversations WhatsApp pushes after linking. Returns how many messages were stored.
func (g *Ingester) History(ctx context.Context, userID string, cli *whatsmeow.Client, dir directory, h *events.HistorySync) (int, error) {
	switch h.Data.GetSyncType() {
	case waHistorySync.HistorySync_INITIAL_BOOTSTRAP, waHistorySync.HistorySync_RECENT, waHistorySync.HistorySync_FULL, waHistorySync.HistorySync_ON_DEMAND:
	default:
		return 0, nil
	}
	stored := 0
	for _, conv := range h.Data.GetConversations() {
		chatJID, err := types.ParseJID(conv.GetID())
		if err != nil {
			continue
		}
		hint := conv.GetName()
		if hint == "" {
			hint = conv.GetDisplayName()
		}
		for _, hm := range conv.GetMessages() {
			evt, err := cli.ParseWebMessage(chatJID, hm.GetMessage())
			if err != nil {
				continue
			}
			if err := g.Message(ctx, userID, dir, evt, hint); err != nil {
				return stored, err
			}
			stored++
		}
	}
	return stored, nil
}
