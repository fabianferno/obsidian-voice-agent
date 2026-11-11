import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FocusTracker, locateRemovedCard } from '../src/focus/tracker.js';
import { parseInboxKanban } from '../src/vault/parser.js';
import type { Store } from '../src/store/store.js';

// In-memory fake Store implementing only the methods FocusTracker uses.
// The real Store constructs a MongoClient; tests must not touch a live DB.
class FakeStore {
  private sessions: any[] = [];
  private seq = 0;

  async createFocusSession(s: {
    taskText: string; rawTaskLine: string; cardId?: string;
    estimatedMinutes: number; estimateSource: 'user' | 'llm';
    startedAt: string; deadlineAt: string;
  }): Promise<number> {
    const id = ++this.seq;
    this.sessions.push({
      id, taskText: s.taskText, rawTaskLine: s.rawTaskLine, cardId: s.cardId,
      estimatedMinutes: s.estimatedMinutes, estimateSource: s.estimateSource,
      startedAt: s.startedAt, deadlineAt: s.deadlineAt,
      escalationLevel: 0, status: 'active',
    });
    return id;
  }

  async getActiveSessions(): Promise<any[]> {
    return this.sessions.filter(s => s.status === 'active').map(s => ({ ...s }));
  }

  async updateFocusSession(id: number, updates: Record<string, unknown>): Promise<void> {
    const s = this.sessions.find(x => x.id === id);
    if (s) Object.assign(s, updates);
  }

  async getSessionState(_key: string): Promise<string | null> {
    return null;
  }

  allSessions(): any[] {
    return this.sessions.map(s => ({ ...s }));
  }
}

describe('FocusTracker', () => {
  let store: FakeStore;
  let tracker: FocusTracker;
  const mockSendMessage = vi.fn().mockResolvedValue(undefined);
  const mockGetContext = vi.fn();

  beforeEach(() => {
    store = new FakeStore();
    tracker = new FocusTracker(store as unknown as Store, mockSendMessage, mockGetContext);
    mockSendMessage.mockClear();
    mockGetContext.mockClear();
  });

  describe('startSession', () => {
    it('creates a session in the database', async () => {
      await tracker.startSession('Build landing page', '- [ ] Build landing page', 120, 'user');
      const sessions = await store.getActiveSessions();
      expect(sessions).toHaveLength(1);
      expect(sessions[0].taskText).toBe('Build landing page');
      expect(sessions[0].estimatedMinutes).toBe(120);
    });

    it('threads the card id onto the session', async () => {
      await tracker.startSession('Task', '- [ ] Task ^abc123', 60, 'user', 'abc123');
      const [session] = await store.getActiveSessions();
      expect(session.cardId).toBe('abc123');
    });

    it('schedules a timer for the deadline', async () => {
      vi.useFakeTimers();
      await tracker.startSession('Quick fix', '- [ ] Quick fix', 30, 'user');
      expect(tracker.getActiveTimerCount()).toBe(1);
      vi.useRealTimers();
    });
  });

  describe('completeSession', () => {
    it('marks session as completed with actual minutes', async () => {
      await tracker.startSession('Task', '- [ ] Task', 60, 'user');
      const [session] = await store.getActiveSessions();
      await tracker.completeSession(session.id);
      expect(await store.getActiveSessions()).toHaveLength(0);
    });

    it('clears the timer', async () => {
      vi.useFakeTimers();
      await tracker.startSession('Task', '- [ ] Task', 60, 'user');
      const [session] = await store.getActiveSessions();
      await tracker.completeSession(session.id);
      expect(tracker.getActiveTimerCount()).toBe(0);
      vi.useRealTimers();
    });
  });

  describe('cancelSession', () => {
    it('ends the session without marking it completed', async () => {
      await tracker.startSession('Call Sham', '- [ ] Call Sham ^ab12cd', 60, 'llm', 'ab12cd');
      const [session] = await store.getActiveSessions();
      await tracker.cancelSession(session.id);

      expect(await store.getActiveSessions()).toHaveLength(0);
      const [stored] = store.allSessions();
      expect(stored.status).toBe('cancelled');
    });

    it('clears the timer', async () => {
      vi.useFakeTimers();
      await tracker.startSession('Task', '- [ ] Task', 60, 'user');
      const [session] = await store.getActiveSessions();
      await tracker.cancelSession(session.id);
      expect(tracker.getActiveTimerCount()).toBe(0);
      vi.useRealTimers();
    });
  });

  describe('parkSession', () => {
    it('marks session as parked with note', async () => {
      await tracker.startSession('Task', '- [ ] Task', 60, 'user');
      const [session] = await store.getActiveSessions();
      await tracker.parkSession(session.id, 'halfway through API');
      expect(await store.getActiveSessions()).toHaveLength(0);
    });
  });

  describe('escalation', () => {
    it('increments escalation level on nudge', async () => {
      vi.useFakeTimers();
      await tracker.startSession('Task', '- [ ] Task', 1, 'user'); // 1 min
      await vi.advanceTimersByTimeAsync(1 * 60 * 1000 + 100);
      const [session] = await store.getActiveSessions();
      expect(session.escalationLevel).toBe(1);
      expect(mockSendMessage).toHaveBeenCalledTimes(1);
      vi.useRealTimers();
    });
  });

  describe('diffDoingTasks', () => {
    it('detects new tasks', () => {
      const diff = tracker.diffDoingTasks(['Task A'], ['Task A', 'Task B']);
      expect(diff.added).toEqual(['Task B']);
      expect(diff.removed).toEqual([]);
    });

    it('detects removed tasks', () => {
      const diff = tracker.diffDoingTasks(['Task A', 'Task B'], ['Task A']);
      expect(diff.added).toEqual([]);
      expect(diff.removed).toEqual(['Task B']);
    });

    it('treats similar edits as same task', () => {
      const diff = tracker.diffDoingTasks(['Build landing page'], ['Build landing page for DrawFi']);
      expect(diff.added).toEqual([]);
      expect(diff.removed).toEqual([]);
      expect(diff.edited).toHaveLength(1);
    });
  });

  describe('awaitingEstimate', () => {
    it('tracks awaiting state', () => {
      vi.useFakeTimers();
      tracker.setAwaitingEstimate('- [ ] Task', 'Task');
      const awaiting = tracker.getAwaitingEstimate();
      expect(awaiting).not.toBeNull();
      expect(awaiting!.taskText).toBe('Task');
      expect(awaiting!.reprompted).toBe(false);
      vi.useRealTimers();
    });

    it('carries the card id through awaiting state', () => {
      vi.useFakeTimers();
      tracker.setAwaitingEstimate('- [ ] Task ^abc123', 'Task', 'abc123');
      expect(tracker.getAwaitingEstimate()!.cardId).toBe('abc123');
      vi.useRealTimers();
    });

    it('marks reprompted', () => {
      vi.useFakeTimers();
      tracker.setAwaitingEstimate('- [ ] Task', 'Task');
      tracker.markReprompted();
      expect(tracker.getAwaitingEstimate()!.reprompted).toBe(true);
      vi.useRealTimers();
    });

    it('clears awaiting state', () => {
      vi.useFakeTimers();
      tracker.setAwaitingEstimate('- [ ] Task', 'Task');
      tracker.clearAwaitingEstimate();
      expect(tracker.getAwaitingEstimate()).toBeNull();
      vi.useRealTimers();
    });
  });
});

