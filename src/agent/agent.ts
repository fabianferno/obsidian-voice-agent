// agent/agent.ts - the agent itself, independent of Obsidian's UI.
//
// Owns the engine conversation, the scheduler, the kanban poll and the focus
// tracker. The plugin feeds it what the user says and shows/speaks what comes
// back: replies stream through ReplyHandlers, proactive messages (briefings,
// nudges) arrive through `deliver`.

import { createHash, randomUUID } from 'crypto';
import { asArray, asObject, parseJson } from '../utils/json.js';
import type { Http } from '../voice/http.js';
import { existsSync, readFileSync } from 'fs';
import path from 'path';
import { addChange, type NoteChange } from './changes.js';
import type { AgentConfig, CheckinType, ContextData, VaultAction } from '../config/types.js';
import type { Store } from '../store/store.js';
import type { EngineSession } from '../engines/types.js';
import { loadAgentConfig } from '../config/loader.js';
import { agentDir, boardFile, getLayout } from '../config/paths.js';
import { ensureAgentFiles } from '../config/templates.js';
import { assembleContext } from '../context/provider.js';
import { toIanaZone } from '../context/datetime.js';
import { detectSignals } from '../brain/signals.js';
import { buildSystemPrompt, buildTurn } from '../brain/prompt-builder.js';
import { ActionStreamFilter, describeActions, parseAgentReply } from '../brain/actions.js';
import { executeVaultActions, getPendingConfigEdit } from './execute-actions.js';
import {
  arePulsesSuppressed, calculateNextPulse, cancelPulse, isPulseScheduled, localDate, missedCheckpoint,
  resumePulses, schedulePulse, startCheckpoints, suppressPulses,
  type CheckpointKind, type CheckpointTimes,
} from '../checkins/scheduler.js';
import { FocusTracker, extractCardId, locateRemovedCard } from '../focus/tracker.js';
import { checkGuard } from '../focus/guard.js';
import { parseTimeEstimate } from '../focus/estimator.js';
import { parseInboxKanban } from '../vault/parser.js';
import { autoMoveCompletedToDone, clearColumns, countColumnCards, ensureCardIds, mutateKanban } from '../vault/writer.js';
import { Graduation, countWaiting, fsVaultOps, loadGraduationState, saveGraduationState, type GraduationResult, type VaultOps } from './graduation.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('agent');

export interface AgentSettings {
  /** What the engine calls the agent. The spoken persona name lives in identity.md. */
  agentName: string;
  checkpointTimes: CheckpointTimes;
  /** A short greeting when Obsidian opens (at most every 3 hours). */
  greetOnOpen: boolean;
  /** Adaptive nudges between checkpoints. */
  pulses: boolean;
  /** Weather in the context (open-meteo, needs coordinates in user.md). */
  weather: boolean;
  /** File what is worth keeping from conversations into notes. */
  capture: boolean;
  /** Work through the capture folder once a day. */
  graduate: boolean;
  /** Notes handled per daily pass. */
  graduatePerDay: number;
}

export interface AgentMessage {
  text: string;
  /** What produced it: 'checkpoint:morning', 'pulse', 'focus-nudge', ... */
  source: string;
  /** Notes and files it touched, shown under the message. */
  changes?: NoteChange[];
  /** False for messages that are only shown, never read aloud. */
  speak?: boolean;
}

export interface ReplyHandlers {
  /** Words to show and speak, streamed. The actions block never comes through. */
  onText?(delta: string): void;
  /** What the engine is doing (reading a note...). Shown, not spoken. */
  onStatus?(text: string): void;
  /** A note or file was created, edited or moved during the turn. Shown, not spoken. */
  onChange?(change: NoteChange): void;
}

export interface TurnOutcome {
  text: string;
  actions: VaultAction[];
  /** Notes and files the turn touched. */
  changes?: NoteChange[];
  error?: string;
  interrupted: boolean;
}

/** Builds an engine conversation that starts with the given system prompt. */
export type EngineFactory = (systemPrompt: string, opts?: { readOnly?: boolean }) => EngineSession;

const DEDUP_MS = 10 * 60 * 1000;
const GREETING_GAP_MS = 3 * 60 * 60 * 1000;
const CLEARBOARD_COLUMNS = ['Done', 'Archive'];

