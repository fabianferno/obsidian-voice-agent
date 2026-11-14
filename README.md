# Voice Agent for Obsidian

Talk to your vault. Voice Agent is an Obsidian plugin that turns the coding agent already on
your computer (Claude Code, Codex or Antigravity) into a spoken assistant for your notes. Ask
it what to work on, have it move cards on your kanban board, look things up in your notes, or
let it brief you in the morning and wind you down in the evening.

- **Any engine.** Claude Code (default), Codex or Antigravity. Switch in settings. The plugin
  uses your installed CLI and your existing sign-in; there is no extra AI account or API key.
- **Local voice by default.** Speech recognition runs Whisper on your computer, and the agent
  speaks with your operating system's own voice (the one macOS, Windows or Linux already
  ships): free, private, instant, no key. ElevenLabs, Sarvam and Soniox are optional cloud
  voices if you want a more natural voice or Indian languages.
- **An accountability partner, not just a chat box.** A personality you can edit, morning,
  midday and evening check-ins, gentle nudges in between, and focus tracking on your kanban
  "Doing" column.
- **A second brain that tends itself.** What you mention in conversation gets filed: a dated
  line in the person's or project's note, or a new note in your capture folder. Once a day the
  agent works through the capture folder: it tidies a ready note and moves it to your notes
  folder, or leaves one question inside the note for you to answer. Your own words are never
  rewritten (a rewrite that drops any of your lines is refused), facts come only from your
  vault, and every move keeps your links working.

