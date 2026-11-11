import { describe, it, expect } from 'vitest';
import { detectSignals } from '../src/brain/signals.js';
import type { VaultStateContext, StoredMessage, HealthContext, CalendarContext } from '../src/config/types.js';

const baseVaultState: VaultStateContext = {
  backlogCount: 0, todoCount: 0, doingCount: 0,
  doingTasks: [], doneToday: [], overdueTasks: [], dueSoon: [],
  stuckTasks: [],
  currentStreak: { workout: 0 }, wipWarning: false,
  peopleNotes: [],
};

const emptyHealth: HealthContext = {
  stepsToday: null, lastWorkout: null, sleepLastNight: null,
  activeCalories: null, heartRateAvg: null, dataFreshness: 'no data',
};

const emptyCalendar: CalendarContext = {
  eventsToday: [], eventsTomorrow: [], nextEvent: null,
  minutesUntilNextEvent: null, freeBlocks: [],
};

describe('detectSignals', () => {
  it('detects task_completed signal', () => {
    const vault = { ...baseVaultState, doneToday: [{ text: 'Ship v2', completed: true, column: 'Done', wikilinks: [], urls: [] }] };
    const signals = detectSignals(vault, [], emptyHealth, emptyCalendar);
    expect(signals.some(s => s.type === 'task_completed')).toBe(true);
  });

  it('detects hackathon_completed signal', () => {
    const vault = { ...baseVaultState, doneToday: [{ text: 'PL Genesis hackathon submission', completed: true, column: 'Done', wikilinks: [], urls: [] }] };
    const signals = detectSignals(vault, [], emptyHealth, emptyCalendar);
    expect(signals.some(s => s.type === 'hackathon_completed')).toBe(true);
  });

  it('detects travelling signal', () => {
    const vault = { ...baseVaultState, location: { city: 'Lisbon', country: 'Portugal', timezone: 'WET', coordinates: { lat: 0, lng: 0 }, isTravelling: true } };
    const signals = detectSignals(vault, [], emptyHealth, emptyCalendar);
    expect(signals.some(s => s.type === 'travelling')).toBe(true);
  });

  it('returns quiet_day when no signals', () => {
    const signals = detectSignals(baseVaultState, [], emptyHealth, emptyCalendar);
    expect(signals).toHaveLength(1);
    expect(signals[0].type).toBe('quiet_day');
  });

  it('sorts by priority descending', () => {
    const vault = {
      ...baseVaultState,
      doneToday: [{ text: 'PL Genesis hackathon', completed: true, column: 'Done', wikilinks: [], urls: [] }],
      location: { city: 'Lisbon', country: 'Portugal', timezone: 'WET', coordinates: { lat: 0, lng: 0 }, isTravelling: true },
    };
    const signals = detectSignals(vault, [], emptyHealth, emptyCalendar);
    for (let i = 1; i < signals.length; i++) {
      expect(signals[i - 1].priority).toBeGreaterThanOrEqual(signals[i].priority);
    }
  });
});
