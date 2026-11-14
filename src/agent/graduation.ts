// agent/graduation.ts - the daily pass that matures quick-capture notes.
//
// A few notes a day, oldest first, the agent either tidies a ready note and
// moves it to the notes folder, or asks the user one question inside the note,
// or (after the user said yes) trashes a junk note. Notes the user answered come
// first. The engine only reads and decides, in its own read-only session; every
// write happens here, and a rewrite that drops any of the user's lines is refused.

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync, type Dirent } from 'fs';
import path from 'path';
import type { EngineSession } from '../engines/types.js';
import type { Store } from '../store/store.js';
import { agentDir, getLayout } from '../config/paths.js';
import { extractActionBlocks } from '../brain/actions.js';
import { localDate } from '../checkins/scheduler.js';
import { addQuestion, hasQuestion, hashContent, missingUserLines, questionText, removeQuestions } from '../vault/notes.js';
import { createLogger } from '../utils/logger.js';
import type { NoteChange } from './changes.js';

const logger = createLogger('graduation');

const STATE_KEY = 'graduation';
const QUIET_BEFORE_MS = 48 * 60 * 60 * 1000;
const ANSWER_SETTLE_MS = 60 * 60 * 1000;
const TURN_TIMEOUT_MS = 5 * 60 * 1000;

/** File moves that keep links working (Obsidian's file manager in the plugin). */
export interface VaultOps {
  move(fromRel: string, toRel: string): Promise<void>;
  trash(rel: string): Promise<void>;
}

/** Plain file-system moves, for tests and when no Obsidian file manager is available. */
export function fsVaultOps(vaultPath: string): VaultOps {
  return {
    async move(fromRel, toRel) {
      const to = path.join(vaultPath, toRel);
      mkdirSync(path.dirname(to), { recursive: true });
      renameSync(path.join(vaultPath, fromRel), to);
    },
    async trash(rel) {
      const to = path.join(vaultPath, '.trash', path.basename(rel));
      mkdirSync(path.dirname(to), { recursive: true });
      renameSync(path.join(vaultPath, rel), to);
    },
  };
}

export interface GraduationState {
  lastRun?: string;
  /** Notes with an open question: the note's hash when it was asked. */
  asked: Record<string, { hash: string; at: string }>;
  /** What happened since the user was last told, for the morning check-in. */
  report: { moved: string[]; asked: string[]; trashed: string[] };
}

export async function loadGraduationState(store: Store): Promise<GraduationState> {
  const empty: GraduationState = { asked: {}, report: { moved: [], asked: [], trashed: [] } };
  const raw = await store.getSessionState(STATE_KEY);
  if (!raw) return empty;
  try {
    const parsed = JSON.parse(raw) as Partial<GraduationState>;
    return { ...empty, ...parsed, asked: parsed.asked ?? {}, report: { ...empty.report, ...parsed.report } };
  } catch {
    return empty;
  }
}

export async function saveGraduationState(store: Store, state: GraduationState): Promise<void> {
  await store.setSessionState(STATE_KEY, JSON.stringify(state));
}

export interface Candidate {
  rel: string;
  answered: boolean;
  /** The question the user answered, when answered. */
  question?: string;
}

