import type { ContextData, FocusSession, KanbanBoard, SendMessageFn, Task } from '../config/types.js';
import type { Store } from '../store/store.js';
import { suppressPulses, resumePulses } from '../checkins/scheduler.js';
import { createLogger } from '../utils/logger.js';
import { formatDuration } from '../utils/format.js';

const logger = createLogger('focus-tracker');

export interface DoingDiff {
  added: string[];
  removed: string[];
  edited: { from: string; to: string }[];
}

/** Where a card that left Doing ended up. `column: null` means it is off the board entirely. */
export interface RemovedCardLocation {
  column: string | null;
  task?: Task;
}

export function extractCardId(rawLine: string): string | undefined {
  return rawLine.match(/\s\^([a-z0-9]+)\s*$/)?.[1];
}

/**
 * Find where a card that disappeared from Doing landed. Leaving Doing is not by
 * itself a completion: only landing in Done is. Card id wins over an exact line
 * match, which wins over fuzzy title similarity (the fallback for id-less cards
 * whose text was edited in the same move).
 */
export function locateRemovedCard(board: KanbanBoard, removedLine: string): RemovedCardLocation {
  const removedId = extractCardId(removedLine);
  const elsewhere: { column: string; task: Task }[] = [];
  for (const [column, tasks] of Object.entries(board.columns)) {
    if (column === 'Doing') continue;
    for (const task of tasks) elsewhere.push({ column, task });
  }

  if (removedId) {
    const byId = elsewhere.find(e => e.task.id === removedId);
    if (byId) return { column: byId.column, task: byId.task };
  }

  const byLine = elsewhere.find(e => (e.task.rawLine || e.task.text) === removedLine);
  if (byLine) return { column: byLine.column, task: byLine.task };

  let best: { column: string; task: Task; sim: number } | null = null;
  for (const e of elsewhere) {
    if (e.task.id) continue; // an id-bearing card that did not match above is a different card
    const sim = diceSimilarity(e.task.rawLine || e.task.text, removedLine);
    if (sim > 0.7 && (!best || sim > best.sim)) best = { ...e, sim };
  }
  if (best) return { column: best.column, task: best.task };

  return { column: null };
}

export class FocusTracker {
  private timers = new Map<number, number>();
  private idleTimer: number | null = null;
  private awaitingEstimateMap = new Map<string, { rawLine: string; taskText: string; cardId?: string; timeout: number; reprompted: boolean }>();
  private store: Store;
  private sendMessage: SendMessageFn;
  private getContext: () => Promise<ContextData>;

  constructor(store: Store, sendMessage: SendMessageFn, getContext: () => Promise<ContextData>) {
    this.store = store;
    this.sendMessage = sendMessage;
    this.getContext = getContext;
  }

  async startSession(taskText: string, rawTaskLine: string, estimatedMinutes: number, estimateSource: 'user' | 'llm', cardId?: string): Promise<FocusSession> {
    const now = new Date();
    const deadlineAt = new Date(now.getTime() + estimatedMinutes * 60 * 1000);

    const id = await this.store.createFocusSession({
      taskText,
      rawTaskLine,
      cardId,
      estimatedMinutes,
      estimateSource,
      startedAt: now.toISOString(),
      deadlineAt: deadlineAt.toISOString(),
    });

    const session: FocusSession = {
      id,
      taskText,
      rawTaskLine,
      cardId,
      estimatedMinutes,
      estimateSource,
      startedAt: now.toISOString(),
      deadlineAt: deadlineAt.toISOString(),
      escalationLevel: 0,
      status: 'active',
    };

    this.scheduleNudge(session);
    suppressPulses();
    return session;
  }

  async completeSession(sessionId: number): Promise<void> {
    const sessions = await this.store.getActiveSessions();
    const session = sessions.find(s => s.id === sessionId);
    if (!session) return;

    const actualMinutes = Math.round((Date.now() - new Date(session.startedAt).getTime()) / 60000);
    await this.store.updateFocusSession(sessionId, {
      status: 'completed',
      actualMinutes,
      completedAt: new Date().toISOString(),
    });
    this.clearTimer(sessionId);
    if ((await this.store.getActiveSessions()).length === 0) resumePulses();
  }