describe('locateRemovedCard', () => {
  // A card leaving Doing tells us nothing on its own; where it landed does.
  const board = (body: string) => parseInboxKanban(body);

  const BOARD = board(`## Backlog

- [ ] Read the Bedrock docs ^bb11aa

## To Do

- [ ] Call Sham @{2026-07-15} ^cc33dd

## Doing

- [ ] Buy a Formal Shirt and Pant ^ee55ff

## Done

- [x] Ship the calendar sync ^aa99bb

## Parked

- [ ] Rewrite the estimator — paused: waiting on Sham ^dd77ee
`);

  it('follows a card by id even when its text changed in the same move', () => {
    // "Call Sham" moved Doing -> To Do and picked up a new due date.
    const loc = locateRemovedCard(BOARD, 'Call Sham @{2026-07-14} ^cc33dd');
    expect(loc.column).toBe('To Do');
  });

  it('finds a card that landed in Done', () => {
    const loc = locateRemovedCard(BOARD, 'Ship the calendar sync ^aa99bb');
    expect(loc.column).toBe('Done');
  });

  it('finds a card that landed in Parked and carries its pause note', () => {
    const loc = locateRemovedCard(BOARD, 'Rewrite the estimator ^dd77ee');
    expect(loc.column).toBe('Parked');
    expect(loc.task?.pausedNote).toBe('waiting on Sham');
  });

  it('reports a deleted card as off the board', () => {
    expect(locateRemovedCard(BOARD, 'Some card nobody kept ^ff00aa').column).toBeNull();
  });

  it('does not confuse a same-titled card that carries a different id', () => {
    expect(locateRemovedCard(BOARD, 'Call Sham @{2026-07-14} ^999999').column).toBeNull();
  });

  it('falls back to fuzzy title match for id-less cards', () => {
    const idless = board(`## To Do

- [ ] Call Sham about the roof quote

## Doing
`);
    expect(locateRemovedCard(idless, 'Call Sham about the roof quotes').column).toBe('To Do');
  });

  it('ignores cards still sitting in Doing', () => {
    expect(locateRemovedCard(BOARD, 'Buy a Formal Shirt and Pant ^ee55ff').column).toBeNull();
  });
});
