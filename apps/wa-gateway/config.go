package main

import (
	"fmt"
	"os"
	"strconv"
	"strings"
)

// Config comes from the environment only. No secret has a default.
type Config struct {
	Addr           string  // listen address, default :8080
	DatabaseURL    string  // postgres://... (production) or file:gateway.db?_foreign_keys=on (local, SQLite)
	Token          string  // bearer token rolly-api presents (WA_GATEWAY_TOKEN)
	MaxAccounts    int     // refuse to link more users than this (WA_MAX_ACCOUNTS, default 50)
	LinkTimeout    int     // seconds an unfinished link attempt lives (default 170, the QR channel lasts about 160)
	RetentionDays  int     // how long a stored message lives (WA_RETENTION_DAYS, default 30)
	STTURL         string  // speech-to-text endpoint for voice notes (WA_STT_URL); empty = voice notes are not transcribed
	STTToken       string  // bearer token for it (WA_STT_TOKEN)
	STTLanguage    string  // WA_STT_LANGUAGE, default he
	DataKey        string  // WA_DATA_KEY: 32 random bytes, base64: seals message content in the database
	AllowPlaintext bool    // WA_ALLOW_PLAINTEXT=1: local development only
	Sealer         *Sealer // built from the two above by LoadConfig
	SendPerDay     int     // most messages one user may send in 24 h (WA_SEND_PER_DAY, default 40)
	SendMinGapS    int     // minimum seconds between two sends of one user (WA_SEND_MIN_GAP_S, default 4)
	DraftTTLS      int     // seconds a draft stays confirmable (WA_DRAFT_TTL_S, default 120)
	MaxSendChars   int     // longest message Rolly may send (WA_MAX_SEND_CHARS, default 1000)
}

func LoadConfig() (Config, error) {
	c := Config{
		Addr:          envOr("WA_ADDR", ":8080"),
		DatabaseURL:   os.Getenv("DATABASE_URL"),
		Token:         os.Getenv("WA_GATEWAY_TOKEN"),
		MaxAccounts:   envInt("WA_MAX_ACCOUNTS", 50),
		LinkTimeout:   envInt("WA_LINK_TIMEOUT_S", 170),
		RetentionDays: envInt("WA_RETENTION_DAYS", 30),
		STTURL:        os.Getenv("WA_STT_URL"),
		STTToken:      os.Getenv("WA_STT_TOKEN"),
		STTLanguage:   envOr("WA_STT_LANGUAGE", "he"),
		SendPerDay:    envInt("WA_SEND_PER_DAY", 40),
		SendMinGapS:   envInt("WA_SEND_MIN_GAP_S", 4),
		DraftTTLS:     envInt("WA_DRAFT_TTL_S", 120),
		MaxSendChars:  envInt("WA_MAX_SEND_CHARS", 1000),
	}
	if c.DatabaseURL == "" {
		return c, fmt.Errorf("DATABASE_URL is required")
	}
	c.DataKey = os.Getenv("WA_DATA_KEY")
	c.AllowPlaintext = os.Getenv("WA_ALLOW_PLAINTEXT") == "1"
	s, err := NewSealer(c.DataKey, c.AllowPlaintext)
	if err != nil {
		return c, err
	}
	c.Sealer = s
	if len(c.Token) < 24 {
		return c, fmt.Errorf("WA_GATEWAY_TOKEN is required and must be at least 24 characters")
	}
	return c, nil
}

// dialect returns the database/sql driver name for DatabaseURL.
func (c Config) dialect() string {
	if strings.HasPrefix(c.DatabaseURL, "postgres://") || strings.HasPrefix(c.DatabaseURL, "postgresql://") {
		return "pgx"
	}
	return "sqlite3"
}

func envOr(k, d string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return d
}

func envInt(k string, d int) int {
	if v, err := strconv.Atoi(os.Getenv(k)); err == nil && v > 0 {
		return v
	}
	return d
}

// accessors fall back to the defaults when a Config is built by hand (tests)
func (c Config) sendPerDay() int {
	if c.SendPerDay > 0 {
		return c.SendPerDay
	}
	return 40
}
func (c Config) sendMinGap() int {
	if c.SendMinGapS > 0 {
		return c.SendMinGapS
	}
	return 4
}
func (c Config) draftTTL() int {
	if c.DraftTTLS > 0 {
		return c.DraftTTLS
	}
	return 120
}
func (c Config) maxSendChars() int {
	if c.MaxSendChars > 0 {
		return c.MaxSendChars
	}
	return 1000
}
