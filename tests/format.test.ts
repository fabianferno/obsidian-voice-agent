import { describe, it, expect } from 'vitest';
import { formatDuration } from '../src/utils/format.js';

describe('formatDuration', () => {
  it('shows minutes under an hour', () => {
    expect(formatDuration(45)).toBe('45min');
    expect(formatDuration(59.6)).toBe('1h');
  });

  it('shows hours and minutes', () => {
    expect(formatDuration(90)).toBe('1h 30min');
    expect(formatDuration(120)).toBe('2h');
  });
});
