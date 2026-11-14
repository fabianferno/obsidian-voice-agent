import { describe, expect, it } from 'vitest';
import { buildTurn } from '../src/brain/prompt-builder.js';
import type { AgentConfig, ContextData, VaultStateContext } from '../src/config/types.js';

const vault: VaultStateContext = {
  backlogCount: 0, todoCount: 0, todoTasks: [], doingCount: 0, doingTasks: [],
  doneToday: [], overdueTasks: [], dueSoon: [], stuckTasks: [],
  currentStreak: { workout: 0 }, wipWarning: false, peopleNotes: [],
};

const location = { city: 'Chennai', country: 'IN', timezone: 'Asia/Kolkata', coordinates: { lat: 0, lng: 0 }, isTravelling: false };

const context = (v: VaultStateContext): ContextData => ({
  datetime: { now: '10:00', dayOfWeek: 'Saturday', timeOfDay: 'morning', isWeekend: true, daysUntilWeekend: 0 },
  weather: null, calendar: null, health: null, location, vault: v,
});

const config = { soul: '', identity: '', user: '', goals: '', memory: [] } as unknown as AgentConfig;

describe('buildTurn board section', () => {
  it('lists columns when the board exists', () => {
    const text = buildTurn('reply', config, context(vault), []);
    expect(text).toContain('- To Do: 0 (empty)');
    expect(text).not.toContain('NOT FOUND');
  });

  it('says the board is missing instead of empty when the file does not exist', () => {
    const text = buildTurn('reply', config, context({ ...vault, boardMissing: 'Kanban.md' }), []);
    expect(text).toContain('no board file at "Kanban.md"');
    expect(text).not.toContain('- To Do: 0 (empty)');
  });
});
