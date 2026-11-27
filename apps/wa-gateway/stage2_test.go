package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"go.mau.fi/whatsmeow/proto/waE2E"
	"go.mau.fi/whatsmeow/types"
	"go.mau.fi/whatsmeow/types/events"
	"google.golang.org/protobuf/proto"
)

type fakeDir struct {
	contacts map[string]string
	groups   map[string]string
	lids     map[string]types.JID // phone-number JID string -> LID
}

func (f fakeDir) Canonical(_ context.Context, j types.JID) types.JID {
	if l, ok := f.lids[j.String()]; ok {
		return l
	}
	return j
}
func (f fakeDir) ContactName(_ context.Context, j types.JID) string { return f.contacts[j.String()] }
func (f fakeDir) GroupName(_ context.Context, j types.JID) string   { return f.groups[j.String()] }

var (
	danPN  = types.NewJID("972501110001", types.DefaultUserServer)
	danLID = types.NewJID("111222333", types.HiddenUserServer)
	grp    = types.NewJID("120363000000000001", types.GroupServer)
	noaPN  = types.NewJID("972502220002", types.DefaultUserServer)
)

func testDir() fakeDir {
	return fakeDir{
		contacts: map[string]string{danLID.String(): "דני", noaPN.String(): "נועה"},
		groups:   map[string]string{grp.String(): "משפחה"},
		lids:     map[string]types.JID{danPN.String(): danLID},
	}
}

func textEvt(chat, sender types.JID, id, text string, fromMe bool, at time.Time) *events.Message {
	return &events.Message{
		Info:    types.MessageInfo{MessageSource: types.MessageSource{Chat: chat, Sender: sender, IsFromMe: fromMe, IsGroup: chat.Server == types.GroupServer}, ID: id, Timestamp: at, PushName: "push"},
		Message: &waE2E.Message{Conversation: proto.String(text)},
	}
}

func testIngester(t *testing.T) (*Ingester, *MessageStore) {
	t.Helper()
	m := testManager(t, 5)
	now := time.Unix(1_800_000_000, 0)
	return &Ingester{msgs: m.msgs, retention: 30 * 24 * time.Hour, now: func() time.Time { return now }}, m.msgs
}

func TestIngestCanonicalChatNameAndOpaqueRef(t *testing.T) {
	g, store := testIngester(t)
	ctx := context.Background()
	at := time.Unix(1_799_999_000, 0)
	// the same person arrives once by phone-number address and once by LID: one chat
	if err := g.Message(ctx, "u", testDir(), textEvt(danPN, danPN, "m1", "היי", false, at), ""); err != nil {
		t.Fatal(err)
	}
	if err := g.Message(ctx, "u", testDir(), textEvt(danLID, danLID, "m2", "מה קורה", false, at.Add(time.Minute)), ""); err != nil {
		t.Fatal(err)
	}
	chats, err := store.Chats(ctx, "u", "דנ", nil, 10)
	if err != nil || len(chats) != 1 {
		t.Fatalf("want one chat, got %+v (%v)", chats, err)
	}
	if chats[0].Name != "דני" || chats[0].IsGroup || len(chats[0].Ref) != 16 {
		t.Fatalf("unexpected chat %+v", chats[0])
	}
	b, _ := json.Marshal(chats)
	if strings.Contains(string(b), "972501110001") || strings.Contains(string(b), "111222333") {
		t.Fatalf("address leaked: %s", b)
	}
	msgs, _ := store.Messages(ctx, "u", chats[0].Ref, 0, 0, 10)
	if len(msgs) != 2 || msgs[0].Text != "היי" || msgs[1].Text != "מה קורה" {
		t.Fatalf("messages not oldest-first: %+v", msgs)
	}
}