export class Agent {
  private config: AgentConfig;
  private engine?: EngineSession;
  private personaKey = '';
  private queue: Promise<unknown> = Promise.resolve();
  private stopCheckpoints?: () => void;
  private kanbanTimer?: number;
  private watchdogTimer?: number;
  private graduationTimer?: number;
  private graduationKickoff?: number;
  private graduating = false;
  private lastDelivered = new Map<string, { text: string; at: number }>();
  private running = false;
  readonly focus: FocusTracker;

  constructor(
    private readonly vaultPath: string,
    private readonly store: Store,
    private makeEngine: EngineFactory,
    private settings: AgentSettings,
    private readonly deliver: (m: AgentMessage) => void,
    private readonly http?: Http,
    private readonly vaultOps: VaultOps = fsVaultOps(vaultPath),
  ) {
    this.config = loadAgentConfig(agentDir(vaultPath));
    this.focus = new FocusTracker(store, (text, source) => this.notify(text, source ?? 'focus'), () => this.getContext());
  }

  // --- lifecycle ---

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    const created = ensureAgentFiles(agentDir(this.vaultPath));
    if (created.length) logger.info(`Created starter agent files: ${created.join(', ')}`);
    this.config = loadAgentConfig(agentDir(this.vaultPath));

    try {
      if (existsSync(boardFile(this.vaultPath))) ensureCardIds(this.vaultPath);
    } catch (err) {
      logger.error('Card id migration failed', err);
    }

    resumePulses();
    await this.focus.recoverFromDb();
    this.stopCheckpoints = startCheckpoints(this.settings.checkpointTimes, (kind) => this.runCheckpoint(kind));
    this.startKanbanPoll();
    this.startWatchdog();
    // The daily note pass: checked shortly after start (after any greeting) and hourly.
    this.graduationKickoff = window.setTimeout(() => void this.maybeGraduate(), 2 * 60 * 1000);
    this.graduationTimer = window.setInterval(() => void this.maybeGraduate(), 60 * 60 * 1000);
    if (this.settings.pulses) schedulePulse(this.config.userMeta.pulseIntervalMinutes, () => this.runPulse());

