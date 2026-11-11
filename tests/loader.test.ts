import { describe, it, expect } from 'vitest';
import { parseMemoryEntries, parseUserMeta } from '../src/config/loader.js';

describe('Config Loader', () => {
  it('parses memory entries from memory.md content', () => {
    const content = `# Memory\n\n## Entries\n- [2026-03-25] User overrode WIP limit\n- [2026-03-24] First run completed`;
    const entries = parseMemoryEntries(content);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toContain('User overrode WIP limit');
  });

  it('parses user meta from user.md content', () => {
    const content = `# User\n\n## Basics\n- Name: Alex\n- Location: Example City, Region, Country\n- Timezone: IST (UTC+5:30)\n- Coordinates: 12.3456, 65.4321\n\n## Schedule\n- Active hours: 08:00 - 23:00 IST\n- Quiet hours: 23:00 - 08:00 IST\n- Preferred pulse interval: 90 minutes\n\n## Active channels\n- Preferred channel: telegram`;
    const meta = parseUserMeta(content);
    expect(meta.name).toBe('Alex');
    expect(meta.timezone).toBe('IST (UTC+5:30)');
    expect(meta.coordinates.lat).toBeCloseTo(12.3456);
    expect(meta.pulseIntervalMinutes).toBe(90);
  });

  it('handles unset onboarding values gracefully', () => {
    const content = `# User\n\n## Basics\n- Name: [Set during onboarding]\n- Timezone: IST (UTC+5:30)\n- Coordinates: 12.3456, 65.4321`;
    const meta = parseUserMeta(content);
    expect(meta.name).toBe('[Set during onboarding]');
  });
});
