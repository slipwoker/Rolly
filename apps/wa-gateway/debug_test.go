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

	byName, err := m.DebugLookup(ctx, "u", "אלכס דומסקי", "")
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

	byPhone, err := m.DebugLookup(ctx, "u", "", "+972 50-643-0688")
	if err != nil || len(byPhone.Chats) != 1 || byPhone.Chats[0].AddressKind != "phone" {
		t.Fatalf("by phone: %+v %v", byPhone, err)
	}
	for _, r := range []*DebugResult{byName, byPhone} {
		b, _ := json.Marshal(r)
		if strings.Contains(string(b), "972") || strings.Contains(string(b), "@") || strings.Contains(string(b), "hi") {
			t.Fatalf("the answer must carry no number, address or message text: %s", b)
		}
	}
	if none, _ := m.DebugLookup(ctx, "u", "", "972999999999"); len(none.Chats) != 0 {
		t.Fatalf("an unknown number finds nothing: %+v", none)
	}
	if other, _ := m.DebugLookup(ctx, "someone-else", "alex", "972506430688"); len(other.Chats) != 0 {
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
