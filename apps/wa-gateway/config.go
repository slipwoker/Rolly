package main

import (
	"fmt"
	"os"
	"strconv"
	"strings"
)

// Config comes from the environment only. No secret has a default.
type Config struct {
	Addr          string // listen address, default :8080
	DatabaseURL   string // postgres://... (production) or file:gateway.db?_foreign_keys=on (local, SQLite)
	Token         string // bearer token rolly-api presents (WA_GATEWAY_TOKEN)
	MaxAccounts   int    // refuse to link more users than this (WA_MAX_ACCOUNTS, default 50)
	LinkTimeout   int    // seconds an unfinished link attempt lives (default 170, the QR channel lasts about 160)
	RetentionDays int    // how long a stored message lives (WA_RETENTION_DAYS, default 30)
	STTURL        string // speech-to-text endpoint for voice notes (WA_STT_URL); empty = voice notes are not transcribed
	STTToken      string // bearer token for it (WA_STT_TOKEN)
	STTLanguage   string // WA_STT_LANGUAGE, default he
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
	}
	if c.DatabaseURL == "" {
		return c, fmt.Errorf("DATABASE_URL is required")
	}
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