  /**
   * End a session without crediting it as work done: the card went back to To Do
   * or Backlog, or was deleted off the board. Kept out of 'completed' so weekly
   * review and estimate history do not count it.
   */
  async cancelSession(sessionId: number): Promise<void> {
    const sessions = await this.store.getActiveSessions();
    const session = sessions.find(s => s.id === sessionId);
    if (!session) return;

    const actualMinutes = Math.round((Date.now() - new Date(session.startedAt).getTime()) / 60000);
    await this.store.updateFocusSession(sessionId, {
      status: 'cancelled',
      actualMinutes,
      completedAt: new Date().toISOString(),
    });
    this.clearTimer(sessionId);
    if ((await this.store.getActiveSessions()).length === 0) resumePulses();
  }

  async parkSession(sessionId: number, note: string): Promise<void> {
    const sessions = await this.store.getActiveSessions();
    const session = sessions.find(s => s.id === sessionId);
    if (!session) return;

    const actualMinutes = Math.round((Date.now() - new Date(session.startedAt).getTime()) / 60000);
    await this.store.updateFocusSession(sessionId, {
      status: 'parked',
      pausedNote: note,
      actualMinutes,
      completedAt: new Date().toISOString(),
    });
    this.clearTimer(sessionId);
    if ((await this.store.getActiveSessions()).length === 0) resumePulses();
  }

  private scheduleNudge(session: FocusSession): void {
    this.clearTimer(session.id);

    if (session.escalationLevel >= 3) {
      logger.info(`Session ${session.id} reached max escalation, backing off`);
      return;
    }

    let delayMs: number;
    if (session.escalationLevel === 0) {
      delayMs = Math.max(0, new Date(session.deadlineAt).getTime() - Date.now());
    } else {
      delayMs = 15 * 60 * 1000; // +15min between escalations
    }

    const fire = async () => {
      this.timers.delete(session.id);
      const level = (session.escalationLevel + 1) as 0 | 1 | 2 | 3;
      await this.store.updateFocusSession(session.id, { escalationLevel: level });

      const totalMinutes = Math.round((Date.now() - new Date(session.startedAt).getTime()) / 60000);
      const messages: Record<number, string> = {
        1: `Time's up on ${session.taskText}. Done, or how much longer?`,
        2: `Still on ${session.taskText}? What's blocking you? Want to scope it down?`,
        3: `You've been on ${session.taskText} for ${formatDuration(totalMinutes)}. Park it and switch, or commit to a finish time?`,
      };

      try {
        await this.sendMessage(messages[level] || '', 'focus-nudge');
      } catch (err) {
        logger.error('Failed to send nudge', err);
      }

      if (level < 3) {
        this.scheduleNudge({ ...session, escalationLevel: level });
      }
    };
    const timer = window.setTimeout(() => void fire(), delayMs);

    this.timers.set(session.id, timer);
  }

  private clearTimer(sessionId: number): void {
    const timer = this.timers.get(sessionId);
    if (timer) {
      window.clearTimeout(timer);
      this.timers.delete(sessionId);
    }
  }

  getActiveTimerCount(): number {
    return this.timers.size;
  }

  /**
   * Clear every pending timer (nudges and awaiting-estimate fallbacks) so a
   * process being torn down for restart cannot fire a message mid-shutdown.
   * Session state stays in the DB and is restored via recoverFromDb() on boot.
   */
  shutdown(): void {
    if (this.idleTimer) window.clearTimeout(this.idleTimer);
    this.idleTimer = null;
    for (const [, timer] of this.timers) window.clearTimeout(timer);
    this.timers.clear();
    for (const [, val] of this.awaitingEstimateMap) window.clearTimeout(val.timeout);
    this.awaitingEstimateMap.clear();
  }

  async recoverFromDb(): Promise<void> {
    const activeSessions = await this.store.getActiveSessions();
    for (const session of activeSessions) {
      if (session.escalationLevel >= 3) continue;
      this.scheduleNudge(session);
    }
    if (activeSessions.length > 0) suppressPulses();
  }

