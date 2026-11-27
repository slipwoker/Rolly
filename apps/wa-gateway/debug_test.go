package main

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"go.mau.fi/whatsmeow/types"
)

func TestDebugLookupShowsTheShapeOfAStoredName(t *testing.T) {
	m := testManager(t, 5)
	ctx := context.Background()
	lrm := string(rune(0x200e))
	pn := types.NewJID("972506430688", types.DefaultUserServer)
	if _, err := m.msgs.UpsertChat(ctx, "u", pn.String(), "Alex"+lrm+" Dumsky", false, 100); err != nil {
		t.Fatal(err)
	}
	if _, err := m.msgs.UpsertChat(ctx, "u", danLID.String(), "", false, 90); err != nil { // an unnamed chat
		t.Fatal(err)
	}
	g := &Ingester{msgs: m.msgs, retention: time.Hour, now: time.Now}
	_ = g.Message(ctx, "u", fakeDir{}, textEvt(pn, pn, "m1", "hi", false, time.Now()), "")

	byName, err := m.DebugLookup(ctx, "u", "אלכס דומסקי", "", false)
	if err != nil || len(byName.Chats) != 1 {
		t.Fatalf("by name: %+v %v", byName, err)
	}
	c := byName.Chats[0]
	if !strings.Contains(c.NameHex, "e2808e") { // U+200E in UTF-8
		t.Fatalf("the hidden direction mark must be visible in the bytes: %s", c.NameHex)
	}
	if c.AddressKind != "phone" || c.IsGroup || c.Messages != 1 || c.Name == "" {
		t.Fatalf("unexpected chat: %+v", c)
	}
	if byName.TotalChats != 2 || byName.UnnamedChats != 1 || byName.Connected {
		t.Fatalf("counts: %+v", byName)
	}

	byPhone, err := m.DebugLookup(ctx, "u", "", "+972 50-643-0688", false)
	if err != nil || len(byPhone.Chats) != 1 || byPhone.Chats[0].AddressKind != "phone" {
		t.Fatalf("by phone: %+v %v", byPhone, err)
	}
	for _, r := range []*DebugResult{byName, byPhone} {
		b, _ := json.Marshal(r)
		if strings.Contains(string(b), "972") || strings.Contains(string(b), "@") || strings.Contains(string(b), "hi") {
			t.Fatalf("the answer must carry no number, address or message text: %s", b)
		}
	}
	if none, _ := m.DebugLookup(ctx, "u", "", "972999999999", false); len(none.Chats) != 0 {
		t.Fatalf("an unknown number finds nothing: %+v", none)
	}
	if other, _ := m.DebugLookup(ctx, "someone-else", "alex", "972506430688", false); len(other.Chats) != 0 {
		t.Fatalf("another user's chats must not be visible: %+v", other)
	}
}

func TestDebugRouteNeedsTheToken(t *testing.T) {
	srv := &Server{cfg: Config{Token: testToken}, m: testManager(t, 5)}
	if c := do(srv, "GET", "/v1/users/u/debug/lookup?q=alex", "", "").Code; c != 401 {
		t.Fatalf("no token: %d", c)
	}
	if c := do(srv, "GET", "/v1/users/u/debug/lookup?q=alex", testToken, "").Code; c != 200 {
		t.Fatalf("with token: %d", c)
	}
}

func TestDebugLookupListsTheNewestUnnamedChats(t *testing.T) {
	m := testManager(t, 5)
	ctx := context.Background()
	for i := 0; i < 12; i++ { // twelve unnamed 1:1 chats, one named chat and one unnamed group
		jid := types.NewJID("11122233"+string(rune('0'+i%10))+string(rune('a'+i)), types.HiddenUserServer)
		if _, err := m.msgs.UpsertChat(ctx, "u", jid.String(), "", false, int64(1000+i)); err != nil {
			t.Fatal(err)
		}
	}
	_, _ = m.msgs.UpsertChat(ctx, "u", types.NewJID("999", types.HiddenUserServer).String(), "Named", false, 5000)
	_, _ = m.msgs.UpsertChat(ctx, "u", grp.String(), "", true, 6000)
	res, err := m.DebugLookup(ctx, "u", "", "", true)
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Chats) != 10 {
		t.Fatalf("at most ten, got %d", len(res.Chats))
	}
	for i, c := range res.Chats {
		if c.Name != "" || c.IsGroup {
			t.Fatalf("only unnamed one-to-one chats: %+v", c)
		}
		if i > 0 && c.LastTS > res.Chats[i-1].LastTS {
			t.Fatal("newest first")
		}
	}
	if res.Chats[0].LastTS != 1011 || res.UnnamedChats != 12+0 {
		t.Fatalf("newest first and counted without the group: first=%d unnamed=%d", res.Chats[0].LastTS, res.UnnamedChats)
	}
	b, _ := json.Marshal(res)
	if strings.Contains(string(b), "@") || strings.Contains(string(b), "1112223") {
		t.Fatalf("no address in the answer: %s", b)
	}
}
