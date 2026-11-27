package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/textproto"
	"strings"
	"time"
)

// Transcriber sends a voice note to the speech-to-text endpoint (Rolly's GPU worker, OpenAI-compatible
// /v1/audio/transcriptions). Audio goes only to that endpoint, only when a user asks to hear a voice note, and is not kept.
type Transcriber struct {
	URL      string // full URL of the transcriptions endpoint; empty disables transcription
	Token    string
	Language string // "he" by default
	HTTP     *http.Client
}

func (t *Transcriber) Enabled() bool { return t != nil && t.URL != "" }

func (t *Transcriber) Transcribe(ctx context.Context, audio []byte) (string, error) {
	if !t.Enabled() {
		return "", fmt.Errorf("transcription is not configured")
	}
	var body bytes.Buffer
	w := multipart.NewWriter(&body)
	hdr := make(textproto.MIMEHeader)
	hdr.Set("Content-Disposition", `form-data; name="file"; filename="voice.ogg"`)
	hdr.Set("Content-Type", "audio/ogg")
	part, err := w.CreatePart(hdr)
	if err != nil {
		return "", err
	}
	if _, err := part.Write(audio); err != nil {
		return "", err
	}
	_ = w.WriteField("model", "whisper-1")
	_ = w.WriteField("response_format", "json")
	if t.Language != "" {
		_ = w.WriteField("language", t.Language)
	}
	if err := w.Close(); err != nil {
		return "", err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, t.URL, &body)
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", w.FormDataContentType())
	if t.Token != "" {
		req.Header.Set("Authorization", "Bearer "+t.Token)
	}
	client := t.HTTP
	if client == nil {
		client = &http.Client{Timeout: 30 * time.Second}
	}
	resp, err := client.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode >= 400 {
		return "", fmt.Errorf("stt http %d", resp.StatusCode) // never include the body: it may echo content
	}
	var out struct {
		Text string `json:"text"`
	}
	if err := json.Unmarshal(raw, &out); err != nil {
		return "", fmt.Errorf("stt: bad response")
	}
	return strings.TrimSpace(out.Text), nil
}
