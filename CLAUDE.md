# CLAUDE.md

Guidance for Claude Code (and other coding agents) working in this repository.

## What This Is

**Voice Agent**, an Obsidian desktop plugin you talk to. It uses a coding-agent CLI on the
user's computer (Claude Code by default, Codex or Antigravity) as its brain, listens and
listens with local Whisper and speaks with the OS's own voice (or ElevenLabs / Sarvam /
Soniox), and adds accountability features:
editable personality files, morning/midday/evening check-ins, adaptive nudges, focus tracking
on the kanban Doing column, and a 48h triage nudge for quick-capture notes. Everything runs
inside Obsidian; there is no server.

Agent state and the local voice runtime live in `~/.obsidian-voice-agent/`, outside the
vault, so sync and git plugins never pick them up.

## Commands

```bash
pnpm install
pnpm test                 # vitest, all tests
pnpm test -- tests/agent.test.ts
pnpm lint                 # eslint with eslint-plugin-obsidianmd (the community review rules)
pnpm typecheck            # tsc --noEmit
pnpm build                # typecheck + production main.js
OBSIDIAN_PLUGIN_DIR=... pnpm dev   # watch, copy main.js/manifest/styles into a vault plugin folder
```

Release: bump `version` in `manifest.json`, `package.json` and `versions.json`, then push a
tag equal to the version (no "v"). `.github/workflows/release.yml` builds and attaches
`main.js`, `manifest.json` and `styles.css`.

## Architecture

- `src/plugin/` - Obsidian side. `main.ts` wires everything; `settings.ts` (settings + tab,
  API keys via `app.secretStorage`); `view.ts` (side panel); `transcript.ts` (panel model,
  implements `VoiceUi`).
- `src/agent/agent.ts` - the agent, UI-independent. One engine conversation, turns run one at
  a time (`exclusive`). Local commands (/pause, /clear, estimates, triage) short-circuit before
  the engine. Proactive messages (checkpoints, pulses, focus) go out through `deliver`.
- `src/engines/` - CLI adapters. Claude Code stays running between turns (stream-json on
  stdin, `--resume` after an interrupt); Codex and Antigravity run one process per turn and
  resume by id. Codex gets the system prompt as `developer_instructions` on the first turn;
  Antigravity gets it at the top of the first message. `shell-env.ts` fixes PATH for Obsidian
  launched from the Dock. Claude Code gets `--disallowedTools` rules that block the daily folder
  and direct edits to the board and agent folder.
- `src/brain/` - `prompt-builder.ts` (system prompt = personality + rules + actions protocol;
  per-turn [Context] block), `actions.ts` (the `<actions>[...]</actions>` protocol: parse,
  validate, stream filter), `signals.ts`, `priority.ts`.
- `src/agent/execute-actions.ts` - runs actions through the tested writers. Config edits are
  gated: propose stages (30 min TTL), apply writes, discard drops.
- `src/voice/` - `session.ts` (utterance -> STT -> agent -> sentence chunks -> TTS -> player,
  with interrupts), `vad.ts` (energy VAD), `mic.ts`, `player.ts`, `cloud.ts` (Sarvam, Soniox,
  ElevenLabs), `system.ts` (OS voice via speechSynthesis; the player speaks it in the same
  ordered, stoppable queue), `local/` (Whisper in a Web Worker; worker bundled separately and inlined as text;
  the ONNX WASM binary is downloaded once from jsDelivr and checked against a SHA-256 baked in
  at build time).
- `src/checkins/scheduler.ts` - daily checkpoints at local HH:MM, missed-checkpoint catch-up,
  adaptive pulse.
- `src/store/store.ts` - small JSON state, persisted by the plugin.
- `src/vault/`, `src/journal/`, `src/config/` - board parser/writer, people/literature notes,
  personality loader/editor, vault layout (`paths.ts`, all folders configurable).
- `src/utils/json.ts` - helpers for reading untrusted JSON without `any`.

### Rules

- The agent NEVER reads or writes the daily notes folder. Search skips it, the prompt forbids
  it, and Claude Code permission rules block it.
- Edits to soul.md, identity.md, user.md, goals.md need the user's yes. memory.md is ungated.
- `editor.ts` is the only write path for the personality files.
- Use `window.setTimeout` / `window.setInterval` (popout-safe); tests alias `window` to the
  global object in `tests/setup.ts`.
- HTTP goes through the injected `Http` function (Obsidian's `requestUrl` in the plugin, a
  fake in tests), never `fetch`.
- No telemetry, no self-updating code. Any new network call must be added to the README's
  "Network use" section.

## Testing

Tests in `tests/` (vitest, globals). No live services: engines are faked
(`tests/fixtures/fake-claude.mjs`, `FakeEngine` in `agent.test.ts`), HTTP is injected.
Real-engine end-to-end checks are manual.

## Conventions

- Read the relevant files before editing. Test after writing; never leave failures.
- Simplest working solution. Prefer editing over rewriting whole files.
- ASCII only in code and docs (no em dashes or smart quotes).
