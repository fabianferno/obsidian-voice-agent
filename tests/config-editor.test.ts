import { describe, it, expect } from 'vitest';
import { applyEditToContent } from '../src/config/editor.js';
import { parseUserMeta } from '../src/config/loader.js';
import type { ConfigEdit } from '../src/config/types.js';

const IDENTITY = `# Identity

## Voice
- Warm but firm.

## What I never do
- Never open with "Hey!"
- Never use em dashes.
`;

const MEMORY = `# Memory

## Entries
- [2026-07-13] Older entry
`;

const USER = `# User

## Basics
- Name: Alex
- Coordinates: 12.3456, 65.4321

## Personality & patterns
- Tends to overcommit

## Schedule
- Active hours: 08:00 - 23:00 IST
- Quiet hours: 23:00 - 08:00 IST
- Preferred pulse interval: 90 minutes

## Check-ins
- Morning briefing: yes
`;

describe('applyEditToContent', () => {
  it('appends a bullet to the end of a section', () => {
    const edit: ConfigEdit = {
      file: 'identity.md', section: 'What I never do',
      operation: 'append_bullet', content: 'Never use emojis.',
    };
    const result = applyEditToContent(IDENTITY, edit);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const lines = result.content.split('\n');
    expect(lines.indexOf('- Never use emojis.'))
      .toBeGreaterThan(lines.indexOf('- Never use em dashes.'));
    // The Voice section must be untouched.
    expect(result.content).toContain('- Warm but firm.');
  });

  it('prepends a bullet directly under the section header (memory is newest-at-top)', () => {
    const edit: ConfigEdit = {
      file: 'memory.md', section: 'Entries',
      operation: 'prepend_bullet', content: '[2026-07-14] Newest entry',
    };
    const result = applyEditToContent(MEMORY, edit);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const bullets = result.content.split('\n').filter(l => l.startsWith('- '));
    expect(bullets[0]).toBe('- [2026-07-14] Newest entry');
    expect(bullets[1]).toBe('- [2026-07-13] Older entry');
  });

  it('replaces a matching bullet line', () => {
    const edit: ConfigEdit = {
      file: 'identity.md', section: 'What I never do',
      operation: 'replace_line', match: 'em dashes',
      content: 'Never use em dashes or emojis.',
    };
    const result = applyEditToContent(IDENTITY, edit);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.content).toContain('- Never use em dashes or emojis.');
    expect(result.content).not.toContain('- Never use em dashes.\n');
  });

  it('sets an existing field in place', () => {
    const edit: ConfigEdit = {
      file: 'user.md', section: 'Schedule',
      operation: 'set_field', field: 'Quiet hours', content: '22:00 - 07:00',
    };
    const result = applyEditToContent(USER, edit);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(parseUserMeta(result.content).quietHoursStart).toBe('22:00');
  });

  it('appends a field to the section when the field does not exist yet', () => {
    const edit: ConfigEdit = {
      file: 'user.md', section: 'Personality & patterns',
      operation: 'set_field', field: 'Dislikes emojis', content: 'true',
    };
    const result = applyEditToContent(USER, edit);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.content).toContain('- Dislikes emojis: true');
  });

  it('rejects an unknown section and changes nothing', () => {
    const edit: ConfigEdit = {
      file: 'identity.md', section: 'Nonexistent Section',
      operation: 'append_bullet', content: 'whatever',
    };
    const result = applyEditToContent(IDENTITY, edit);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/section/i);
  });

  it('rejects replace_line when no line matches', () => {
    const edit: ConfigEdit = {
      file: 'identity.md', section: 'What I never do',
      operation: 'replace_line', match: 'nothing matches this',
      content: 'replacement',
    };
    const result = applyEditToContent(IDENTITY, edit);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/no line/i);
  });

  it('rejects a user.md edit that would corrupt a machine-read field', () => {
    const edit: ConfigEdit = {
      file: 'user.md', section: 'Basics',
      operation: 'replace_line', match: 'Coordinates',
      content: 'Coordinates: somewhere vague',
    };
    const result = applyEditToContent(USER, edit);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/machine-read field/i);
    // The original still parses.
    expect(parseUserMeta(USER).coordinates.lat).toBeCloseTo(12.3456);
  });

  it('allows a user.md edit that deliberately targets one machine-read field', () => {
    const edit: ConfigEdit = {
      file: 'user.md', section: 'Schedule',
      operation: 'set_field', field: 'Preferred pulse interval', content: '120 minutes',
    };
    const result = applyEditToContent(USER, edit);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const meta = parseUserMeta(result.content);
    expect(meta.pulseIntervalMinutes).toBe(120);
    // Collateral fields survive.
    expect(meta.coordinates.lat).toBeCloseTo(12.3456);
    expect(meta.quietHoursStart).toBe('23:00');
  });

  it('leaves other sections byte-identical', () => {
    const edit: ConfigEdit = {
      file: 'user.md', section: 'Personality & patterns',
      operation: 'append_bullet', content: 'Dislikes emojis',
    };
    const result = applyEditToContent(USER, edit);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.content).toContain('## Schedule\n- Active hours: 08:00 - 23:00 IST');
  });
});
