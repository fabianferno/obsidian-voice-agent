# Second brain: capture, graduation, note shape

Date: 2026-11-14. Status: approved by the user in conversation ("consolidate everything we've
discussed and agreed to build and go ahead and build it").

## Intent

The agent should behave like a second brain, not only tidy what exists. Two halves of one loop:

1. **Capture while you talk.** Anything worth keeping from a conversation lands in the vault:
   an existing note gets a dated line, a new subject gets a new note in the capture folder.
2. **Mature once a day.** The agent works through the capture folder (Synapses) on its own,
   a few notes a day: tidies and moves a ready note to the notes folder (Neurons), or asks one
   question inside the note, or asks whether a junk note should go.

So the notes keep getting better without the user doing the filing. Informed by Karpathy's
"LLM Wiki" (ingest / query / lint, index and log) and Garry Tan's gbrain (compiled truth +
timeline, signal detector, notability, exact phrasing, provenance, thin harness / deterministic
work in code). We keep the user's own process: maturity by folder (Synapses -> Neurons), types by
tag, questions inside the note, voice-first.

## Decisions (made by the user)

- **Autonomy: option B.** The agent graduates notes on its own, about 5 a day, and reports at the
  morning check-in. Thin notes become questions.
- **Questions live in the note**, as a callout under the title. The user answers by writing in
  the note. No separate questions file. No spoken question at check-ins.
- **Delete questions**: the agent may ask whether an empty or duplicate note should go; it trashes
  a note only after the user answered yes, through Obsidian's trash.
- **Note shape**: summary at the top (the only part the agent rewrites), the user's own text
  untouched, `## Timeline` of dated, append-only lines with a source, then `##### References`.
  Converted gradually, when a note is next touched.
- **No maturity tags.** The folder is the maturity marker. `state/` means progress only
  (`state/todo|doing|done`).
- **Tags**: exactly one type tag per note (`people`, `projects` (+`/startup`, `/hackathon`),
  `hackathon`, `org`, `concept`, `meeting`, `literature`, `movie`, `content-creation/*`,
  `personal`), optional `on/*` topics. Documented in the vault's CLAUDE.md, which Claude Code
  reads on its own.
- **Facts only from the vault**, never outside knowledge; the user's words are never paraphrased.

## Goals

- Daily graduation of up to N (default 5) capture-folder notes, separate from the chat.
- Answered questions are noticed and processed first.
- Capture in conversation through one deterministic action.
- An activity log the user (and the agent) can read.
- Morning check-in mentions what moved and how many questions wait.

## Non-goals

- External enrichment (web, LinkedIn): breaks "facts only from the vault" and the network rule.
- Vector search, databases, a typed folder layout.
- Saving query answers back as notes (agreed for later).
- Rewriting existing Neurons notes in bulk.

## Anti-goals (failure even if it "works")

- Any rewrite of the user's own words (the June 16 script failure). Enforced in code, not only
  in the prompt: a graduation whose new content drops any of the user's lines is rejected.
- Deleting a note without the user's yes.
- Moving a note in a way that breaks links.
- Graduation chatter in the user's conversation.

## Approaches considered (graduation)

1. **Engine edits and moves files with its own tools.** Least code. But the engine could edit any
   note, moves by file system break links, and nothing checks the user's words survive.
2. **Engine reads with its tools, writes through actions; plugin validates and writes.** (chosen)
   The graduation engine session is read-only. It returns `graduate_note`, `ask_note` or
   `trash_note`. The plugin checks the user's lines are all still there and that the note has one
   type tag, writes, and moves through Obsidian's `fileManager.renameFile` (updates links).
   Deterministic work (eligibility, moving, links, logging) in code; judgment in the model.
3. **Plugin gathers context itself, engine gets no tools.** Cheapest per note, but the engine
   cannot search the vault for the facts that make a note ready.

Capture: an action (`note`) that the plugin applies, rather than the engine editing files
mid-reply, so a spoken reply is not slowed by tool calls and the write is tested code.

## Design

### Capture (`note` action)

`{"type":"note","title":"<note name>","noteType":"<type tag>","text":"<what to record>"}`

- Finds an existing note by file name or alias anywhere in the vault (skipping the daily folder,
  agent folder, hidden folders). Found: appends `- **YYYY-MM-DD** | <text> [Source: voice chat]`
  to its `## Timeline` (creating the section before `##### References`, or at the end).
- Not found: creates `<captureFolder>/<title>.md` with `tags: [<noteType>]`, `# <title>`, a
  Timeline with the line, and `##### References`. Falls back to the notes folder when no capture
  folder is set.
- `people_note` and `literature_note` keep working and go through the same writer.
- Prompt rules (gbrain signal detector): capture people and projects the user talks about with
  specifics, the user's own ideas in their exact words (title = their phrase), decisions and
  commitments; skip passing mentions, small talk and operational messages. Say in a few words
  what was filed. A setting turns capture off.

### Graduation

- Runs at most once a day while Obsidian is open (checked on start and hourly), outside quiet
  hours, not while paused, when enabled and a capture folder is set.
- Candidates, in order: (1) notes whose question was answered (changed since the agent asked,
  and not edited in the last hour), oldest first; (2) notes not edited for 48 hours that have no
  open question, oldest first. Up to N per run.
- Notes that already carry a question when first seen are recorded as asked (baseline hash), so
  they wait for an answer.
- One read-only engine session per run (Claude Code: Edit/Write disallowed, default permission
  mode; Codex: read-only sandbox; Antigravity: no accept-edits). One turn per note. The session is
  separate from the chat engine.
- Actions:
  - `graduate_note {file, content}`: content is the full new note. Rejected unless every line of
    the user's text (body lines other than the agent's question callout, the title and
    `##### References`) is still present, and there is exactly one type tag. Written, then moved to
    `<notesFolder>/<name>.md` (skipped and logged if that exists).
  - `ask_note {file, question, content?}`: optional tidied content (same check), question callout
    replaces any older one, the note's hash is recorded.
  - `trash_note {file}`: only when the note had an answered question; goes to Obsidian's trash.
- Each outcome is appended to `<agentFolder>/log.md` as `## [YYYY-MM-DD] graduate | <name>`.
- The run's results are kept for the next morning check-in or startup greeting, which mentions
  what moved and how many notes are waiting on the user, then cleared.
- The old "N capture notes older than 48 hours, want to triage?" prompt is removed.
- Commands: `/graduate` runs a pass now (ignoring the once-a-day limit).

### Main conversation prompt

- `note` action and capture rules replace the people/literature lines.
- When the engine edits notes itself: keep the user's words, add facts as Timeline lines with a
  source, rewrite only the summary, one type tag, follow the vault CLAUDE.md.

### Settings

- "Second brain" section: Capture from conversations (on), Graduate capture notes daily (on),
  Notes per day (5).
- Capture folder description: new notes start here and are moved to the notes folder when ready.
  Notes folder: where finished notes go.

## Left to the builder

Exact prompt wording, file layout of the new modules, test fixtures.