func TestIngestGroupSenderAndSkippedKinds(t *testing.T) {
	g, store := testIngester(t)
	ctx := context.Background()
	at := time.Unix(1_799_999_000, 0)
	_ = g.Message(ctx, "u", testDir(), textEvt(grp, noaPN, "g1", "מי מביא עוגה?", false, at), "")
	chats, _ := store.Chats(ctx, "u", "", nil, 10)
	if len(chats) != 1 || !chats[0].IsGroup || chats[0].Name != "משפחה" {
		t.Fatalf("group chat wrong: %+v", chats)
	}
	msgs, _ := store.Messages(ctx, "u", chats[0].Ref, 0, 0, 10)
	if len(msgs) != 1 || msgs[0].Sender != "נועה" {
		t.Fatalf("sender wrong: %+v", msgs)
	}
	react := &events.Message{Info: types.MessageInfo{MessageSource: types.MessageSource{Chat: grp, Sender: noaPN}, ID: "r1", Timestamp: at},
		Message: &waE2E.Message{ReactionMessage: &waE2E.ReactionMessage{Text: proto.String("👍")}}}
	status := textEvt(types.NewJID("status", types.BroadcastServer), noaPN, "s1", "סטטוס", false, at)
	_ = g.Message(ctx, "u", testDir(), react, "")
	_ = g.Message(ctx, "u", testDir(), status, "")
	if after, _ := store.Messages(ctx, "u", chats[0].Ref, 0, 0, 10); len(after) != 1 {
		t.Fatalf("reactions or status were stored: %+v", after)
	}
	if all, _ := store.Chats(ctx, "u", "", nil, 10); len(all) != 1 {
		t.Fatalf("status created a chat: %+v", all)
	}
}

func TestVoiceNoteKeepsPointerThenOnlyTranscript(t *testing.T) {
	g, store := testIngester(t)
	ctx := context.Background()
	voice := &events.Message{
		Info:    types.MessageInfo{MessageSource: types.MessageSource{Chat: noaPN, Sender: noaPN}, ID: "v1", Timestamp: time.Unix(1_799_999_000, 0)},
		Message: &waE2E.Message{AudioMessage: &waE2E.AudioMessage{PTT: proto.Bool(true), Seconds: proto.Uint32(4), DirectPath: proto.String("/x")}},
	}
	if err := g.Message(ctx, "u", testDir(), voice, ""); err != nil {
		t.Fatal(err)
	}
	chats, _ := store.Chats(ctx, "u", "", nil, 10)
	ref := chats[0].Ref
	msgs, _ := store.Messages(ctx, "u", ref, 0, 0, 10)
	if len(msgs) != 1 || msgs[0].Kind != "voice" || !msgs[0].CanTranscribe || msgs[0].Transcript != "" {
		t.Fatalf("voice note wrong: %+v", msgs)
	}
	if err := store.SetTranscript(ctx, "u", ref, "v1", "בסדר גמור"); err != nil {
		t.Fatal(err)
	}
	msgs, _ = store.Messages(ctx, "u", ref, 0, 0, 10)
	if msgs[0].Transcript != "בסדר גמור" || msgs[0].CanTranscribe {
		t.Fatalf("transcript not kept: %+v", msgs[0])
	}
	if b, _ := store.Media(ctx, "u", ref, "v1"); len(b) != 0 {
		t.Fatal("media pointer must be dropped after transcription")
	}
}

func TestWindowLimitAndSearchEscaping(t *testing.T) {
	g, store := testIngester(t)
	ctx := context.Background()
	base := time.Unix(1_799_000_000, 0)
	for i := 0; i < 10; i++ {
		_ = g.Message(ctx, "u", testDir(), textEvt(noaPN, noaPN, "m"+string(rune('a'+i)), "הודעה", false, base.Add(time.Duration(i)*time.Minute)), "")
	}
	ref := ChatRef("u", noaPN.String())
	last3, _ := store.Messages(ctx, "u", ref, 0, 0, 3)
	if len(last3) != 3 || last3[0].TS != base.Add(7*time.Minute).Unix() || last3[2].TS != base.Add(9*time.Minute).Unix() {
		t.Fatalf("want the newest 3, oldest first: %+v", last3)
	}
	since, _ := store.Messages(ctx, "u", ref, base.Add(8*time.Minute).Unix(), 0, 50)
	if len(since) != 2 {
		t.Fatalf("since filter: %d", len(since))
	}
	if r, _ := store.Chats(ctx, "u", "%", nil, 10); len(r) != 0 {
		t.Fatalf("a literal %% must not match everything: %+v", r)
	}
	if r, _ := store.Chats(ctx, "u", "נוע", nil, 10); len(r) != 1 {
		t.Fatalf("name search: %+v", r)
	}
}

func TestPurgeRemovesExpiredAndEmptyChats(t *testing.T) {
	g, store := testIngester(t)
	ctx := context.Background()
	_ = g.Message(ctx, "u", testDir(), textEvt(noaPN, noaPN, "old", "ישן", false, time.Unix(1_700_000_000, 0)), "")
	n, err := store.Purge(ctx, time.Unix(1_800_000_000, 0).Add(31*24*time.Hour))
	if err != nil || n != 1 {
		t.Fatalf("purge: n=%d err=%v", n, err)
	}
	if c, _ := store.Chats(ctx, "u", "", nil, 10); len(c) != 0 {
		t.Fatalf("empty chat kept: %+v", c)
	}
}

