// checkins/scheduler.ts - when the agent speaks up on its own.
//
// Two kinds of timer:
//   - daily checkpoints (morning, midday, evening) at times from the settings,
//     in this computer's local time;
//   - an adaptive pulse, re-armed after each reply, whose interval stretches or
//     shrinks with how the user is responding (calculateNextPulse).
// Everything runs inside Obsidian, so timers only live while it is open. A
// checkpoint missed while Obsidian was closed runs once on the next open, if it
// is still the same day (see missedCheckpoint).

import type { AdaptiveConfig, AgentState } from '../config/types.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('scheduler');

export type CheckpointKind = 'morning_checkpoint' | 'midday_checkpoint' | 'evening_checkpoint';

/** "HH:MM" in local time; an empty string turns that checkpoint off. */
export interface CheckpointTimes {
  morning: string;
  midday: string;
  evening: string;
}

export const DEFAULT_CHECKPOINT_TIMES: CheckpointTimes = { morning: '08:00', midday: '13:00', evening: '20:00' };

const KIND_BY_KEY: Record<keyof CheckpointTimes, CheckpointKind> = {
  morning: 'morning_checkpoint',
  midday: 'midday_checkpoint',
  evening: 'evening_checkpoint',
};

// --- adaptive pulse ---

let pulseTimer: number | null = null;
let pulsesSuppressed = false;

export function suppressPulses(): void {
  if (pulseTimer) {
    window.clearTimeout(pulseTimer);
    pulseTimer = null;
  }
  pulsesSuppressed = true;
}

export function resumePulses(): void {
  pulsesSuppressed = false;
}

export function arePulsesSuppressed(): boolean {
  return pulsesSuppressed;
}

/** Is a pulse armed and waiting? The watchdog re-arms the loop when it is not. */
export function isPulseScheduled(): boolean {
  return pulseTimer !== null && !pulsesSuppressed;
}

export function cancelPulse(): void {
  if (pulseTimer) window.clearTimeout(pulseTimer);
  pulseTimer = null;
}

export function calculateNextPulse(config: AdaptiveConfig, state: AgentState): number | null {
  let interval = config.baseIntervalMinutes;

  // Responsive user -> space out
  if (state.lastReplyTimeMs < 2 * 60 * 1000) interval *= 1.5;
  // Silent for 3+ hours -> check sooner
  if (state.hoursSinceLastReply > 3) interval *= 0.5;
  // Deadline today -> more frequent
  if (state.tasksDueToday > 0) interval *= 0.7;
  // In a meeting -> skip
  if (state.inMeetingNow) return null;
  // Ignored 3+ pulses -> back off
  if (state.consecutiveIgnoredPulses >= config.backoffAfterIgnored) return null;
  // Quiet hours -> wait for the watchdog after they end
  if (state.inQuietHours) return null;

  return Math.max(config.minIntervalMinutes, Math.min(interval, config.maxIntervalMinutes));
}

export function schedulePulse(delayMinutes: number, run: () => Promise<void>): void {
  if (pulsesSuppressed) return;
  if (pulseTimer) window.clearTimeout(pulseTimer);
  const fire = async () => {
    // Fired: no longer pending, so isPulseScheduled() reports idle.
    pulseTimer = null;
    if (pulsesSuppressed) return;
    try {
      await run();
    } catch (err) {
      logger.error('Pulse failed', err);
    }
  };
  pulseTimer = window.setTimeout(() => void fire(), delayMinutes * 60 * 1000);
}

// --- daily checkpoints ---

export function parseTime(hhmm: string): { h: number; m: number } | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return { h, m: min };
}

/** Milliseconds from `now` until the next local occurrence of HH:MM. */
export function msUntil(hhmm: string, now: Date): number | null {
  const t = parseTime(hhmm);
  if (!t) return null;
  const next = new Date(now);
  next.setHours(t.h, t.m, 0, 0);
  if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
  return next.getTime() - now.getTime();
}

function localDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * The latest checkpoint whose time has passed today but which has not run
 * today, or null. Only the most recent one is caught up: opening Obsidian at
 * 21:00 gives the evening wind-down, not three briefings in a row.
 * `lastRun` maps a checkpoint kind to the local date (YYYY-MM-DD) it last ran.
 */
export function missedCheckpoint(
  times: CheckpointTimes,
  lastRun: Partial<Record<CheckpointKind, string>>,
  now: Date,
): CheckpointKind | null {
  const today = localDate(now);
  const minutesNow = now.getHours() * 60 + now.getMinutes();
  let latest: { kind: CheckpointKind; at: number } | null = null;
  for (const key of Object.keys(KIND_BY_KEY) as Array<keyof CheckpointTimes>) {
    const t = parseTime(times[key] ?? '');
    if (!t) continue;
    const at = t.h * 60 + t.m;
    if (at > minutesNow) continue;
    if (!latest || at > latest.at) latest = { kind: KIND_BY_KEY[key], at };
  }
  if (!latest) return null;
  return lastRun[latest.kind] === today ? null : latest.kind;
}

export { localDate };

/**
 * Arms one timer per enabled checkpoint, each re-arming itself for the next
 * day after it fires. Returns a function that cancels them all.
 */
export function startCheckpoints(
  times: CheckpointTimes,
  run: (kind: CheckpointKind) => Promise<void>,
  now: () => Date = () => new Date(),
): () => void {
  const timers = new Map<keyof CheckpointTimes, number>();
  let stopped = false;

  const arm = (key: keyof CheckpointTimes) => {
    const delay = msUntil(times[key] ?? '', now());
    if (delay === null || stopped) return;
    const fire = async () => {
      try {
        await run(KIND_BY_KEY[key]);
      } catch (err) {
        logger.error(`${KIND_BY_KEY[key]} failed`, err);
      }
      // A small floor so a timer that fires a few ms early cannot re-fire today.
      timers.set(key, window.setTimeout(() => arm(key), 60 * 1000));
    };
    timers.set(key, window.setTimeout(() => void fire(), delay));
  };

  for (const key of Object.keys(KIND_BY_KEY) as Array<keyof CheckpointTimes>) arm(key);
  logger.info(`Checkpoints armed (morning ${times.morning || 'off'}, midday ${times.midday || 'off'}, evening ${times.evening || 'off'})`);

  return () => {
    stopped = true;
    for (const t of timers.values()) window.clearTimeout(t);
    timers.clear();
  };
}