  // Kanban diff
  diffDoingTasks(prev: string[], curr: string[]): DoingDiff {
    const added: string[] = [];
    const removed: string[] = [];
    const edited: { from: string; to: string }[] = [];

    const unmatchedPrev = [...prev];
    const unmatchedCurr = [...curr];

    // Exact matches first
    for (let i = unmatchedCurr.length - 1; i >= 0; i--) {
      const prevIdx = unmatchedPrev.indexOf(unmatchedCurr[i]);
      if (prevIdx !== -1) {
        unmatchedPrev.splice(prevIdx, 1);
        unmatchedCurr.splice(i, 1);
      }
    }

    // Fuzzy match remaining (>70% Dice coefficient)
    for (let i = unmatchedCurr.length - 1; i >= 0; i--) {
      let bestMatch = -1;
      let bestSim = 0;
      for (let j = 0; j < unmatchedPrev.length; j++) {
        const sim = diceSimilarity(unmatchedPrev[j], unmatchedCurr[i]);
        if (sim > 0.7 && sim > bestSim) {
          bestSim = sim;
          bestMatch = j;
        }
      }
      if (bestMatch !== -1) {
        edited.push({ from: unmatchedPrev[bestMatch], to: unmatchedCurr[i] });
        unmatchedPrev.splice(bestMatch, 1);
        unmatchedCurr.splice(i, 1);
      }
    }

    added.push(...unmatchedCurr);
    removed.push(...unmatchedPrev);
    return { added, removed, edited };
  }

  // Awaiting estimate state
  setAwaitingEstimate(rawLine: string, taskText: string, cardId?: string): void {
    for (const [, val] of this.awaitingEstimateMap) window.clearTimeout(val.timeout);
    this.awaitingEstimateMap.clear();

    const fire = async () => {
      this.awaitingEstimateMap.clear();
      try {
        await this.startSession(taskText, rawLine, 60, 'llm', cardId);
        await this.sendMessage(`I'll assume ~60min for ${taskText}. Tell me if that's off.`, 'focus-nudge');
      } catch (err) {
        logger.error('Failed to start the assumed-estimate session', err);
      }
    };
    const timeout = window.setTimeout(() => void fire(), 5 * 60 * 1000);

    this.awaitingEstimateMap.set(rawLine, { rawLine, taskText, cardId, timeout, reprompted: false });
  }

  getAwaitingEstimate(): { rawLine: string; taskText: string; cardId?: string; reprompted: boolean } | null {
    const entry = this.awaitingEstimateMap.entries().next().value;
    if (!entry) return null;
    const val = entry[1];
    return { rawLine: val.rawLine, taskText: val.taskText, cardId: val.cardId, reprompted: val.reprompted };
  }

  markReprompted(): void {
    for (const [key, val] of this.awaitingEstimateMap) {
      this.awaitingEstimateMap.set(key, { ...val, reprompted: true });
    }
  }

  clearAwaitingEstimate(): void {
    for (const [, val] of this.awaitingEstimateMap) window.clearTimeout(val.timeout);
    this.awaitingEstimateMap.clear();
  }

  async scheduleIdlePulse(sendMessage: SendMessageFn, getContext: () => Promise<ContextData>): Promise<void> {
    // Check for break
    const breakUntil = await this.store.getSessionState('break_until');
    if (breakUntil && new Date(breakUntil).getTime() > Date.now()) return;

    if (this.idleTimer) window.clearTimeout(this.idleTimer);
    const fire = async () => {
      this.idleTimer = null;
      if ((await this.store.getActiveSessions()).length > 0) return;

      let message = 'What are you working on next?';
      try {
        const topTask = (await getContext()).vault?.dueSoon?.[0];
        if (topTask) {
          const dueInfo = topTask.dueDate ? ` (due ${topTask.dueDate})` : '';
          message = `What are you working on next? Top suggestion: ${topTask.text}${dueInfo}`;
        }
      } catch (err) {
        logger.warn('Idle pulse could not read the board', err);
      }
      try {
        await sendMessage(message, 'idle-pulse');
      } catch (err) {
        logger.error('Failed to send idle pulse', err);
      }

      resumePulses();
    };
    this.idleTimer = window.setTimeout(() => void fire(), 10 * 60 * 1000);
  }
}

function diceSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const bigrams = (s: string): Set<string> => {
    const set = new Set<string>();
    for (let i = 0; i < s.length - 1; i++) set.add(s.substring(i, i + 2));
    return set;
  };
  const aBigrams = bigrams(a);
  const bBigrams = bigrams(b);
  let intersection = 0;
  for (const bg of aBigrams) {
    if (bBigrams.has(bg)) intersection++;
  }
  return (2 * intersection) / (aBigrams.size + bBigrams.size);
}
