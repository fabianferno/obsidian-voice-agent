import { describe, it, expect } from 'vitest';
import { parseTimeEstimate } from '../src/focus/estimator.js';

describe('parseTimeEstimate', () => {
  const timezone = 'Asia/Kolkata';
  // Fixed "now" for deterministic tests: 2026-03-25T10:00 IST = 04:30 UTC
  const now = new Date('2026-03-25T04:30:00Z');

  it('parses "2h"', () => {
    expect(parseTimeEstimate('2h', timezone, now)).toBe(120);
  });
  it('parses "30 min"', () => {
    expect(parseTimeEstimate('30 min', timezone, now)).toBe(30);
  });
  it('parses "30m"', () => {
    expect(parseTimeEstimate('30m', timezone, now)).toBe(30);
  });
  it('parses "1.5 hours"', () => {
    expect(parseTimeEstimate('1.5 hours', timezone, now)).toBe(90);
  });
  it('parses "couple hours"', () => {
    expect(parseTimeEstimate('couple hours', timezone, now)).toBe(120);
  });
  it('parses "couple of hours"', () => {
    expect(parseTimeEstimate('couple of hours', timezone, now)).toBe(120);
  });
  it('parses "till 4pm" relative to now', () => {
    // now is 10:00 IST, till 4pm = 6 hours = 360 min
    expect(parseTimeEstimate('till 4pm', timezone, now)).toBe(360);
  });
  it('parses "before lunch" as until 12:00', () => {
    // now is 10:00 IST, before lunch = 2 hours = 120 min
    expect(parseTimeEstimate('before lunch', timezone, now)).toBe(120);
  });
  it('parses "about an hour"', () => {
    expect(parseTimeEstimate('about an hour', timezone, now)).toBe(60);
  });
  it('parses "~45min"', () => {
    expect(parseTimeEstimate('~45min', timezone, now)).toBe(45);
  });
  it('parses "an hour and a half"', () => {
    expect(parseTimeEstimate('an hour and a half', timezone, now)).toBe(90);
  });
  it('returns null for unparseable input', () => {
    expect(parseTimeEstimate('not sure', timezone, now)).toBeNull();
  });
  it('returns null for empty string', () => {
    expect(parseTimeEstimate('', timezone, now)).toBeNull();
  });
  it('parses estimate embedded in sentence: "maybe 2h"', () => {
    expect(parseTimeEstimate('maybe 2h', timezone, now)).toBe(120);
  });
  it('parses "45 minutes"', () => {
    expect(parseTimeEstimate('45 minutes', timezone, now)).toBe(45);
  });
});