func TestUnlinkDeletesMessages(t *testing.T) {
	m := testManager(t, 5)
	ctx := context.Background()
	g := &Ingester{msgs: m.msgs, retention: time.Hour, now: time.Now}
	_ = g.Message(ctx, "u", testDir(), textEvt(noaPN, noaPN, "x", "שלום", false, time.Now()), "")
	_ = g.Message(ctx, "other", testDir(), textEvt(noaPN, noaPN, "y", "שלום", false, time.Now()), "")
	if err := m.Unlink(ctx, "u"); err != nil {
		t.Fatal(err)
	}
	if c, _ := m.msgs.Chats(ctx, "u", "", nil, 10); len(c) != 0 {
		t.Fatal("data of the unlinked user remains")
	}
	if c, _ := m.msgs.Chats(ctx, "other", "", nil, 10); len(c) != 1 {
		t.Fatal("another user's data was deleted")
	}
}

func TestHTTPChatsMessagesAndTranscribeWithoutConnection(t *testing.T) {
	stt := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.Write([]byte(`{"text":"שלום"}`)) }))
	defer stt.Close()
	m := testManager(t, 5)
	m.stt = &Transcriber{URL: stt.URL}
	srv := &Server{cfg: Config{Token: testToken}, m: m}
	ctx := context.Background()
	g := &Ingester{msgs: m.msgs, retention: time.Hour, now: time.Now}
	_ = g.Message(ctx, "u", testDir(), textEvt(noaPN, noaPN, "t1", "בוקר טוב", false, time.Now()), "")
	voice := &events.Message{Info: types.MessageInfo{MessageSource: types.MessageSource{Chat: noaPN, Sender: noaPN}, ID: "v1", Timestamp: time.Now()},
		Message: &waE2E.Message{AudioMessage: &waE2E.AudioMessage{PTT: proto.Bool(true)}}}
	_ = g.Message(ctx, "u", testDir(), voice, "")

	rec := do(srv, "GET", "/v1/users/u/chats?q=נועה", testToken, "")
	var cl struct{ Chats []Chat }
	if err := json.Unmarshal(rec.Body.Bytes(), &cl); err != nil || len(cl.Chats) != 1 {
		t.Fatalf("chats: %d %s", rec.Code, rec.Body.String())
	}
	if strings.Contains(rec.Body.String(), "972502220002") {
		t.Fatal("phone number leaked")
	}
	rec = do(srv, "GET", "/v1/users/u/chats/"+cl.Chats[0].Ref+"/messages?transcribe=1", testToken, "")
	if rec.Code != 200 || !strings.Contains(rec.Body.String(), `"transcribe_error":"not_connected"`) || !strings.Contains(rec.Body.String(), "בוקר טוב") {
		t.Fatalf("messages: %d %s", rec.Code, rec.Body.String())
	}
	if c := do(srv, "GET", "/v1/users/u/chats/zzzz/messages", testToken, "").Code; c != 400 {
		t.Fatalf("bad ref: %d", c)
	}
	if c := do(srv, "GET", "/v1/users/u/chats/0123456789abcdef/messages", testToken, "").Code; c != 404 {
		t.Fatalf("unknown chat: %d", c)
	}
	if c := do(srv, "GET", "/v1/users/other/chats/"+cl.Chats[0].Ref+"/messages", testToken, "").Code; c != 404 {
		t.Fatalf("another user's chat must not be readable: %d", c)
	}
}

func TestTranscriberTextAndErrorWithoutBody(t *testing.T) {
	ok := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer tok" {
			w.WriteHeader(401)
			return
		}
		if err := r.ParseMultipartForm(1 << 20); err != nil || r.FormValue("language") != "he" {
			w.WriteHeader(400)
			return
		}
		w.Write([]byte(`{"text":" בסדר מאור. "}`))
	}))
	defer ok.Close()
	tr := &Transcriber{URL: ok.URL, Token: "tok", Language: "he"}
	got, err := tr.Transcribe(context.Background(), []byte("OggS"))
	if err != nil || got != "בסדר מאור." {
		t.Fatalf("got %q err %v", got, err)
	}
	bad := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(500)
		w.Write([]byte("secret transcript echo"))
	}))
	defer bad.Close()
	_, err = (&Transcriber{URL: bad.URL}).Transcribe(context.Background(), []byte("x"))
	if err == nil || strings.Contains(err.Error(), "secret") {
		t.Fatalf("error must not carry the body: %v", err)
	}
}
