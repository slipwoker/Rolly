package main

import (
	"strings"
	"unicode"
)

// Finding a chat by a name spoken in Hebrew when the contact is saved in English ("אלכס דומסקי" for "Alex Dumsky"): the speech
// recogniser writes Hebrew letters, the phone's address book often has Latin ones. Both are reduced to a coarse CONSONANT
// SKELETON, which is the same for both spellings. It is a heuristic, not a transliteration: it can match too much, so the
// caller treats several matches as "ask which one" and nothing is ever sent on a skeleton match alone (the user hears the
// chat's name read back before any send).

// fold makes a name comparable: lower case, no invisible direction marks, no punctuation, single spaces.
func fold(s string) string {
	var b strings.Builder
	space := false
	for _, r := range s {
		switch {
		case r == 0x200e || r == 0x200f || (r >= 0x202a && r <= 0x202e) || (r >= 0x2066 && r <= 0x2069) || r == 0x200b || r == 0xfeff:
			continue // direction marks and zero-width characters that WhatsApp names often carry
		case unicode.IsLetter(r) || unicode.IsDigit(r):
			b.WriteRune(unicode.ToLower(r))
			space = false
		case unicode.IsSpace(r) || r == '-' || r == '_' || r == '.' || r == '\'' || r == '"' || r == '׳' || r == '״':
			if !space && b.Len() > 0 {
				b.WriteByte(' ')
				space = true
			}
		}
	}
	return strings.TrimSpace(b.String())
}

var hebrewClass = map[rune]rune{
	'ג': 'g', 'ד': 'd', 'ז': 's', 'ט': 't', 'ת': 't', 'כ': 'k', 'ך': 'k', 'ק': 'k', 'ל': 'l', 'מ': 'm', 'ם': 'm', 'נ': 'n', 'ן': 'n',
	'ס': 's', 'פ': 'p', 'ף': 'p', 'צ': 's', 'ץ': 's', 'ר': 'r', 'ש': 's',
	// א ע ה ו י ח ב are vowels or soft letters that Latin spellings drop or move (ו/ב: David, Ravid): left out on purpose
}

var latinClass = map[rune]rune{
	'g': 'g', 'j': 'g', 'd': 'd', 'z': 's', 's': 's', 't': 't', 'k': 'k', 'c': 'k', 'q': 'k', 'l': 'l', 'm': 'm', 'n': 'n', 'p': 'p', 'f': 'p', 'r': 'r',
	// a e i o u y h w v b are left out, for the same reason
}

// skeleton returns the consonant classes of a name in either script, without spaces. A letter that is doubled right next to
// itself counts once ("Dumsky" / "Dummsky"); the same consonant on both sides of a vowel counts twice ("Nina" is not "Noa").
func skeleton(s string) string {
	var out []rune
	var last rune // the class of the previous letter, 0 after a vowel or a letter that is left out
	add := func(c rune) {
		if c != last {
			out = append(out, c)
		}
		last = c
	}
	for _, r := range fold(s) {
		if c, ok := hebrewClass[r]; ok {
			add(c)
		} else if c, ok := latinClass[r]; ok {
			add(c)
		} else if r == 'x' {
			out = append(out, 'k', 's')
			last = 's'
		} else {
			last = 0
		}
	}
	return string(out)
}

// nameMatches: tier 1 = the plain text is inside the name (after fold); tier 2 = the skeletons match across scripts.
// A skeleton of fewer than three letters matches only a whole name (a one-letter skeleton would match half the address book).
func nameMatches(name, query string) (tier int) {
	fn, fq := fold(name), fold(query)
	if fq == "" {
		return 0
	}
	if strings.Contains(fn, fq) {
		return 1
	}
	sn, sq := skeleton(name), skeleton(query)
	switch {
	case sq == "" || sn == "":
		return 0
	case len(sq) >= 3 && strings.Contains(sn, sq):
		return 2
	case sq == sn:
		return 2
	}
	return 0
}
