# PII Protection System

Anonymization and PII detection for groups handling sensitive personal information (e.g. adoption, medical, childcare).

**Opt-in per group.** Only groups with an anonymize config at `~/.config/nanoclaw/anonymize/{groupFolder}.json` get PII protection. Groups without a config file have no anonymization.

## How It Works

### Three-Layer Defense

1. **Static anonymization** (`src/anonymize.ts`) — Word-boundary regex replacement of known names/values with pseudonyms. Fast, deterministic, runs on every message.

2. **Ollama PII scan** (`src/pii-check.ts`) — Local LLM (qwen2.5:7b) scans the anonymized text for any PII the static mappings missed. Supplemented by regex patterns for NHS numbers, postcodes, phone numbers, emails, and case reference numbers. Fail-closed: if Ollama is down, the message is blocked.

3. **Document/image quarantine** (`src/media-pii.ts`) — Raw files are moved out of the container-accessible directory after text extraction. The container never sees the original file.

### Config File Format

```json
{
  "enabled": true,
  "piiCheck": true,
  "piiModel": "qwen2.5:7b",
  "mediaPiiCheck": true,
  "piiVisionModel": "llava:7b",
  "mappings": {
    "Real Name": "Pseudonym",
    "Another Name": "Another Pseudonym"
  }
}
```

| Field | Purpose | Default |
|-------|---------|---------|
| `enabled` | Master switch for anonymization | Required |
| `piiCheck` | Enable Ollama text PII scanning | `false` |
| `piiModel` | Ollama model for text PII detection | `qwen2.5:7b` |
| `mediaPiiCheck` | Enable image/document PII checking | Defaults to `piiCheck` |
| `piiVisionModel` | Ollama vision model for image text extraction | `llava:7b` |
| `mappings` | Real value → pseudonym dictionary | Required |

## Message Flow

```
WhatsApp message received
  │
  ▼
Database stores raw content (host-only, not container-accessible)
  │
  ▼
formatMessages() — builds XML prompt with sender names
  │
  ▼
substituteDocContent() — extracts text from PDFs/Word docs,
  inlines it, quarantines raw files to data/quarantine/
  │
  ▼
anonymize() — replaces known names/values with pseudonyms
  │
  ▼
checkForPii() — Ollama scans for unknown PII + regex supplement
  │
  ├─ PII found → HOLD message, alert user
  │    └─ User approves/maps → re-anonymize with new mappings → continue
  │    └─ User skips → continue without new mappings
  │    └─ 5 min timeout → DROP message (not sent)
  │
  ├─ Ollama error → BLOCK message (fail-closed)
  │
  └─ Clean → send to container agent
```

## Media Handling

### Documents (PDF, Word, plain text)

| Step | What happens |
|------|-------------|
| Receipt | File saved with sanitized filename (`doc-{timestamp}-{random}.ext`). Original filename (which may contain PII) is discarded. |
| Text extraction | `pdf-parse` for PDFs, `mammoth` for .docx, direct read for .txt. All local — no cloud. |
| Substitution | `[DOC: ...]` reference in prompt replaced with extracted text. |
| Quarantine | Raw file moved from `groups/{name}/attachments/` to `data/quarantine/{name}/`. Container cannot access quarantine (data/ is shadowed). |
| Failure | If extraction fails, reference is stripped ("content withheld"). File still quarantined. Fail-closed. |

### Images

| Outcome | What happens |
|---------|-------------|
| **Has readable text** | Text extracted via llava:7b (local Ollama). Text anonymized and inlined into prompt. Raw image quarantined. Image **never sent to Claude**. |
| **No readable text** | User prompted for confirmation. If approved, sent as base64 content block. If skipped, stripped. |
| **Vision model failure** | Image quarantined and stripped. Fail-closed. |

### Voice Messages

| Group type | Provider | Audio sent to cloud? |
|------------|----------|---------------------|
| PII-enabled (`piiCheck` or `mediaPiiCheck` true) | Local whisper-cpp | **No** — runs on-device |
| Not PII-enabled | Groq Whisper API | Yes |

If local whisper fails for a PII-enabled group, it does **NOT** fall back to the cloud provider. Returns a fallback placeholder instead.

## Streaming Path

When a container is already active and a new message arrives (the "streaming" or "piping" path):

- **PII-enabled groups**: Message is redirected to the batch path for full Ollama PII scanning. No messages bypass the PII check.
- **Non-PII groups**: Static anonymization + document substitution only.

