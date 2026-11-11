import { describe, it, expect } from 'vitest';
import { checkGuard } from '../src/focus/guard.js';
import type { FocusSession } from '../src/config/types.js';

const makeSession = (overrides: Partial<FocusSession> = {}): FocusSession => ({
  id: 1,
  taskText: 'Test task',
  rawTaskLine: '- [ ] Test task',
  estimatedMinutes: 60,
  estimateSource: 'user',
  startedAt: '2026-03-25T08:00:00Z',
  deadlineAt: '2026-03-25T09:00:00Z',
  escalationLevel: 0,
  status: 'active',
  ...overrides,
});

describe('checkGuard', () => {
  it('allows when 0 active sessions', () => {
    const result = checkGuard([]);
    expect(result.action).toBe('allow');
  });

  it('warns when 1 active session', () => {
    const sessions = [makeSession({ taskText: 'Landing page' })];
    const result = checkGuard(sessions);
    expect(result.action).toBe('warn');
    if (result.action === 'warn') {
      expect(result.message).toContain('Landing page');
    }
  });

  it('blocks when 2 active sessions', () => {
    const sessions = [
      makeSession({ id: 1, taskText: 'Task A' }),
      makeSession({ id: 2, taskText: 'Task B' }),
    ];
    const result = checkGuard(sessions);
    expect(result.action).toBe('block');
    if (result.action === 'block') {
      expect(result.message).toContain('Task A');
      expect(result.message).toContain('Task B');
    }
  });

  it('warn message includes time remaining', () => {
    const sessions = [makeSession({
      taskText: 'Deep work',
      deadlineAt: new Date(Date.now() + 45 * 60 * 1000).toISOString(),
    })];
    const result = checkGuard(sessions);
    if (result.action === 'warn') {
      expect(result.message).toMatch(/\d+min left/);
    }
  });
});
