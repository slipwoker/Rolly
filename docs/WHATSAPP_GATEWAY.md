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

### Stage 5 (ops), built 2026-11-26
- Message content is sealed in the database (AES-256-GCM, per-user key from `WA_DATA_KEY`; the gateway refuses to start without it unless `WA_ALLOW_PLAINTEXT=1`).
- Linking needs `consent: true` (the app must show the terms); the time is stored. `GET /v1/stats` (gateway) and `GET /v1/admin/whatsapp` (rolly-api, admin token): counts by state, live connections, stored messages, sends; no user data.
- "Disconnect WhatsApp" by voice: asked first, a later yes unlinks and deletes everything (marker 4/4, intent 4/4 on the real models).
- Regression tests for the link-timer race (a paired client is never dropped; state is set before the timer is cancelled).
- `apps/wa-gateway/Dockerfile` and `render.wa-gateway.yaml` (private service, ONE instance, own database; deploys follow `main` only for changes under `apps/wa-gateway`). **Not applied**:
  the Docker image could not be built here (no Docker daemon); the Go build with the same flags works. Creating the services costs money and touches
  the shared Render workspace, so it waits for the owner. `PRIVACY.md` has the new WhatsApp section.

### Known gaps
- Linking: the code flow fails for **WhatsApp Business** accounts until `whatsmeow` issue 1360 is fixed; QR works. Personal accounts by code: not yet tried (no personal test number).
- Not yet: voice command "disconnect WhatsApp", encryption of session keys per user, monitoring, a real
  Render deployment, an integration test that links a real client (the race fixed in `expireLink` was invisible to unit tests), privacy
  document update, the legal review (W6).

### App screens (2026-11-26, `apps/mobile/app/whatsapp.tsx`, `src/whatsapp.ts`)
Terms with an explicit "I understand" step (the API refuses to link without `consent: true`) → the user's number → the pairing **code** to type in WhatsApp
(polled every 3 s until connected, countdown, new code when it expires) → status, relink and disconnect. A WhatsApp row in "Connected services" of the
personalisation screen opens it and only shows when the server has WhatsApp. Pure logic (phone normalisation, code format, state meaning, error mapping) is
unit-tested; **the screens have not been run on a device or simulator and the link has not been tried end to end on a personal account** (planned: the owner's
personal number, live). The terms wording is a draft for the legal review (W6). Business accounts will fail at the code step until whatsmeow issue 1360 is fixed;
the screen says so when a code expires.

### Link from a computer (2026-11-26, `apps/api/src/whatsapp/webLink.ts`, `src/email/elastic.ts`)
Why: the pairing code of the phone-only flow fails on real accounts (personal iPhone and Business: the phone answers "Couldn't link device" after
the client's last step; no fix upstream as of 2026-11-26; unknown whether it is a new passkey step, the datacenter IP, or iOS), and a QR cannot be scanned from the same phone.
The QR works (also for Business), so the app asks `POST /v1/whatsapp/web-link {consent:true[, email, lang]}`: the answer is a one-time address to share, or the same address
is emailed. The page `/link/wa#<token>` (any computer) starts a QR link for the token's user and shows the live QR; the phone scans it; the page and the app say "connected".
- The token is in the URL **fragment**: it never reaches server logs or a Referer. It lives 10 minutes, replaces the user's previous one, and dies when the link succeeds.
- The page is self-contained: CSP with a per-load nonce, no external resources, no framing, `no-store`, `noindex`.
- Email: Elastic Email v4 transactional send (`ROLLY_EMAIL_API_KEY`, `ROLLY_EMAIL_FROM` = a sender verified in Elastic Email, set on `rolly-api`; unset = the app only offers sharing).
  **Not verified against the live API** from this environment (no key): check it with one real send. Limits: 3 emails/hour and 8/day per user, 10/hour per address of the caller.
  The address is used for that one message and is not stored or logged.
- Residual risk: whoever holds a live link can show the QR, and whoever scans it connects THEIR WhatsApp to this Rolly account. Hence the short life, and the consent before the link exists.
Tests: `apps/api/test/webLink.test.ts` (routes, tokens, limits, mail shape), `apps/mobile/test/whatsapp.test.ts`. The page was also run in Chromium against a fake gateway (QR, success, expired).

### Deploys of the gateway (2026-11-27)
The gateway first had `autoDeploy: false`; it now follows `main` through a `buildFilter` on `apps/wa-gateway/**` (the Blueprint needs one plan and approval on Render
to apply that). A deploy runs the old and the new instance together for a moment; the old one gets "replaced stream". Before PR #38 it wrote `conflict` and then
`reconnecting` over the new instance's `connected`; now it writes nothing. That fix was first exercised by a deploy whose OLD instance still had the old code, so
the first real proof is the NEXT deploy: check `GET /v1/admin/whatsapp` (admin) afterwards.

### Finding a contact by a name said in Hebrew (2026-11-27)
Found in live use: "Alex Dumsky" is saved in English; the Hebrew speech recogniser writes "אלכס דומסקי", and the search was a plain substring on the stored name, so it found nothing
(the agent then guessed "maybe it is saved under another name"). `apps/wa-gateway/translit.go`: names are compared (1) as plain text with case, direction marks (WhatsApp names carry them),
punctuation and spacing ignored, and (2) only if that finds nothing, by a **consonant skeleton** shared by Hebrew and Latin spellings (אלכס דומסקי = Alex Dumsky, דוד = David, רביד = Ravid).
It is a heuristic: a skeleton under three letters matches only a whole name, a plain match is never mixed with guesses, several matches make the agent ask which, and nothing is sent on a guess
(the chat's name is read back before every send). `GET /v1/stats` now has `unnamed_chats` (1:1 chats with no stored name, which no search can find) and a search that finds nothing is logged without the name.
**Not verified on the real address book**: whether "Alex Dumsky" is stored under that name on the gateway is unknown; if it is one of the unnamed chats, this does not help.

**Temporary diagnostics (2026-11-27).** To see how a contact is stored (the gateway's database is closed to outside connections by design), the owner can call
`POST /v1/admin/whatsapp/lookup {user_id, q?, phone?}` on `rolly-api` with the admin token. It asks the gateway's `GET /v1/users/{uid}/debug/lookup` and returns the stored name
and its UTF-8 bytes (hidden characters), whether it is a group, the kind of address the chat is keyed by (`lid`/`phone`/`group`), the number of messages, and the names WhatsApp
knows for the number; never message text, a phone number or a chat address. **Remove** `whatsapp/adminRoutes.ts`, its line in `app.ts`, `debugLookup` in `gateway.ts` and
`apps/wa-gateway/debug.go` once the question is answered.

**Names of chats that are not saved contacts (2026-11-27).** Found in live use: of 317 chats, 40 had no name; the newest, with 1,037 messages, was "Instinct", a WhatsApp Business account the owner has not saved.
WhatsApp's contact store had nothing for it (no saved name, no push name, no business name), but WhatsApp itself shows the business's **verified name**, which arrives on the message
(`Info.VerifiedName`, and `verifiedBizName` on a history-sync web message). `ingest.go` now names a one-to-one chat, in this order: a saved contact name (looked up on every message, so a contact saved later
replaces a fallback), the history-sync name, the verified business name, the person's own push name (only from the other side: our own push name is ours). Groups are never named after a sender.
Existing unnamed chats get their name with their **next message**; nothing is stored about a past message's sender, so there is no backfill. Names that are only masked numbers (`+972∙∙∙∙∙∙∙40`) are still not
real names. Tests: `fallbackname_test.go`.
