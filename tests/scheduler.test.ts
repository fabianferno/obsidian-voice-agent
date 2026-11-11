import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  schedulePulse, isPulseScheduled, suppressPulses, resumePulses, calculateNextPulse,
  msUntil, missedCheckpoint, parseTime, startCheckpoints, DEFAULT_CHECKPOINT_TIMES,
} from '../src/checkins/scheduler.js';
import type { AdaptiveConfig, AgentState } from '../src/config/types.js';

const noop = async () => undefined;

function arm(delay = 60) {
  schedulePulse(delay, noop);
}

afterEach(() => {
  suppressPulses(); // clears any pending timer
  resumePulses();
});

describe('pulse liveness', () => {
  it('reports a pulse as scheduled once armed', () => {
    resumePulses();
    expect(isPulseScheduled()).toBe(false);
    arm();
    expect(isPulseScheduled()).toBe(true);
  });

  it('suppressPulses clears the pending pulse', () => {
    resumePulses();
    arm();
    expect(isPulseScheduled()).toBe(true);
    suppressPulses();
    expect(isPulseScheduled()).toBe(false);
  });

  it('does not arm a pulse while suppressed', () => {
    suppressPulses();
    arm();
    expect(isPulseScheduled()).toBe(false);
    resumePulses();
  });

  it('reports idle after the timer fires (so the watchdog can re-arm)', () => {
    vi.useFakeTimers();
    try {
      resumePulses();
      arm(1);
      expect(isPulseScheduled()).toBe(true);
      vi.advanceTimersByTime(60 * 1000 + 1); // fire the one-shot timer
      expect(isPulseScheduled()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('calculateNextPulse gates', () => {
  const base: AdaptiveConfig = { baseIntervalMinutes: 60, minIntervalMinutes: 30, maxIntervalMinutes: 180, backoffAfterIgnored: 3 };
  const state = (o: Partial<AgentState>): AgentState => ({
    lastReplyTimeMs: 10 * 60 * 1000, hoursSinceLastReply: 0, tasksDueToday: 0,
    inMeetingNow: false, consecutiveIgnoredPulses: 0, inQuietHours: false,
    onboardingComplete: true, activeSessions: [], ...o,
  });

  it('returns null in a meeting and in quiet hours', () => {
    expect(calculateNextPulse(base, state({ inMeetingNow: true }))).toBeNull();
    expect(calculateNextPulse(base, state({ inQuietHours: true }))).toBeNull();
  });

  it('returns a clamped interval otherwise', () => {
    const v = calculateNextPulse(base, state({}));
    expect(v).toBeGreaterThanOrEqual(base.minIntervalMinutes);
    expect(v).toBeLessThanOrEqual(base.maxIntervalMinutes);
  });
});

describe('checkpoint times', () => {
  const at = (h: number, m: number) => new Date(2026, 10, 10, h, m, 0, 0);

  it('parses HH:MM and rejects junk', () => {
    expect(parseTime('08:05')).toEqual({ h: 8, m: 5 });
    expect(parseTime('8:30')).toEqual({ h: 8, m: 30 });
    expect(parseTime('25:00')).toBeNull();
    expect(parseTime('')).toBeNull();
  });

  it('counts down to later today, or to tomorrow once passed', () => {
    expect(msUntil('08:00', at(7, 0))).toBe(60 * 60 * 1000);
    expect(msUntil('08:00', at(8, 0))).toBe(24 * 60 * 60 * 1000);
    expect(msUntil('off', at(8, 0))).toBeNull();
  });

  it('catches up only the latest missed checkpoint of today', () => {
    expect(missedCheckpoint(DEFAULT_CHECKPOINT_TIMES, {}, at(7, 0))).toBeNull();
    expect(missedCheckpoint(DEFAULT_CHECKPOINT_TIMES, {}, at(9, 0))).toBe('morning_checkpoint');
    expect(missedCheckpoint(DEFAULT_CHECKPOINT_TIMES, {}, at(21, 0))).toBe('evening_checkpoint');
    expect(missedCheckpoint(DEFAULT_CHECKPOINT_TIMES, { evening_checkpoint: '2026-11-10' }, at(21, 0))).toBeNull();
    // Ran yesterday: still missed today.
    expect(missedCheckpoint(DEFAULT_CHECKPOINT_TIMES, { morning_checkpoint: '2026-11-09' }, at(9, 0))).toBe('morning_checkpoint');
  });

  it('skips disabled checkpoints', () => {
    expect(missedCheckpoint({ morning: '', midday: '', evening: '20:00' }, {}, at(14, 0))).toBeNull();
  });

  it('fires a checkpoint at its time and re-arms for the next day', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(at(7, 59));
      const fired: string[] = [];
      const stop = startCheckpoints({ morning: '08:00', midday: '', evening: '' }, async k => { fired.push(k); });
      await vi.advanceTimersByTimeAsync(60 * 1000);
      expect(fired).toEqual(['morning_checkpoint']);
      await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
      expect(fired).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
      expect(fired).toHaveLength(2);
      stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
