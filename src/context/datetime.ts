// context/datetime.ts

import type { DateTimeContext } from '../config/types.js';

/**
 * An IANA zone for whatever user.md says. Older files say "IST (UTC+5:30)";
 * anything Intl does not recognise falls back to this computer's zone.
 */
export function toIanaZone(timezone: string): string {
  if (/UTC\+5:30|\bIST\b/.test(timezone)) return 'Asia/Kolkata';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
    return timezone;
  } catch {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  }
}

export function getDateTimeContext(timezone: string): DateTimeContext {
  const tz = toIanaZone(timezone);
  const now = new Date();

  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    weekday: 'long',
    hour: 'numeric',
    hour12: false,
  });

  const parts = formatter.formatToParts(now);
  const weekday = parts.find(p => p.type === 'weekday')?.value || '';
  const hour = parseInt(parts.find(p => p.type === 'hour')?.value || '12', 10);

  let timeOfDay: 'morning' | 'afternoon' | 'evening' | 'night';
  if (hour >= 5 && hour < 12) timeOfDay = 'morning';
  else if (hour >= 12 && hour < 17) timeOfDay = 'afternoon';
  else if (hour >= 17 && hour < 21) timeOfDay = 'evening';
  else timeOfDay = 'night';

  const dayIndex = now.getDay(); // 0=Sun, 6=Sat
  const isWeekend = dayIndex === 0 || dayIndex === 6;
  const daysUntilWeekend = dayIndex === 0 ? 0 : dayIndex === 6 ? 0 : 6 - dayIndex;

  const humanReadable = now.toLocaleString('en-US', {
    timeZone: tz,
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZoneName: 'short',
  });

  return {
    now: humanReadable,
    dayOfWeek: weekday,
    timeOfDay,
    isWeekend,
    daysUntilWeekend,
  };
}
