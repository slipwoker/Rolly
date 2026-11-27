package main

import (
	"context"
	"testing"
	"time"

	"go.mau.fi/whatsmeow/proto/waVnameCert"
	"go.mau.fi/whatsmeow/proto/waWeb"
	"go.mau.fi/whatsmeow/types"
	"google.golang.org/protobuf/proto"
)

var bizLID = types.NewJID("77700011122", types.HiddenUserServer)

func chatNameOf(t *testing.T, m *Manager, jid types.JID) string {
	t.Helper()
	name, _ := m.msgs.ChatName(context.Background(), "u", ChatRef("u", jid.String()))
	return name
}

func TestBusinessNameNamesAnUnsavedChat(t *testing.T) {
	m := testManager(t, 5)
	g := &Ingester{msgs: m.msgs, retention: time.Hour, now: time.Now}
	ctx := context.Background()
	e := textEvt(bizLID, bizLID, "b1", "היום עד עכשיו", false, time.Now())
	e.Info.PushName = "someone's own choice"
	e.Info.VerifiedName = &types.VerifiedName{Details: &waVnameCert.VerifiedNameCertificate_Details{VerifiedName: proto.String("Instinct")}}
	if err := g.Message(ctx, "u", fakeDir{}, e, ""); err != nil {
		t.Fatal(err)
	}
	if got := chatNameOf(t, m, bizLID); got != "Instinct" {
		t.Fatalf("the verified business name wins over the push name: %q", got)
	}
	// and it is found by the Hebrew spelling
	if cs, _ := m.msgs.Chats(ctx, "u", "אינסטינקט", nil, 5); len(cs) != 1 {
		t.Fatalf("the Hebrew spelling should find it: %+v", cs)
	}
}

func TestPushNameIsTheNextFallbackAndOnlyFromTheOtherSide(t *testing.T) {
	m := testManager(t, 5)
	g := &Ingester{msgs: m.msgs, retention: time.Hour, now: time.Now}
	ctx := context.Background()
	other := types.NewJID("55500011122", types.HiddenUserServer)
	in := textEvt(other, other, "p1", "hi", false, time.Now())
	in.Info.PushName = "Yoni"
	_ = g.Message(ctx, "u", fakeDir{}, in, "")
	if got := chatNameOf(t, m, other); got != "Yoni" {
		t.Fatalf("push name as the fallback: %q", got)
	}
	mine := types.NewJID("55500099988", types.HiddenUserServer)
	out := textEvt(mine, mine, "p2", "hi", true, time.Now())
	out.Info.PushName = "My own name"
	_ = g.Message(ctx, "u", fakeDir{}, out, "")
	if got := chatNameOf(t, m, mine); got != "" {
		t.Fatalf("our own push name must never name someone else's chat: %q", got)
	}
}

func TestSavedNameBeatsFallbackAndReplacesItLater(t *testing.T) {
	m := testManager(t, 5)
	g := &Ingester{msgs: m.msgs, retention: time.Hour, now: time.Now}
	ctx := context.Background()
	first := textEvt(bizLID, bizLID, "s1", "x", false, time.Now())
	first.Info.PushName = "Nick"
	_ = g.Message(ctx, "u", fakeDir{}, first, "")
	if got := chatNameOf(t, m, bizLID); got != "Nick" {
		t.Fatalf("fallback first: %q", got)
	}
	// the user saves the contact: the next message brings the saved name
	saved := fakeDir{contacts: map[string]string{bizLID.String(): "Nikolai Cohen"}}
	second := textEvt(bizLID, bizLID, "s2", "y", false, time.Now())
	second.Info.PushName = "Nick"
	_ = g.Message(ctx, "u", saved, second, "")
	if got := chatNameOf(t, m, bizLID); got != "Nikolai Cohen" {
		t.Fatalf("a saved name replaces the fallback: %q", got)
	}
	// and a later fallback never replaces a saved name
	third := textEvt(bizLID, bizLID, "s3", "z", false, time.Now())
	third.Info.PushName = "Nick again"
	_ = g.Message(ctx, "u", fakeDir{}, third, "")
	if got := chatNameOf(t, m, bizLID); got != "Nikolai Cohen" {
		t.Fatalf("the saved name stays: %q", got)
	}
}

func TestHistorySyncBusinessNameAndGroupsUnaffected(t *testing.T) {
	m := testManager(t, 5)
	g := &Ingester{msgs: m.msgs, retention: time.Hour, now: time.Now}
	ctx := context.Background()
	h := textEvt(bizLID, bizLID, "h1", "x", false, time.Now())
	h.SourceWebMsg = &waWeb.WebMessageInfo{VerifiedBizName: proto.String("Instinct")}
	_ = g.Message(ctx, "u", fakeDir{}, h, "")
	if got := chatNameOf(t, m, bizLID); got != "Instinct" {
		t.Fatalf("history carries the business name on the web message: %q", got)
	}
	ge := textEvt(grp, noaPN, "g1", "x", false, time.Now())
	ge.Info.PushName = "Noa the sender"
	_ = g.Message(ctx, "u", fakeDir{groups: map[string]string{}}, ge, "")
	if got := chatNameOf(t, m, grp); got != "" {
		t.Fatalf("a group is never named after a sender: %q", got)
	}
}
