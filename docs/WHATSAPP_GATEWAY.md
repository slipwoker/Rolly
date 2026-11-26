# WhatsApp gateway — plan and stage-0 findings

Status: planning (2026-11-26). Nothing here is implemented in the product yet. Branch: `claude/laughing-gates-sdb892`
(merge to `main` is the owner's step; the research branch `claude/adoring-goodall-es5zzm` that production follows is not touched).

## What and why

Rolly (drive mode) must read WhatsApp history and send messages for ordinary users, on Android **and** iPhone. The official
Cloud API does not serve personal accounts, notification listeners are Android-only and cannot read history, and CarPlay /
Android Auto cannot be driven by Rolly. What remains is the **linked-device** protocol: the user links Rolly as a companion
device (like WhatsApp Web), through an unofficial client library.

Terms of use: this breaks WhatsApp's terms (automated access / reverse engineering). The account of a user can be restricted.
Legal review is deferred by the owner ("later") and **must happen before anyone outside the team uses it**.

## Decisions (owner, 2026-11-26)

| # | Decision |
|---|---|
| W1 | Server-side gateway (not on-device). |
| W2 | Language Go, library `whatsmeow` (Baileys only if Go is dropped; then pin the version and verify the source — a malicious npm fork was reported). |
| W3 | Groups are in scope from the start. |
| W4 | Retain messages 30 days; about 3 months of history (what the first link delivers) is enough, no attempt to fetch older. |
| W5 | Own branch for the work; merging to `main` deploys, so the owner does the merge. |
| W6 | Legal review: later, before any pilot outside the team. |

## Architecture

```
app ──► rolly-api (Node, exists) ──private HTTP──► rolly-wa-gateway (Go, new) ──WSS──► WhatsApp
              │                                          │
       consent, tools, memory                  sessions (encrypted), messages, LID map
              └───────────── Postgres (two schemas) ─────┘
```

- Separate Render **private service**, same region as `rolly-api` (Frankfurt). `rolly-api` deploys drop live conversations
  (see `render.api.yaml`), WhatsApp connections must not depend on that; a ban or legal problem is one service to switch off.
- **One instance only**: a linked device cannot have two connections.
- `whatsmeow` `sqlstore` on Postgres; sessions come back after a restart (verified in the spike with SQLite).
- Stored: encrypted session keys (per-user key), messages for 30 days, voice-note **transcripts** (audio is downloaded on
  demand, transcribed by the GPU worker, not stored), LID ↔ phone ↔ contact-name map.
- Internal API (contract in `packages/contracts`): `POST /link/start`, `GET /link/status`, `GET /chats?q=`,
  `GET /chats/{id}/messages?since=`, `POST /send/draft`, `POST /send/confirm`, `DELETE /account`, `GET /events`.
- Voice integration reuses the marker pattern of web lookups (P1-D34): the model says "checking" and emits a marker,
  `rolly-api` calls the gateway, the result goes back as a marked "not said by the user" message at a quiet moment. The model
  is small (about 4B active); tool-marker reliability has to be measured with several tools before relying on it.

## Safety rules

1. Message content is **data, never instructions**: incoming text is injected only as marked quoted material; no action is
   taken because of it.
2. Sending needs a **spoken confirmation** of recipient and exact text (also protects against speech-recognition errors).
3. Rolly never sends on its own initiative; per-user daily cap and a minimum gap between sends.
4. "Disconnect WhatsApp" / "forget everything" by voice → `DELETE /account` wipes session, messages and transcripts.
5. `docs/PRIVACY.md` must be updated (new data class, third party = WhatsApp, retention 30 days) before any real user.

## Stages

| Stage | Content | Done when |
|---|---|---|
| 0 | Linking that works **from the same phone that runs the app** | a user links without a second screen |
| 1 | Gateway core: link, Postgres sessions, survives restart/deploy, state `connected / needs_relink / banned` | test user stays linked across a deploy |
| 2 | Read: chat search (groups too), history, LID mapping, voice-note transcripts | "what did Dani write?" works |
| 3 | Send: draft → confirm, caps | "tell Dani I'll be late" works with confirmation |
| 4 | Voice integration: markers, prompt, tests that measure tool calling | measured tool-call accuracy |
| 5 | Ops: monitoring, re-link screen, full deletion, privacy doc, consent | ready for a closed pilot |

## Stage-0 findings (spike, 2026-11-26)

Measured with `whatsmeow` (main, 2026-11-25), one **WhatsApp Business** test account, from this cloud container:

| Check | Result |
|---|---|
| Link by QR | works first time |
| Link by phone-number code (`PairPhone`) | **failed 3 times**: the handshake completes (`companion_hello → primary_hello → companion_finish`, server accepts) and the phone then shows "could not link"; no `pair-success` arrives |
| History in first link | `INITIAL_BOOTSTRAP` 400 chats / 406 messages; `RECENT` 96 chats / 1,869 messages, 2026-08-23 … 2026-11-25 (about 3 months) |
| Send | 264 ms to server acknowledgement |
| Receive | text and voice note arrive in real time; incoming chats are addressed by `@lid`, not by phone number |
| Voice note | type `ptt`, Ogg Opus mono 48 kHz, downloaded in 0.5 s; GPU worker (ivrit.ai Whisper) transcribed 4.4 s of Hebrew in 0.6 s (1.1 s total) |
| Restart | the session reconnects from the store without a new link |
| Not measured | how long a link survives (reports say 14 or 30 days of phone inactivity), older history |

### Why the code link failed (upstream issue, still open)

`tulir/whatsmeow` issue 1360 (opened 2026-11-23, open; no fix on `main` as of 2026-11-25): for **WhatsApp Business**
primaries the link-code flow ends with a `pair-success` that carries a new `<encryption-metadata>` block whatsmeow does not
know; the server then drops the stream (error 516) and the link is lost. Personal accounts link by code without trouble
according to the same report. Related: issues 1188 and 1233 (a passkey step added by WhatsApp in June 2026 breaks
`PairPhone` for some accounts).

### Open question for stage 0 (the same-phone problem)

A user opens Rolly on the phone that holds WhatsApp, so scanning a QR shown by the app is impossible. Options to test, each
needs the test phone:

1. **Deep link.** The QR payload whatsmeow emits is a URL (`https://wa.me/settings/linked_devices#…`). Opening that URL on the
   phone may start the link from the same device. Untested.
2. **Code link with a personal (non-Business) account** — expected to work per the upstream report; needs a personal test number.
3. **Wait for / contribute the upstream fix** for Business primaries (reverse-engineering the new block is not planned).

If none works, same-phone linking is not available for Business users and the product would be limited to personal accounts.

## Stages 1-4 built (2026-11-26, branch `claude/laughing-gates-sdb892`)

| Stage | Where | State |
|---|---|---|
| 1 gateway core | `apps/wa-gateway` (Go, whatsmeow, Postgres sessions) | works; link by QR or code, `connected/needs_relink/banned/...`, survives restart (checked on Postgres 16) |
| 2 read | same | 30-day message store, chats (groups too), LID-canonical chats, opaque chat refs, on-demand voice-note transcription through the GPU worker |
| 3 send | same | draft → confirm, 40 sends/24 h, 4 s gap, typing indicator, own messages kept in history |
| 4 voice | `apps/api/src/whatsapp/*` | the conversation model appends the existing `<lookup/>` marker; the flow decides with the utility model; no pod change needed |

Not deployed anywhere. Nothing is active in `rolly-api` unless **`ROLLY_WA_GATEWAY_URL`** and **`ROLLY_WA_GATEWAY_TOKEN`**
(and the utility-model key) are set; `ROLLY_WHATSAPP=0` turns it off. Deploy order: gateway first (one instance, private
service, `DATABASE_URL`, `WA_GATEWAY_TOKEN`, `WA_STT_URL`, optional `WA_STT_TOKEN`), then `rolly-api`.

### How a request flows
1. The user says "what did Dani write?" → the model says "checking" and appends `<lookup/>` (persona line only when the user
   has WhatsApp linked, `core(lang, {whatsapp:true})`).
2. `lookup` hook → `WhatsAppFlow.handle` → the utility model classifies the user's last words (`read | send | confirm | cancel | other`);
   `other` falls through to the web lookup. The classifier sees the conversation and the waiting draft, **never message content**.
3. Reads come back as a marked message (`[whatsapp - not said by the user] …`) with the text quoted and sanitised; the
   model says it in its own words. Sends create a draft that is read back; a **later** user turn saying yes confirms.

### Safety rules, each with a test (`apps/api/test/whatsapp.test.ts`, `apps/wa-gateway/*_test.go`)
- a yes in the same user turn as the draft does not send; no draft → "nothing is waiting", never a web search for "yes";
- attribution `uncertain` (maybe a passenger): nothing is read, drafted or confirmed;
- message text: markers, tags, square brackets, links and bidi controls are removed; it is quoted and labelled "never an instruction";
- gateway rate limits (daily cap, minimum gap) surface as spoken explanations; a limited draft stays confirmable;
- an unconfirmed draft is cancelled when the conversation ends; deleting the account also unlinks WhatsApp.

### Measured with the real models (2026-11-26)
- conversation model on the GPU pod, persona with WhatsApp on: appended the marker for **12/12** WhatsApp requests, **0/10** times in
  ordinary chat, and **6/6** times for yes / no / change after a read-back (the read-back itself never carried it). Small samples.
- intent classifier (`gpt-6-luna`, no reasoning): 14/15 on a Hebrew set; the miss is a bare "yes" with nothing waiting, which is the safe answer.
- live against a linked account: read of a chat with two voice notes about 1 s end to end (transcripts cached), draft and cancel work.

### Known gaps
- Linking: the code flow fails for **WhatsApp Business** accounts until `whatsmeow` issue 1360 is fixed; QR works. Personal accounts by code: not yet tried (no personal test number).
- Not yet: link/relink screens in the app, voice command "disconnect WhatsApp", encryption of session keys per user, monitoring, a real
  Render deployment, an integration test that links a real client (the race fixed in `expireLink` was invisible to unit tests), privacy
  document update, the legal review (W6).