## Container Filesystem Isolation

The container agent has access to `/workspace/group/` (the group folder). After PII processing:

| Content | Location | Container access |
|---------|----------|-----------------|
| Quarantined documents | `data/quarantine/{group}/` | **No** — `data/` shadowed with empty dir |
| Quarantined images (had text) | `data/quarantine/{group}/` | **No** |
| Approved images (no text) | `groups/{group}/attachments/` | **Yes** — user explicitly approved |
| Database (raw PII) | `store/messages.db` | **No** — not mounted |
| Anonymize config | `~/.config/nanoclaw/anonymize/` | **No** — never mounted |
| `.env` secrets | Project root `.env` | **No** — shadowed with `/dev/null` |

## Hold/Approve Flow

When PII is detected, the message is held in `pendingAnon` and the user receives an alert:

```
PII detected in pending message:
  - "Dr Patel" (name, in report.pdf) — suggest mapping to "Azure"
  - "NHS: 7366077186" (other) — suggest mapping to "Jade"

Note: Image content cannot be anonymized. Approving will send
the image to the agent with PII visible.

Reply:
  "approve" — add suggested mappings and send
  "skip" — send without new mappings
  "map X > Y" — use custom pseudonym
```

After approval, new mappings are added to the config file. The cached prompt (which includes document and image extracted text) is re-anonymized with the updated mappings before sending to the agent.

**Timeout**: If the user doesn't respond within 5 minutes, the message is **dropped** (not silently approved). The user is notified and must resend.

## Regex PII Supplement

The Ollama LLM may miss structured patterns. These regexes run after the LLM scan and catch:

| Pattern | What it matches |
|---------|----------------|
| `[1-9]\d{2}\s?\d{3}\s?\d{4}` | NHS numbers (10 digits, non-zero start) |
| `[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}` | UK postcodes |
| `0\d{2,4}\s?\d{3,4}\s?\d{3,4}` | UK phone numbers |
| `[\w.+-]+@[\w-]+\.[\w.-]+` | Email addresses |
| `Ref[:\s#]+\d{4,}` | Case reference numbers |

## Key Files

| File | Purpose |
|------|---------|
| `src/anonymize.ts` | Static anonymize/deanonymize, config loading |
| `src/pii-check.ts` | Ollama PII scan, regex supplement, pseudonym generation |
| `src/media-pii.ts` | Document extraction, image PII, quarantine, substituteDocContent |
| `src/index.ts` | Orchestration: batch path PII flow, streaming redirect, hold/approve |
| `src/transcription.ts` | Voice transcription: local whisper for PII groups, Groq for others |
| `src/container-runner.ts` | Container mounts, data/ shadow, filesystem isolation |
| `src/channels/whatsapp.ts` | Document download, filename sanitization |
| `src/router.ts` | Message formatting (no legacy image= attributes) |
| `src/anon-commands.ts` | User commands: anon list, anon add, anon remove |

## Testing

```bash
# Unit tests (394 tests, mocked Ollama)
npm test

# Integration tests against live Ollama (32 tests)
npx tsx scripts/test-pii-exhaustive.ts

# Media-specific tests (44 tests)
npx tsx scripts/test-media-pii.ts

# Exploit/penetration tests (52 tests)
npx tsx scripts/test-pii-final.ts
```

## Audit Agents

Reusable security audit agents live in `.claude/agents/`:

- `pii-security-reviewer.md` — Threat models every code path
- `pii-data-flow-tracer.md` — Traces PII through every system stage
- `pii-exploit-tester.md` — Writes and runs exploit tests in isolated worktrees

Launch all three in parallel for a comprehensive audit:
```
Launch agents: pii-security-reviewer, pii-data-flow-tracer, pii-exploit-tester
```

## Known Limitations

| Limitation | Mitigation |
|------------|-----------|
| `sender_name` in prompt XML may not be mapped if user is new | Ollama PII check scans the full prompt including XML attributes |
| Raw PII stored in SQLite at rest | Database is host-only, never mounted into containers |
| Dates/street addresses have no regex pattern | Ollama LLM is instructed to detect these; regex covers postcodes |
| Approved no-text images persist in attachments/ | User explicitly consented after vision model confirmed no readable text |
| llava:7b is non-deterministic | Text extraction may vary between runs; the PII check on extracted text is the safety net |