function captureNotes(vaultPath: string): string[] {
  const { captureFolder } = getLayout();
  if (!captureFolder) return [];
  const out: string[] = [];
  const walk = (relDir: string) => {
    let entries: Dirent[];
    try {
      entries = readdirSync(path.join(vaultPath, relDir), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const rel = path.posix.join(relDir, e.name);
      if (e.isDirectory()) walk(rel);
      else if (e.name.endsWith('.md')) out.push(rel);
    }
  };
  walk(captureFolder);
  return out;
}

/** Notes in the capture folder with an open question. */
export function countWaiting(vaultPath: string): number {
  return captureNotes(vaultPath).filter(rel => {
    try {
      return hasQuestion(readFileSync(path.join(vaultPath, rel), 'utf-8'));
    } catch {
      return false;
    }
  }).length;
}

/**
 * Up to `max` notes to work on: answered questions first, then notes untouched
 * for 48 hours that have no open question, oldest first. A note that already
 * has a question but no record (asked before this ran) is recorded as asked, so
 * it waits for an answer instead of being reworked.
 */
export function pickCandidates(vaultPath: string, state: GraduationState, now: Date, max: number): Candidate[] {
  const answered: Array<Candidate & { mtime: number }> = [];
  const fresh: Array<Candidate & { mtime: number }> = [];
  const present = new Set<string>();
  for (const rel of captureNotes(vaultPath)) {
    present.add(rel);
    const file = path.join(vaultPath, rel);
    const content = readFileSync(file, 'utf-8');
    const mtime = statSync(file).mtimeMs;
    const record = state.asked[rel];
    if (record) {
      if (hashContent(content) !== record.hash && now.getTime() - mtime >= ANSWER_SETTLE_MS) {
        answered.push({ rel, answered: true, question: questionText(content) ?? undefined, mtime });
      }
      continue;
    }
    if (hasQuestion(content)) {
      state.asked[rel] = { hash: hashContent(content), at: now.toISOString() };
      continue;
    }
    if (now.getTime() - mtime >= QUIET_BEFORE_MS) fresh.push({ rel, answered: false, mtime });
  }
  // Forget records of notes that were moved or deleted by hand.
  for (const rel of Object.keys(state.asked)) if (!present.has(rel)) delete state.asked[rel];
  const byAge = (a: { mtime: number }, b: { mtime: number }) => a.mtime - b.mtime;
  return [...answered.sort(byAge), ...fresh.sort(byAge)].slice(0, max).map(({ mtime: _m, ...c }) => c);
}

type GraduationAction =
  | { type: 'graduate_note'; file: string; content: string }
  | { type: 'ask_note'; file: string; question: string; content?: string }
  | { type: 'trash_note'; file: string };

function toAction(a: unknown): GraduationAction | null {
  if (!a || typeof a !== 'object') return null;
  const o = a as Record<string, unknown>;
  const str = (k: string): string | null => {
    const v = o[k];
    return typeof v === 'string' && v.trim() ? v : null;
  };
  const file = str('file');
  if (!file) return null;
  const content = str('content');
  const question = str('question');
  if (o.type === 'graduate_note' && content) return { type: 'graduate_note', file, content };
  if (o.type === 'ask_note' && question) return { type: 'ask_note', file, question, ...(content ? { content } : {}) };
  if (o.type === 'trash_note') return { type: 'trash_note', file };
  return null;
}

export function parseGraduationReply(raw: string): GraduationAction[] {
  return extractActionBlocks(raw).actions.map(toAction).filter((a): a is GraduationAction => a !== null);
}

export function buildGraduationSystemPrompt(): string {
  const { captureFolder, notesFolder, dailyFolder } = getLayout();
  return `You tend the user's quick-capture notes in their Obsidian vault (your working directory).
Notes start in "${captureFolder}/". Ready notes move to "${notesFolder}/". You run in the
background; the user does not read this conversation.

You may read and search the vault with your tools. You cannot edit files: you reply with one
action and the plugin applies it. NEVER read, search or open anything under "${dailyFolder}/".
Follow the vault's own conventions (its CLAUDE.md or AGENTS.md: tags, templates, naming).

For each note you are given, decide one of:
1. Ready: it says what the subject is and why it matters to the user. A person: who they are
   and how the user knows them. A project or event: what it is and who, where or how it went.
   A film or article: a one-line take. Reply with graduate_note and the full new note.
2. Thin: missing that. Reply with ask_note and ONE short, specific question whose answer would
   make it ready. You may include tidied content.
3. Junk: empty, a duplicate of another note, or pasted noise. Reply with ask_note asking whether
   to delete it (or to merge it, naming the other note).
If the user answered a delete question with yes, reply with trash_note.

Writing a note (graduate_note content, and optional ask_note content):
- Keep every line the user wrote, word for word, spelling included. Never paraphrase, summarize
  away or clean up their words. You may reorder lines, but every one must survive: the plugin
  refuses content that drops any of them.
- Fold the user's answer to your question into the note as their own lines, and leave out the
  question callout.
- Shape: frontmatter, "# Title", a summary of one to three lines under the title (the only part
  in your own words), the user's text, "## Timeline" with dated lines for facts you add
  (- **YYYY-MM-DD** | fact [Source: <note it came from>]), then "##### References".
- Add facts only from other notes in the vault, never from your own knowledge. No guessing:
  leave out anything you cannot point to a note for.
- Exactly one type tag in the frontmatter, from the vault's tags. No maturity tags. Fill empty
  frontmatter fields only from facts in the note or linked notes; keep the rest as it is.
- Remove empty template padding (runs of blank lines).

Reply with ONLY one action block and no other words, for example:
<actions>[{"type":"graduate_note","file":"<path>","content":"<the full note>"}]</actions>
<actions>[{"type":"ask_note","file":"<path>","question":"<question>"}]</actions>
<actions>[{"type":"trash_note","file":"<path>"}]</actions>`;
}

export function buildGraduationTurn(c: Candidate, content: string, today: string): string {
  const answered = c.answered
    ? `\nThe user has written in this note since you asked${c.question ? `: "${c.question}"` : ''}. Treat what they added as their answer.`
    : '';
  return `Today is ${today}.
Note: "${c.rel}"${answered}
<<<note
${content}
note>>>
Decide, and reply with one action.`;
}

export interface GraduationResult {
  moved: string[];
  asked: string[];
  trashed: string[];
  /** The same, as file changes for the panel. */
  changes: NoteChange[];
  skipped: Array<{ note: string; reason: string }>;
}

const noteName = (rel: string) => path.basename(rel, '.md');

export class Graduation {
  constructor(
    private readonly vaultPath: string,
    private readonly store: Store,
    private readonly makeEngine: (systemPrompt: string) => EngineSession,
    private readonly ops: VaultOps,
  ) {}

  async run(max: number, now = new Date()): Promise<GraduationResult> {
    const result: GraduationResult = { moved: [], asked: [], trashed: [], changes: [], skipped: [] };
    const state = await loadGraduationState(this.store);
    const today = localDate(now);
    const candidates = pickCandidates(this.vaultPath, state, now, max);
    state.lastRun = today;
    if (!candidates.length) {
      await saveGraduationState(this.store, state);
      return result;
    }
    const engine = this.makeEngine(buildGraduationSystemPrompt());
    try {
      for (const c of candidates) {
        try {
          await this.handle(engine, c, state, today, result);
        } catch (err) {
          const reason = (err as Error).message;
          logger.warn(`Left ${c.rel} as it is: ${reason}`);
          result.skipped.push({ note: noteName(c.rel), reason });
        }
        await saveGraduationState(this.store, state);
      }
    } finally {
      engine.close();
    }
    state.report.moved.push(...result.moved);
    state.report.asked.push(...result.asked);
    state.report.trashed.push(...result.trashed);
    await saveGraduationState(this.store, state);
    return result;
  }

  private async handle(engine: EngineSession, c: Candidate, state: GraduationState, today: string, result: GraduationResult): Promise<void> {
    const file = path.join(this.vaultPath, c.rel);
    const original = readFileSync(file, 'utf-8');
    let raw = '';
    const timer = window.setTimeout(() => engine.interrupt(), TURN_TIMEOUT_MS);
    const turn = await engine.turn(buildGraduationTurn(c, original, today), (e) => {
      if (e.type === 'text') raw += e.text;
    }).finally(() => window.clearTimeout(timer));
    if (turn.error || turn.interrupted) throw new Error(turn.error ?? 'took too long');

    const action = parseGraduationReply(raw).find(a => a.file === c.rel || noteName(a.file) === noteName(c.rel));
    if (!action) throw new Error('no usable action');
    // The note may have changed while the engine thought; never write over that.
    if (readFileSync(file, 'utf-8') !== original) throw new Error('changed while working on it');

    const keepsWords = (next: string) => {
      const lost = missingUserLines(original, next);
      if (lost.length) throw new Error(`would have dropped ${lost.length} of your lines`);
    };

    switch (action.type) {
      case 'graduate_note': {
        const content = removeQuestions(action.content).replace(/\s+$/, '') + '\n';
        keepsWords(content);
        const { notesFolder } = getLayout();
        const dest = path.posix.join(notesFolder, path.basename(c.rel));
        if (existsSync(path.join(this.vaultPath, dest))) throw new Error(`"${dest}" already exists`);
        writeFileSync(file, content, 'utf-8');
        await this.ops.move(c.rel, dest);
        delete state.asked[c.rel];
        result.moved.push(noteName(c.rel));
        result.changes.push({ kind: 'moved', path: c.rel, to: dest });
        this.log(today, 'graduate', noteName(c.rel));
        break;
      }
      case 'ask_note': {
        const base = action.content ? removeQuestions(action.content).replace(/\s+$/, '') + '\n' : original;
        if (action.content) keepsWords(base);
        const asked = addQuestion(base, action.question);
        writeFileSync(file, asked, 'utf-8');
        state.asked[c.rel] = { hash: hashContent(asked), at: new Date().toISOString() };
        result.asked.push(noteName(c.rel));
        result.changes.push({ kind: 'asked', path: c.rel });
        this.log(today, 'ask', `${noteName(c.rel)}: ${action.question}`);
        break;
      }
      case 'trash_note': {
        if (!c.answered) throw new Error('asked to delete a note the user has not answered');
        await this.ops.trash(c.rel);
        delete state.asked[c.rel];
        result.trashed.push(noteName(c.rel));
        result.changes.push({ kind: 'trashed', path: c.rel });
        this.log(today, 'trash', noteName(c.rel));
        break;
      }
    }
  }

  /** One line per action in the agent's log, greppable: `## [2026-11-14] graduate | Maria B`. */
  private log(date: string, kind: string, text: string): void {
    try {
      const dir = agentDir(this.vaultPath);
      const file = path.join(dir, 'log.md');
      if (!existsSync(file)) {
        mkdirSync(dir, { recursive: true });
        writeFileSync(file, '# Agent log\n\nWhat the agent did in the vault, newest last.\n\n', 'utf-8');
      }
      appendFileSync(file, `## [${date}] ${kind} | ${text.replace(/\s+/g, ' ')}\n`, 'utf-8');
    } catch (err) {
      logger.error('Could not write the agent log', err);
    }
  }
}
