// store/store.ts - the agent's small local state, kept as one JSON document.
//
// Replaces the old MongoDB store. Everything here is small (session flags, focus
// sessions, first-seen dates for cards, a capped message log), so it lives in
// memory and is written out through `persist` after each change. The plugin
// passes a persist function that writes the plugin's data file; tests pass none.

import type { FocusSession, StoredMessage } from '../config/types.js';

export interface StoreData {
  version: 1;
  sessionState: Record<string, string>;
  /** `${cardId}:${column}` -> YYYY-MM-DD the card was first seen there. */
  taskFirstSeen: Record<string, string>;
  focusSessions: FocusSession[];
  focusSeq: number;
  messages: Array<Omit<StoredMessage, 'timestamp'> & { timestamp: string }>;
  wipOverrides: string[]; // ISO timestamps
  workouts: string[]; // YYYY-MM-DD
}

const MAX_MESSAGES = 200;
const MAX_FIRST_SEEN = 2000;

export function emptyStoreData(): StoreData {
  return {
    version: 1,
    sessionState: {},
    taskFirstSeen: {},
    focusSessions: [],
    focusSeq: 0,
    messages: [],
    wipOverrides: [],
    workouts: [],
  };
}

function weekStart(d: Date): string {
  const monday = new Date(d);
  monday.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return monday.toISOString().split('T')[0];
}

export class Store {
  private data: StoreData;

  constructor(
    initial?: Partial<StoreData> | null,
    private readonly persist?: (data: StoreData) => void | Promise<void>,
  ) {
    this.data = { ...emptyStoreData(), ...(initial ?? {}) };
  }

  /** A copy of everything, for saving. */
  snapshot(): StoreData {
    return JSON.parse(JSON.stringify(this.data)) as StoreData;
  }

  private async save(): Promise<void> {
    await this.persist?.(this.snapshot());
  }

  // --- session state (small string flags) ---

  async getSessionState(key: string): Promise<string | null> {
    const v = this.data.sessionState[key];
    return v === undefined || v === '' ? null : v;
  }

  async setSessionState(key: string, value: string): Promise<void> {
    if (value === '') delete this.data.sessionState[key];
    else this.data.sessionState[key] = value;
    await this.save();
  }

  // --- messages (capped log, newest last on disk) ---

  async storeMessage(msg: Omit<StoredMessage, 'replyTimeMs'> & { replyTimeMs?: number }): Promise<void> {
    this.data.messages.push({ ...msg, timestamp: msg.timestamp.toISOString() });
    if (this.data.messages.length > MAX_MESSAGES) {
      this.data.messages.splice(0, this.data.messages.length - MAX_MESSAGES);
    }
    await this.save();
  }

  async clearMessages(): Promise<void> {
    this.data.messages = [];
    await this.save();
  }

  /** Newest first, like the old store. */
  async getMessages(limit: number, since?: Date): Promise<StoredMessage[]> {
    const sinceMs = since?.getTime() ?? 0;
    return this.data.messages
      .map((m) => ({ ...m, timestamp: new Date(m.timestamp) }))
      .filter((m) => m.timestamp.getTime() >= sinceMs)
      .reverse()
      .slice(0, limit);
  }

  /** Outgoing messages since the user last said anything. */
  async getConsecutiveIgnoredPulses(): Promise<number> {
    let count = 0;
    for (let i = this.data.messages.length - 1; i >= 0 && count < 30; i--) {
      if (this.data.messages[i].direction === 'incoming') break;
      count++;
    }
    return count;
  }

  // --- card first-seen dates (stuck and done-today detection) ---

  async trackTaskFirstSeen(cardId: string, column: string, date: string): Promise<void> {
    const key = `${cardId}:${column}`;
    if (this.data.taskFirstSeen[key]) return;
    this.data.taskFirstSeen[key] = date;
    const keys = Object.keys(this.data.taskFirstSeen);
    if (keys.length > MAX_FIRST_SEEN) {
      // Oldest dates go first; they belong to cards long gone from the board.
      keys
        .sort((a, b) => this.data.taskFirstSeen[a].localeCompare(this.data.taskFirstSeen[b]))
        .slice(0, keys.length - MAX_FIRST_SEEN)
        .forEach((k) => delete this.data.taskFirstSeen[k]);
    }
    await this.save();
  }

  async getTaskFirstSeen(cardId: string, column: string): Promise<string | null> {
    return this.data.taskFirstSeen[`${cardId}:${column}`] ?? null;
  }

  // --- focus sessions ---

  async createFocusSession(session: {
    taskText: string;
    rawTaskLine: string;
    cardId?: string;
    estimatedMinutes: number;
    estimateSource: 'user' | 'llm';
    startedAt: string;
    deadlineAt: string;
  }): Promise<number> {
    const id = ++this.data.focusSeq;
    this.data.focusSessions.push({ id, ...session, escalationLevel: 0, status: 'active' });
    // Keep a few weeks of finished sessions; drop older ones.
    const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    this.data.focusSessions = this.data.focusSessions.filter(
      (s) => s.status === 'active' || (s.completedAt ?? s.startedAt) >= cutoff,
    );
    await this.save();
    return id;
  }

  async getActiveSessions(): Promise<FocusSession[]> {
    return this.data.focusSessions.filter((s) => s.status === 'active').map((s) => ({ ...s }));
  }

  async updateFocusSession(
    id: number,
    updates: Partial<Pick<FocusSession, 'escalationLevel' | 'status' | 'actualMinutes' | 'pausedNote' | 'completedAt' | 'deadlineAt' | 'estimatedMinutes'>>,
  ): Promise<void> {
    const s = this.data.focusSessions.find((x) => x.id === id);
    if (!s) return;
    for (const [k, v] of Object.entries(updates)) {
      if (v !== undefined) (s as unknown as Record<string, unknown>)[k] = v;
    }
    await this.save();
  }

  async getCompletedSessions(since: string): Promise<FocusSession[]> {
    return this.data.focusSessions
      .filter((s) => s.status === 'completed' && (s.completedAt ?? '') >= since)
      .sort((a, b) => (a.completedAt ?? '').localeCompare(b.completedAt ?? ''))
      .map((s) => ({ ...s }));
  }

  // --- WIP overrides ---

  async recordWipOverride(): Promise<void> {
    this.data.wipOverrides.push(new Date().toISOString());
    const monthAgo = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();
    this.data.wipOverrides = this.data.wipOverrides.filter((t) => t >= monthAgo);
    await this.save();
  }

  async getWipOverridesThisWeek(): Promise<number> {
    const start = weekStart(new Date());
    return this.data.wipOverrides.filter((t) => weekStart(new Date(t)) === start).length;
  }

  // --- workouts ---

  async trackWorkout(date: string): Promise<void> {
    if (this.data.workouts.includes(date)) return;
    this.data.workouts.push(date);
    this.data.workouts = this.data.workouts.sort().slice(-60);
    await this.save();
  }

  /** Consecutive days with a workout, counting back from today (or yesterday if today has none yet). */
  async getWorkoutStreak(now = new Date()): Promise<number> {
    const days = new Set(this.data.workouts);
    const iso = (offset: number) => new Date(now.getTime() - offset * 86400000).toISOString().split('T')[0];
    const start = days.has(iso(0)) ? 0 : 1;
    let streak = 0;
    for (let i = start; i < start + 60 && days.has(iso(i)); i++) streak++;
    return streak;
  }
}
