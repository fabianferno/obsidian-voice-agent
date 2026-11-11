import { describe, it, expect } from 'vitest';
import { scorePriority } from '../src/brain/priority.js';
import type { Task, VaultStateContext } from '../src/config/types.js';

const baseVault: VaultStateContext = {
  backlogCount: 0, todoCount: 0, doingCount: 1,
  doingTasks: [{ text: 'Ship Acme v2', completed: false, column: 'Doing', wikilinks: [], urls: [] }],
  doneToday: [], overdueTasks: [], dueSoon: [], stuckTasks: [],
  currentStreak: { workout: 0 }, wipWarning: false,
  peopleNotes: [],
};

const goals = '## This quarter\n- [ ] Ship Acme v2\n- [ ] Win 2 hackathons';

describe('scorePriority', () => {
  it('scores overdue tasks highest', () => {
    const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];
    const task: Task = { text: 'Fix bug', completed: false, column: 'To Do', dueDate: yesterday, wikilinks: [], urls: [] };
    const score = scorePriority(task, goals, baseVault);
    expect(score.score).toBeGreaterThanOrEqual(30);
    expect(score.reasons.some(r => r.includes('Overdue'))).toBe(true);
  });

  it('scores goal-aligned tasks higher', () => {
    const task: Task = { text: 'Ship Acme v2 dashboard', completed: false, column: 'To Do', wikilinks: [], urls: [] };
    const score = scorePriority(task, goals, baseVault);
    expect(score.score).toBeGreaterThanOrEqual(25);
  });

  it('scores context-grouped tasks', () => {
    const task: Task = { text: 'Acme v2 API fix', completed: false, column: 'To Do', wikilinks: [], urls: [] };
    const score = scorePriority(task, goals, baseVault);
    expect(score.reasons.some(r => r.includes('Related to current focus'))).toBe(true);
  });

  it('returns zero for tasks with no signals', () => {
    const task: Task = { text: 'Random unrelated thing', completed: false, column: 'Backlog', wikilinks: [], urls: [] };
    const score = scorePriority(task, goals, { ...baseVault, doingTasks: [] });
    expect(score.score).toBe(0);
  });
});