Desktop only (macOS, Windows, Linux). Early release (0.2.0): expect rough edges, and please
[open an issue](https://github.com/fabianferno/obsidian-voice-agent/issues) when something
breaks.

## How it works

```
 mic -> voice detection -> speech recognition (local Whisper / Sarvam / Soniox)
                                      |
                                      v
   your words + live context (time, board, signals, focus)  -->  engine CLI in your vault
                                                                (claude / codex / agy)
                                      |
             reply text, streamed  <--+--> agent actions (move card, add task,
                     |                     update memory, propose config edit)
                     v                              |
  sentences -> speech (system voice / ElevenLabs / Sarvam / Soniox)   run by the plugin's validated writers
```

The engine runs with your vault as its working directory, so it can read, search and edit
notes with its own tools. Changes to the kanban board and the agent's own files go through
"agent actions": the engine ends its reply with a small JSON block, and the plugin applies it
with tested writers that keep the board format intact. Edits to the agent's personality files
are proposed first and only applied after you say yes.

The agent never reads or writes your daily notes folder. With Claude Code this is enforced
with permission rules, not just instructions.

## Requirements

- Obsidian 1.11.4 or newer, on desktop.
- At least one engine installed and signed in, in a terminal:
  - [Claude Code](https://docs.claude.com/en/docs/claude-code): `claude`
  - [Codex CLI](https://github.com/openai/codex): `codex`
  - [Antigravity CLI](https://antigravity.google): `agy`
- For the board features: the [Kanban](https://github.com/mgmeyers/obsidian-kanban) plugin
  format (a note with `## Column` headings and `- [ ] card` lines).

## Install

Voice Agent is not in the community plugin list yet. Until it is, install it one of these
ways:

**With BRAT (gets updates automatically)**

1. Install and enable [BRAT](https://github.com/TfTHacker/obsidian42-brat) from Settings,
   Community plugins.
2. Run the command **BRAT: Add a beta plugin for testing** and paste
   `fabianferno/obsidian-voice-agent`.
3. Enable **Voice Agent** in Settings, Community plugins.

**By hand**

1. Download `main.js`, `manifest.json` and `styles.css` from the
   [latest release](https://github.com/fabianferno/obsidian-voice-agent/releases/latest).
2. Put them in `<your vault>/.obsidian/plugins/voice-agent/` (create the folder).
3. Reload Obsidian and enable **Voice Agent** in Settings, Community plugins.

## First run

1. Open **Settings, Voice Agent**. Pick your engine and press **Check** to confirm Obsidian can
   find it. If it cannot (common when Obsidian is opened from the Dock), paste the full path,
   for example the output of `which claude` in a terminal.
2. Set your **Vault layout**: where your kanban board is, your quick-capture folder, the folder
   finished notes move to, and your daily notes. The defaults are `Kanban.md`, `Inbox/`,
   `Notes/` and `Daily/`; change them to match your vault. If the board path is wrong the
   plugin tells you, instead of reporting an empty board.
3. Open the panel with the microphone ribbon icon, or the command **Voice Agent: Open panel**.
4. Bind a hotkey to **Voice Agent: Talk (start or stop listening)** in Settings, Hotkeys.

On first run the plugin creates the agent's files in the agent folder (`agent/` by default):
`soul.md`, `identity.md`, `user.md`, `goals.md` and `memory.md`. Edit them to shape the agent.
`user.md` holds your timezone, quiet hours, check-in interval and coordinates (for weather).

The first time you talk to it, the plugin downloads the ONNX runtime (21 MB, from jsDelivr,
verified by checksum) and the Whisper model (about 80 MB for the default, from Hugging Face).
After that it works offline. The system voice needs no download.

The system voice sounds as good as the voices you have installed. **Automatic** (the default)
picks the best one for your language: a Premium voice, then an Enhanced one, then the basic
default. So on macOS, download a Premium or Enhanced voice in System Settings, Accessibility,
Spoken Content, System voice, Manage voices (on Windows: Settings, Time & language, Speech, Add
voices), restart Obsidian, and press **Play** under Test voice to hear it. Joke voices (Bells,
Bad News and friends) are left out. A macOS Personal Voice is not available to Obsidian, since
Apple only offers it to apps that ask for permission.

Updating from 0.1.x: the old Kokoro voice model is deleted from the cache automatically.

## Talking to it

- **Mic button** (or your hotkey): start or stop listening. Talk naturally; a pause ends your
  turn. While the agent is speaking the mic is ignored, unless you turn on
  **Interrupt by talking** (best with headphones).
- **Stop** (or the **Stop speaking** command): cut the agent off.
- **Type** in the box at the bottom instead of talking.
- `/pause` and `/resume` turn check-ins off and on. `/clear` starts a fresh conversation.
  `/status` shows whether the agent is paused. `/clearboard` empties Done and Archive (asks
  first). `/graduate` runs the daily note pass now.

Things to try: "What should I work on?", "Add call the bank to To Do", "Push the gym card to
Friday", "I'm done with the intro", "What do I know about Priya?", "From now on, never use
emoji with me".

## Check-ins

| When | What |
| --- | --- |
| Morning (08:00) | Top priorities for the day, weather, parked tasks, and what the note pass moved. |
| Midday (13:00) | Progress check on the morning plan. |
| Evening (20:00) | What got done, one question about the day. |
| In between | Short adaptive nudges. More often with deadlines, less when you are busy or ignoring them. |
| Board changes | A card moved into Doing starts a focus session ("how long will it take?"). Finishing, parking or abandoning it is noticed. A card stuck in Doing for 7 days goes back to Backlog. |

## Your notes

- **Filing while you talk.** People and projects you talk about with specifics, your own ideas
  (in your exact words), decisions and commitments are filed in the same reply. An existing
  note, found by name or alias in any folder, gets a line like
  `- **2026-11-14** | moving to Bangalore [Source: voice chat]` under `## Timeline`. Anything
  new becomes a note in the capture folder with one type tag. Turn this off with **File things
  from conversations**.
- **The daily note pass.** Once a day while Obsidian is open (outside quiet hours), the agent
  looks at up to five capture notes (**Notes per day**): first notes where you answered its
  question, then notes nobody has edited for 48 hours. For each it either
  - moves a ready note to the notes folder, with a short summary under the title, your text
    untouched, and a Timeline of facts it found in other notes, each with its source;
  - or leaves one question in a callout under the title. Answer by writing anything in the
    note; the next pass picks it up;
  - or, for an empty or duplicate note, asks whether to delete it, and only after your yes
    moves it to Obsidian's trash.
  It runs in its own read-only engine session, separate from your conversation; the plugin
  checks and writes every change. Each action is logged in `log.md` in the agent folder.
- **You always see what changed.** Every note or file a reply or a note pass creates, edits,
  moves or trashes shows up as a small chip under the message in the panel ("Created Ambition
  debt", "Updated Kanban", "Moved Maria B to Notes"). Click one to open the note. Chips are
  shown, never read aloud, and a note pass posts its own message when it runs.

Times are in settings; leave one empty to turn it off. Check-ins only run while Obsidian is
open; a check-in missed while it was closed runs once when you open it, if it is still the
same day. Quiet hours come from `user.md`.

## Voice providers

| | Listen | Speak | Key | Notes |
| --- | --- | --- | --- | --- |
| Local / System | Whisper (tiny/base/small) | Your OS voice | none | Private and free. Speech starts instantly; quality depends on the voices installed. |
| ElevenLabs | no | yes | ElevenLabs API key | The most natural voices. |
| Sarvam | yes | Bulbul | Sarvam API key | Strong on Indian languages and accents. |
| Soniox | yes | yes | Soniox API key | Fast real-time recognition. |

The system voice uses the Web Speech API, which Obsidian connects to the native engine:
AVSpeechSynthesizer on macOS, Windows' speech voices on Windows and speech-dispatcher on
Linux (install it with a voice such as espeak-ng if the voice list is empty).

Keys are stored in Obsidian's secret storage, not in the plugin's settings file.

## Network use

Voice Agent has no telemetry, no ads and no account of its own. It connects to these
services, and only for these reasons:

| Service | When | What is sent |
| --- | --- | --- |
| Your engine (Claude Code, Codex or Antigravity) | Every message to the agent, and each check-in | Your words, the agent's context (time, board, personality files) and whatever notes the engine opens. The plugin runs the CLI; the CLI talks to its own provider (Anthropic, OpenAI or Google) under your existing sign-in and their terms. |
| `huggingface.co` | First use of local speech recognition, or when you pick a different Whisper model | Nothing about you. Downloads the Whisper model (40 to 250 MB), then cached. |
| `cdn.jsdelivr.net` | First use of local speech recognition | Nothing about you. Downloads the ONNX runtime for transformers.js 3.8.1 (21 MB), checked against a SHA-256 fixed in the plugin, then cached. |
| `api.sarvam.ai` | Only if you choose Sarvam | Your speech audio (to transcribe) or the agent's reply text (to speak), with your Sarvam key. |
| `stt-rt.soniox.com`, `tts-rt.soniox.com` | Only if you choose Soniox | Your speech audio or the agent's reply text, with your Soniox key. |
| `api.elevenlabs.io` | Only if you choose ElevenLabs | The agent's reply text, with your ElevenLabs key. |
| `api.open-meteo.com` | Check-ins, if weather is on and `user.md` has coordinates | The coordinates from `user.md`. Turn weather off in settings. |

With local speech recognition and the system voice, audio never leaves your computer.

## Files outside your vault

- `~/.obsidian-voice-agent/state/` - the agent's working state per vault: focus sessions,
  the last 200 messages, check-in times. Kept outside the vault so sync and git plugins don't
  commit it. Delete the folder to reset the agent.
- `~/.obsidian-voice-agent/runtime/` - the downloaded ONNX runtime for local Whisper.
- Obsidian's browser cache - the downloaded Whisper model.
- The engine CLI keeps its own conversation history where it always does (for example
  `~/.claude/` for Claude Code).

## Programs it runs

The plugin starts the engine CLI you picked (`claude`, `codex` or `agy`) with your vault as
its working directory, the same as running it in a terminal there. By default it asks the
engine to accept file edits without prompting (`acceptEdits` / workspace-write); the
**Permissions** setting controls this. With Claude Code, the daily notes folder is blocked
by permission rules.

## Development

```bash
pnpm install
pnpm test                 # unit tests (vitest)
pnpm lint                 # Obsidian's community review lint rules
pnpm typecheck
pnpm build                # production main.js
OBSIDIAN_PLUGIN_DIR="/path/to/vault/.obsidian/plugins/voice-agent" pnpm dev   # watch + copy into a vault
```

Layout:

- `src/plugin/` - Obsidian plugin: settings, side panel, wiring.
- `src/agent/` - the agent: turns, actions, scheduler loop, kanban focus tracking.
- `src/engines/` - one adapter per CLI (Claude Code, Codex, Antigravity).
- `src/brain/` - prompt building, the actions protocol, signals and priorities.
- `src/voice/` - mic, voice detection, playback, providers; `voice/system.ts` is the OS voice,
  `voice/local/` runs Whisper in a Web Worker.
- `src/vault/`, `src/config/`, `src/context/`, `src/focus/`, `src/checkins/` - vault I/O,
  personality files, context, focus sessions, timers.

To release: bump the version in `manifest.json`, `package.json` and `versions.json`, commit,
then push a tag with the same version (for example `git tag 0.1.1 && git push --tags`). The
release workflow builds the plugin and publishes the three files.

## Contributing

Issues and pull requests are welcome. Please run `pnpm lint && pnpm test` before opening a
pull request, and keep new network calls listed under "Network use".

## License

[MIT](LICENSE)
