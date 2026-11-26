package main

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"strings"
)

// Sealer encrypts message content (text, transcripts, the voice-note media pointer) before it is written to the database,
// with a key derived per user from one master key (WA_DATA_KEY). A database dump or backup alone does not reveal what
// people wrote; deleting a user's rows removes the rest. Chat NAMES stay readable on purpose: they are searched.
// What this does not cover: WhatsApp's own session keys in the whatsmeow_* tables (owned by the library) and anyone who
// holds both the database and the master key.
type Sealer struct {
	master []byte
	plain  bool // tests and local development only (WA_ALLOW_PLAINTEXT=1)
}

const sealedPrefix = "v1:"

func NewSealer(masterB64 string, allowPlain bool) (*Sealer, error) {
	if masterB64 == "" {
		if allowPlain {
			return &Sealer{plain: true}, nil
		}
		return nil, errors.New("WA_DATA_KEY is required (32 random bytes, base64); WA_ALLOW_PLAINTEXT=1 only for local development")
	}
	k, err := base64.StdEncoding.DecodeString(masterB64)
	if err != nil || len(k) != 32 {
		return nil, errors.New("WA_DATA_KEY must be 32 bytes, base64 encoded")
	}
	return &Sealer{master: k}, nil
}

func (s *Sealer) aead(userID string) (cipher.AEAD, error) {
	mac := hmac.New(sha256.New, s.master)
	mac.Write([]byte("wa-gateway/content/v1|" + userID))
	block, err := aes.NewCipher(mac.Sum(nil))
	if err != nil {
		return nil, err
	}
	return cipher.NewGCM(block)
}

// SealBytes returns nonce||ciphertext, bound to the user (a row copied to another user does not open).
func (s *Sealer) SealBytes(userID string, p []byte) ([]byte, error) {
	if s == nil || s.plain || p == nil {
		return p, nil
	}
	g, err := s.aead(userID)
	if err != nil {
		return nil, err
	}
	nonce := make([]byte, g.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return nil, err
	}
	return g.Seal(nonce, nonce, p, []byte(userID)), nil
}

func (s *Sealer) OpenBytes(userID string, c []byte) ([]byte, error) {
	if s == nil || s.plain || len(c) == 0 {
		return c, nil
	}
	g, err := s.aead(userID)
	if err != nil {
		return nil, err
	}
	if len(c) < g.NonceSize() {
		return nil, errors.New("sealed value too short")
	}
	return g.Open(nil, c[:g.NonceSize()], c[g.NonceSize():], []byte(userID))
}

// SealString is for TEXT columns: "v1:" + base64. The empty string stays empty.
func (s *Sealer) SealString(userID, p string) (string, error) {
	if s == nil || s.plain || p == "" {
		return p, nil
	}
	b, err := s.SealBytes(userID, []byte(p))
	if err != nil {
		return "", err
	}
	return sealedPrefix + base64.StdEncoding.EncodeToString(b), nil
}

func (s *Sealer) OpenString(userID, c string) (string, error) {
	if s == nil || s.plain || c == "" {
		return c, nil
	}
	if !strings.HasPrefix(c, sealedPrefix) {
		return "", fmt.Errorf("value is not sealed")
	}
	raw, err := base64.StdEncoding.DecodeString(c[len(sealedPrefix):])
	if err != nil {
		return "", err
	}
	b, err := s.OpenBytes(userID, raw)
	return string(b), err
}
