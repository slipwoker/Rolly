package main

import (
	"context"
	"testing"
)

func TestSkeletonIsTheSameAcrossScripts(t *testing.T) {
	same := [][2]string{
		{"אלכס דומסקי", "Alex Dumsky"}, {"דוד", "David"}, {"רביד", "Ravid"}, {"מאור שרון", "Maor Sharon"}, {"דניאל", "Daniel"},
		{"נועה", "Noa"}, {"רוני", "Roni"}, {"חיים", "Haim"}, {"שרון", "Sharon"}, {"יהודית טלקר", "Yehudit Talker"},
	}
	for _, p := range same {
		if nameMatches(p[1], p[0]) == 0 {
			t.Errorf("%q should match %q (skeletons %q / %q)", p[0], p[1], skeleton(p[0]), skeleton(p[1]))
		}
	}
	different := [][2]string{{"דני", "Noa"}, {"אלכס", "Dan"}, {"מאור", "Alex Dumsky"}, {"רונית", "Dan Cohen"}}
	for _, p := range different {
		if nameMatches(p[1], p[0]) != 0 {
			t.Errorf("%q must not match %q", p[0], p[1])
		}
	}
}

func TestFoldIgnoresDirectionMarksAndPunctuation(t *testing.T) {
	lrm := string(rune(0x200e))
	if fold("Alex"+lrm+" Dumsky"+lrm) != "alex dumsky" {
		t.Fatalf("got %q", fold("Alex"+lrm+" Dumsky"+lrm))
	}
	if fold("  Dr. O'Neil-Smith ") != "dr o neil smith" {
		t.Fatalf("got %q", fold("  Dr. O'Neil-Smith "))
	}
	if fold("%") != "" || fold("   ") != "" {
		t.Fatal("punctuation alone must fold to nothing")
	}
}

func TestShortSkeletonsMatchOnlyWholeNames(t *testing.T) {
	// "נועה" has a one-letter skeleton: it may find "Noa" but not "Noam Levi" or "Nina"
	if nameMatches("Noa", "נועה") == 0 {
		t.Fatal("Noa should be found")
	}
	for _, other := range []string{"Noam Levi", "Nina", "Anan"} {
		if nameMatches(other, "נועה") != 0 {
			t.Fatalf("%q must not match a one-letter skeleton", other)
		}
	}
}

func TestChatSearchFindsHebrewSpellingOfLatinNames(t *testing.T) {
	m := testManager(t, 5)
	ctx := context.Background()
	lrm := string(rune(0x200e))
	for i, n := range []string{"Alex" + lrm + " Dumsky", "אלכס כהן", "Alexandra Peretz", "David Darmon", "Zappy + רביד", ""} {
		if _, err := m.msgs.UpsertChat(ctx, "u", "jid"+string(rune('a'+i))+"@s.whatsapp.net", n, false, int64(100-i)); err != nil {
			t.Fatal(err)
		}
	}
	names := func(q string) []string {
		cs, err := m.msgs.Chats(ctx, "u", q, nil, 10)
		if err != nil {
			t.Fatal(err)
		}
		var out []string
		for _, c := range cs {
			out = append(out, c.Name)
		}
		return out
	}
	if got := names("alex dumsky"); len(got) != 1 || fold(got[0]) != "alex dumsky" {
		t.Fatalf("plain match through a direction mark: %v", got)
	}
	if got := names("אלכס דומסקי"); len(got) != 1 || fold(got[0]) != "alex dumsky" {
		t.Fatalf("the Hebrew spelling must find the Latin name: %v", got)
	}
	// a plain match is never mixed with guesses: "אלכס" is plain in "אלכס כהן" only, though "Alex ..." would match by skeleton
	if got := names("אלכס"); len(got) != 1 || got[0] != "אלכס כהן" {
		t.Fatalf("plain beats fuzzy: %v", got)
	}
	// when nothing is plain, several skeleton matches come back so the caller can ask which
	if got := names("אלכסנדרה"); len(got) != 1 || got[0] != "Alexandra Peretz" {
		t.Fatalf("alexandra: %v", got)
	}
	if got := names("דרמון"); len(got) != 1 || got[0] != "David Darmon" {
		t.Fatalf("darmon: %v", got)
	}
	if got := names("רביד"); len(got) != 1 {
		t.Fatalf("a group name with a Hebrew word: %v", got)
	}
	if got := names("%"); len(got) != 0 {
		t.Fatalf("a literal %% finds nothing: %v", got)
	}
	if got := names("zzzz"); len(got) != 0 {
		t.Fatalf("no match: %v", got)
	}
	if cs, _ := m.msgs.Chats(ctx, "u", "", nil, 3); len(cs) != 3 {
		t.Fatalf("no query: the most recent chats, got %d", len(cs))
	}
}