    // Catch up a checkpoint missed while Obsidian was closed, else greet.
    const missed = missedCheckpoint(this.settings.checkpointTimes, await this.lastCheckpointRuns(), new Date());
    if (missed) {
      void this.runCheckpoint(missed);
    } else if (this.settings.greetOnOpen && !this.isQuietHours()) {
      const last = Number(await this.store.getSessionState('last_greeting') ?? 0);
      if (Date.now() - last > GREETING_GAP_MS) {
        await this.store.setSessionState('last_greeting', String(Date.now()));
        void this.runProactive('startup', 'startup-briefing');
      }
    }
  }

  stop(): void {
    this.running = false;
    this.stopCheckpoints?.();
    this.stopCheckpoints = undefined;
    if (this.kanbanTimer) window.clearInterval(this.kanbanTimer);
    if (this.watchdogTimer) window.clearInterval(this.watchdogTimer);
    if (this.graduationTimer) window.clearInterval(this.graduationTimer);
    if (this.graduationKickoff) window.clearTimeout(this.graduationKickoff);
    this.kanbanTimer = this.watchdogTimer = this.graduationTimer = this.graduationKickoff = undefined;
    cancelPulse();
    this.focus.shutdown();
    this.engine?.close();
    this.engine = undefined;
  }

  /** Apply new settings. Checkpoint timers are re-armed. */
  updateSettings(next: AgentSettings): void {
    const nameChanged = next.agentName !== this.settings.agentName || next.capture !== this.settings.capture;
    this.settings = next;
    if (nameChanged) this.personaKey = '';
    if (this.running) {
      this.stopCheckpoints?.();
      this.stopCheckpoints = startCheckpoints(next.checkpointTimes, (kind) => this.runCheckpoint(kind));
      if (!next.pulses) cancelPulse();
    }
  }

  /** Switch engines (or engine options). The next turn starts a fresh conversation. */
  setEngineFactory(factory: EngineFactory): void {
    this.makeEngine = factory;
    this.engine?.close();
    this.engine = undefined;
    this.personaKey = '';
  }

  /** Stop the reply in progress (the user started talking over it). */
  interrupt(): void {
    this.engine?.interrupt();
  }

  /** Forget the engine conversation. */
  async resetConversation(): Promise<void> {
    this.engine?.reset();
    await this.store.clearMessages();
  }

  // --- the user talks ---

  async handleUserMessage(text: string, opts: { spoken?: boolean } & ReplyHandlers = {}): Promise<TurnOutcome> {
    const trimmed = text.trim();
    if (!trimmed) return { text: '', actions: [], interrupted: false };
    await this.record('incoming', trimmed, opts.spoken);

    const local = await this.handleLocally(trimmed);
    if (local !== null) {
      opts.onText?.(local);
      await this.record('outgoing', local);
      return { text: local, actions: [], interrupted: false };
    }

    await this.store.setSessionState('break_until', '');
    const outcome = await this.exclusive(async () => {
      const context = await this.getContext();
      const turn = buildTurn('reply', this.config, context, await this.signals(context), {
        activeSessions: await this.store.getActiveSessions(),
        pendingEdit: await getPendingConfigEdit(this.store),
        userText: trimmed,
        spoken: opts.spoken,
        columns: this.readBoard()?.columnOrder,
      });
      const result = await this.runEngineTurn(turn, opts);
      if (!result.interrupted && !result.error) await this.scheduleAdaptivePulse(context, 0);
      return result;
    });
    if (outcome.text) await this.record('outgoing', outcome.text);
    return outcome;
  }

  /** Commands and short flows handled without the engine. Returns the reply, or null. */
  private async handleLocally(text: string): Promise<string | null> {
    const lower = text.toLowerCase();

    if (lower === '/clear') {
      await this.resetConversation();
      return 'Conversation cleared.';
    }
    if (lower === '/pause') {
      await this.store.setSessionState('agent_paused', '1');
      suppressPulses();
      return 'Paused. No check-ins or nudges until you say /resume.';
    }
    if (lower === '/resume') {
      await this.store.setSessionState('agent_paused', '');
      resumePulses();
      if (this.settings.pulses) schedulePulse(this.config.userMeta.pulseIntervalMinutes, () => this.runPulse());
      return 'Resumed. Check-ins are back on.';
    }
    if (lower === '/status') {
      const paused = await this.isPaused();
      const sessions = await this.store.getActiveSessions();
      return `Agent ${paused ? 'paused' : 'running'}. Active focus sessions: ${sessions.length}.`;
    }

    if (lower === '/graduate') {
      if (!getLayout().captureFolder) return 'Set a capture folder in the settings first.';
      if (this.graduating) return 'Already working through your capture notes.';
      void this.runGraduation().then(async (r) => {
        if (r) await this.reportNotePass(r);
      });
      return `Working through up to ${Math.max(1, this.settings.graduatePerDay)} capture notes now. I'll tell you when it's done.`;
    }

    // Two-step board clear so a slip cannot wipe the board.
    if (lower === '/clearboard') {
      const n = countColumnCards(this.vaultPath, CLEARBOARD_COLUMNS);
      if (n === 0) return 'Nothing to clear. Done and Archive are already empty.';
      await this.store.setSessionState('clearboard_pending', '1');
      return `This deletes ${n} card${n === 1 ? '' : 's'} from Done and Archive. Say yes to confirm.`;
    }
    if ((await this.store.getSessionState('clearboard_pending')) === '1') {
      await this.store.setSessionState('clearboard_pending', '');
      if (/^(yes|y|yeah|yep|confirm)\b/.test(lower)) {
        const removed = clearColumns(this.vaultPath, CLEARBOARD_COLUMNS);
        return `Cleared ${removed} card${removed === 1 ? '' : 's'} from Done and Archive.`;
      }
      if (/^(no|n|nope|nah|cancel|stop)\b/.test(lower)) return 'Board clear cancelled.';
    }

    if (/taking a break|need a break|\bbrb\b|stepping away/.test(lower)) {
      await this.store.setSessionState('break_until', new Date(Date.now() + 60 * 60 * 1000).toISOString());
      return "Enjoy your break. I'll be quiet for an hour.";
    }

    // Answer to "how long will it take?" after a card moved into Doing.
    const awaiting = this.focus.getAwaitingEstimate();
    if (awaiting) {
      const tz = toIanaZone(this.config.userMeta.timezone);
      const estimate = parseTimeEstimate(text, this.config.userMeta.timezone);
      if (estimate) {
        this.focus.clearAwaitingEstimate();
        const session = await this.focus.startSession(awaiting.taskText, awaiting.rawLine, estimate, 'user', awaiting.cardId);
        const at = new Date(session.deadlineAt).toLocaleTimeString('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' });
        return `Got it. I'll check in at ${at}. Go.`;
      }
      if (!awaiting.reprompted) {
        this.focus.markReprompted();
        return "Rough guess? Even 'about an hour' helps.";
      }
    }
    return null;
  }

  // --- the daily note pass ---

  /** Runs the pass if it is on, has not run today, and now is a good time. */
  private async maybeGraduate(): Promise<void> {
    if (!this.running || !this.settings.graduate || !getLayout().captureFolder) return;
    if (this.isQuietHours() || (await this.isPaused())) return;
    const state = await loadGraduationState(this.store);
    if (state.lastRun === localDate(new Date())) return;
    const result = await this.runGraduation();
    if (result?.changes.length) await this.reportNotePass(result);
  }

  /** Shows (not speaks) what a note pass did, with the touched notes linked. */
  private async reportNotePass(r: GraduationResult): Promise<void> {
    const parts = [
      r.moved.length ? `moved ${r.moved.length} note${r.moved.length === 1 ? '' : 's'} to your notes folder` : '',
      r.asked.length ? `left ${r.asked.length} question${r.asked.length === 1 ? '' : 's'} in notes` : '',
      r.trashed.length ? `trashed ${r.trashed.length}` : '',
      r.skipped.length ? `left ${r.skipped.length} as they were` : '',
    ].filter(Boolean);
    const text = parts.length ? `Note pass done: ${parts.join('; ')}.` : 'Note pass done: nothing needed attention.';
    await this.notify(text, 'note-pass', { changes: r.changes, speak: false });
  }

  /** One pass over the capture folder. Public for the /graduate command and tests. */
  async runGraduation(): Promise<GraduationResult | null> {
    if (this.graduating) return null;
    this.graduating = true;
    try {
      const pass = new Graduation(this.vaultPath, this.store, (prompt) => this.makeEngine(prompt, { readOnly: true }), this.vaultOps);
      const result = await pass.run(Math.max(1, this.settings.graduatePerDay));
      logger.info(`Note pass: ${result.moved.length} moved, ${result.asked.length} asked, ${result.trashed.length} trashed, ${result.skipped.length} left`);
      return result;
    } catch (err) {
      logger.error('Note pass failed', err);
      return null;
    } finally {
      this.graduating = false;
    }
  }

  /** What the note pass did since the user was last told, or undefined when nothing. */
  private async secondBrainReport() {
    const state = await loadGraduationState(this.store);
    const { moved, asked, trashed } = state.report;
    if (!moved.length && !asked.length && !trashed.length) return undefined;
    return { moved, asked: asked.length, trashed, waiting: countWaiting(this.vaultPath) };
  }

  private async clearSecondBrainReport(): Promise<void> {
    const state = await loadGraduationState(this.store);
    state.report = { moved: [], asked: [], trashed: [] };
    await saveGraduationState(this.store, state);
  }

  // --- engine turns ---

  /** Runs turns one at a time: the engine can only do one conversation turn at once. */
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private ensureEngine(): EngineSession {
    const c = this.config;
    const key = createHash('sha1').update([c.soul, c.identity, c.user, c.goals, this.settings.agentName, String(this.settings.capture)].join('\0')).digest('hex');
    if (!this.engine || key !== this.personaKey) {
      // Personality changed (or first turn): start a conversation with the new prompt.
      this.engine?.close();
      this.engine = this.makeEngine(buildSystemPrompt(c, { agentName: this.settings.agentName, capture: this.settings.capture }));
      this.personaKey = key;
    }
    return this.engine;
  }

  private async runEngineTurn(prompt: string, handlers: ReplyHandlers = {}): Promise<TurnOutcome> {
    const engine = this.ensureEngine();
    const filter = new ActionStreamFilter();
    let raw = '';
    let changes: NoteChange[] = [];
    const record = (c: NoteChange) => {
      changes = addChange(changes, c);
      handlers.onChange?.(c);
    };
    const result = await engine.turn(prompt, (e) => {
      if (e.type === 'status') return handlers.onStatus?.(e.text);
      if (e.type === 'file') {
        const abs = path.isAbsolute(e.path) ? e.path : path.join(this.vaultPath, e.path);
        // Reported before the tool runs: a file that is not there yet is being created.
        record({ kind: e.kind ?? (existsSync(abs) ? 'updated' : 'created'), path: path.relative(this.vaultPath, abs).split(path.sep).join('/') });
        return;
      }
      raw += e.text;
      const visible = filter.push(e.text);
      if (visible) handlers.onText?.(visible);
    });
    const tail = filter.flush();
    if (tail) handlers.onText?.(tail);

    if (result.interrupted) return { text: parseAgentReply(raw).message, actions: [], changes, interrupted: true };
    if (result.error) {
      logger.error('Engine turn failed', result.error);
      return { text: '', actions: [], interrupted: false, error: result.error };
    }

    const parsed = parseAgentReply(raw);
    if (parsed.rejected.length) logger.warn('Rejected actions', parsed.rejected);
    let text = parsed.message;
    if (parsed.vaultActions.length) {
      const results = await executeVaultActions(this.vaultPath, this.store, parsed.vaultActions, record);
      this.config = loadAgentConfig(agentDir(this.vaultPath));
      // The engine already says what it did; only failures are added. When it
      // said nothing, describe the actions so the change is not silent.
      const lines = text
        ? results.filter(r => !r.ok).map(r => r.text)
        : [describeActions(parsed.vaultActions), ...results.map(r => r.text)];
      const addition = lines.filter(Boolean).join('\n');
      if (addition) {
        handlers.onText?.((text ? '\n' : '') + addition);
        text = [text, addition].filter(Boolean).join('\n');
      }
    }
    return { text, actions: parsed.vaultActions, changes, interrupted: false };
  }

  /** A check-in the agent starts: build the turn, run it, deliver the result. */
  private async runProactive(kind: Exclude<CheckinType, 'reply'>, source: string): Promise<string | null> {
    if (!this.running || (await this.isPaused())) return null;
    try {
      const report = kind === 'morning_checkpoint' || kind === 'startup' ? await this.secondBrainReport() : undefined;
      const outcome = await this.exclusive(async () => {
        const context = await this.getContext();
        const midnight = new Date();
        midnight.setHours(0, 0, 0, 0);
        const turn = buildTurn(kind, this.config, context, await this.signals(context), {
          activeSessions: await this.store.getActiveSessions(),
          completedToday: await this.store.getCompletedSessions(midnight.toISOString()),
          pendingEdit: await getPendingConfigEdit(this.store),
          columns: this.readBoard()?.columnOrder,
          secondBrain: report,
        });
        return this.runEngineTurn(turn);
      });
      if (outcome.error || !outcome.text) return null;
      if (report) await this.clearSecondBrainReport();
      await this.notify(outcome.text, source, { changes: outcome.changes });
      return outcome.text;
    } catch (err) {
      logger.error(`${kind} failed`, err);
      return null;
    }
  }

  private async runCheckpoint(kind: CheckpointKind): Promise<void> {
    const runs = await this.lastCheckpointRuns();
    runs[kind] = localDate(new Date());
    await this.store.setSessionState('checkpoint_last_run', JSON.stringify(runs));
    await this.runProactive(kind, `checkpoint:${kind.replace('_checkpoint', '')}`);
  }

  private async runPulse(): Promise<void> {
    if (!this.settings.pulses || this.isQuietHours()) return;
    const breakUntil = await this.store.getSessionState('break_until');
    if (breakUntil && new Date(breakUntil).getTime() > Date.now()) return;
    await this.runProactive('pulse', 'pulse');
    const context = await this.getContext();
    await this.scheduleAdaptivePulse(context, Number.MAX_SAFE_INTEGER);
  }

  private async lastCheckpointRuns(): Promise<Partial<Record<CheckpointKind, string>>> {
    try {
      const raw = asObject(parseJson((await this.store.getSessionState('checkpoint_last_run')) ?? '{}'));
      const runs: Partial<Record<CheckpointKind, string>> = {};
      for (const [k, v] of Object.entries(raw)) if (typeof v === 'string') runs[k as CheckpointKind] = v;
      return runs;
    } catch {
      return {};
    }
  }

  // --- delivery ---

  /** Shows (and speaks) a message the agent starts. Same text from the same source within 10 minutes is dropped. */
  private async notify(text: string, source: string, extra: { changes?: NoteChange[]; speak?: boolean } = {}): Promise<void> {
    const clean = text.trim();
    if (!clean || !this.running) return;
    const prev = this.lastDelivered.get(source);
    if (prev && prev.text === clean && Date.now() - prev.at < DEDUP_MS) return;
    this.lastDelivered.set(source, { text: clean, at: Date.now() });
    await this.record('outgoing', clean);
    this.deliver({ text: clean, source, ...(extra.changes?.length ? { changes: extra.changes } : {}), ...(extra.speak === false ? { speak: false } : {}) });
  }

  private async record(direction: 'incoming' | 'outgoing', text: string, spoken = false): Promise<void> {
    await this.store.storeMessage({
      id: randomUUID(),
      channel: spoken ? 'voice' : 'text',
      direction,
      text,
      timestamp: new Date(),
      wasVoiceNote: spoken,
      replied: false,
    });
  }

  // --- context ---

  private async getContext(): Promise<ContextData> {
    try {
      const moved = autoMoveCompletedToDone(this.vaultPath);
      if (moved.length) logger.info(`Moved completed cards to Done: ${moved.join(', ')}`);
    } catch (err) {
      logger.error('Auto-move completed cards failed', err);
    }
    this.config = loadAgentConfig(agentDir(this.vaultPath));
    return assembleContext(this.vaultPath, this.config, this.store, { weather: this.settings.weather, http: this.http });
  }

  private async signals(context: ContextData) {
    const history = await this.store.getMessages(20, new Date(Date.now() - 24 * 60 * 60 * 1000));
    return detectSignals(context.vault, history, {} as never, {} as never);
  }

  private async isPaused(): Promise<boolean> {
    return (await this.store.getSessionState('agent_paused')) === '1';
  }

  isQuietHours(now = new Date()): boolean {
    const tz = toIanaZone(this.config.userMeta.timezone);
    const local = new Date(now.toLocaleString('en-US', { timeZone: tz }));
    const current = local.getHours() * 60 + local.getMinutes();
    const toMin = (s: string) => {
      const [h, m] = s.split(':').map(Number);
      return (h || 0) * 60 + (m || 0);
    };
    const start = toMin(this.config.userMeta.quietHoursStart);
    const end = toMin(this.config.userMeta.quietHoursEnd);
    if (start === end) return false;
    return start < end ? current >= start && current < end : current >= start || current < end;
  }

  private async scheduleAdaptivePulse(context: ContextData, lastReplyTimeMs: number): Promise<void> {
    if (!this.settings.pulses || !this.running) return;
    const next = calculateNextPulse(
      { baseIntervalMinutes: this.config.userMeta.pulseIntervalMinutes, minIntervalMinutes: 30, maxIntervalMinutes: 180, backoffAfterIgnored: 3 },
      {
        lastReplyTimeMs,
        hoursSinceLastReply: 0,
        tasksDueToday: context.vault.dueSoon.length,
        inMeetingNow: false,
        consecutiveIgnoredPulses: await this.store.getConsecutiveIgnoredPulses(),
        inQuietHours: this.isQuietHours(),
        onboardingComplete: true,
        activeSessions: [],
      },
    );
    if (next) schedulePulse(next, () => this.runPulse());
  }

  /** Re-arms the pulse loop if it went idle (after quiet hours, a backoff, a failure). */
  private startWatchdog(): void {
    const tick = async () => {
      try {
        if (!this.settings.pulses || arePulsesSuppressed() || isPulseScheduled() || this.isQuietHours()) return;
        if (await this.isPaused()) return;
        if ((await this.store.getConsecutiveIgnoredPulses()) >= 3) return;
        await this.scheduleAdaptivePulse(await this.getContext(), Number.MAX_SAFE_INTEGER);
      } catch (err) {
        logger.error('Watchdog tick failed', err);
      }
    };
    this.watchdogTimer = window.setInterval(() => void tick(), 5 * 60 * 1000);
  }

  // --- kanban focus tracking ---

  private readBoard() {
    const file = boardFile(this.vaultPath);
    return existsSync(file) ? parseInboxKanban(readFileSync(file, 'utf-8')) : null;
  }

  private startKanbanPoll(): void {
    const board = this.readBoard();
    const initial = (board?.columns['Doing'] || []).map(t => t.rawLine || t.text);
    void this.store.setSessionState('kanban_doing_snapshot', JSON.stringify(initial));
    this.kanbanTimer = window.setInterval(() => void this.pollKanban(), 2 * 60 * 1000);
  }

  /** Diffs the Doing column against the last poll. Public for tests. */
  async pollKanban(): Promise<void> {
    try {
      if (await this.isPaused()) return;
      if (this.isQuietHours()) return;
      // Heal first: a card ticked done in Doing must land in Done so the diff
      // sees it leave Doing and credits its focus session.
      autoMoveCompletedToDone(this.vaultPath);
      const board = this.readBoard();
      if (!board) return;
      const doing = board.columns['Doing'] || [];
      const currentLines = doing.map(t => t.rawLine || t.text);
      const prevLines = asArray(parseJson((await this.store.getSessionState('kanban_doing_snapshot')) ?? '[]'))
        .filter((l): l is string => typeof l === 'string');
      const diff = this.focus.diffDoingTasks(prevLines, currentLines);
      await this.store.setSessionState('kanban_doing_snapshot', JSON.stringify(currentLines));

      for (const removedLine of diff.removed) {
        const sessions = await this.store.getActiveSessions();
        const removedId = extractCardId(removedLine);
        const match = sessions.find(s => (removedId && s.cardId === removedId) || s.rawTaskLine === removedLine);
        if (!match) {
          const awaiting = this.focus.getAwaitingEstimate();
          if (awaiting && ((removedId && awaiting.cardId === removedId) || awaiting.rawLine === removedLine)) {
            this.focus.clearAwaitingEstimate();
          }
          continue;
        }
        const location = locateRemovedCard(board, removedLine);
        if (location.column === 'Done') {
          await this.focus.completeSession(match.id);
          const actual = Math.round((Date.now() - new Date(match.startedAt).getTime()) / 60000);
          await this.notify(`Completed "${match.taskText}" in ${actual} minutes (estimated ${match.estimatedMinutes}).`, 'focus-nudge');
        } else if (location.task?.pausedNote) {
          await this.focus.parkSession(match.id, location.task.pausedNote);
          await this.notify(`Parked "${match.taskText}": ${location.task.pausedNote}. Timer stopped.`, 'focus-nudge');
        } else if (location.column) {
          await this.focus.cancelSession(match.id);
          await this.notify(`Moved "${match.taskText}" back to ${location.column}. Timer cancelled.`, 'focus-nudge');
        } else {
          await this.focus.cancelSession(match.id);
        }
        await this.focus.scheduleIdlePulse((t, s) => this.notify(t, s ?? 'idle-pulse'), () => this.getContext());
      }

      // Cards stuck in Doing for a week go back to Backlog.
      for (const task of doing) {
        if (!task.id) continue;
        const firstSeen = await this.store.getTaskFirstSeen(task.id, 'Doing');
        if (!firstSeen) continue;
        const days = Math.floor((Date.now() - new Date(firstSeen).getTime()) / 86400000);
        if (days < 7) continue;
        mutateKanban(this.vaultPath, [{ type: 'move', task: task.text, fromColumn: 'Doing', toColumn: 'Backlog' }]);
        const after = this.readBoard();
        if ((after?.columns['Doing'] || []).some(t => t.text === task.text)) {
          logger.error(`Stuck-task move did not persist for "${task.text}"`);
          continue;
        }
        await this.notify(`"${task.text}" has been in Doing for ${days} days. Moved it to Backlog. Bring it back with a plan if it still matters.`, 'stuck-task');
      }

      for (const addedLine of diff.added) {
        const task = doing.find(t => (t.rawLine || t.text) === addedLine);
        if (!task) continue;
        const guard = checkGuard(await this.store.getActiveSessions());
        if (guard.action === 'block') {
          await this.notify(guard.message, 'wip-guard');
          continue;
        }
        if (guard.action === 'warn') {
          await this.store.recordWipOverride();
          await this.notify(guard.message, 'wip-guard');
          const week = await this.store.getWipOverridesThisWeek();
          if (week >= 3) await this.notify(`That's ${week} WIP overrides this week. Raise the limit, or are you overloaded?`, 'wip-guard');
        }
        this.focus.setAwaitingEstimate(addedLine, task.text, task.id);
        await this.notify(`Starting "${task.text}". How long do you think it'll take?`, 'task-start');
      }
    } catch (err) {
      logger.error('Kanban poll error', err);
    }
  }
}
