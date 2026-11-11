// config/loader.ts

import { readFileSync } from 'fs';
import path from 'path';
import type { AgentConfig, UserMeta } from './types.js';
import { agentDir, resolveVaultPath } from './paths.js';

// The personality/state files (soul, identity, user, goals, memory) live in the
// vault, in the agent folder: the agent writes memory.md, so they belong with the
// notes it also writes. A missing file reads as empty; the plugin creates starter
// files on first run.
export function loadAgentConfig(dir: string = agentDir(resolveVaultPath())): AgentConfig {
  const read = (file: string) => {
    try {
      return readFileSync(path.join(dir, file), 'utf-8');
    } catch {
      return '';
    }
  };

  const userContent = read('user.md');

  return {
    soul: read('soul.md'),
    identity: read('identity.md'),
    user: userContent,
    goals: read('goals.md'),
    memory: parseMemoryEntries(read('memory.md')),
    userMeta: parseUserMeta(userContent),
  };
}

export function parseMemoryEntries(content: string): string[] {
  const entriesSection = content.split('## Entries')[1];
  if (!entriesSection) return [];

  return entriesSection
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.startsWith('- '))
    .map(line => line.slice(2));
}

export function parseUserMeta(content: string): UserMeta {
  const getField = (label: string): string => {
    const regex = new RegExp(`^- ${label}:\\s*(.+)$`, 'mi');
    const match = content.match(regex);
    return match ? match[1].trim() : '';
  };

  const coordStr = getField('Coordinates');
  const [lat, lng] = coordStr
    ? coordStr.split(',').map(s => parseFloat(s.trim()))
    : [0, 0];

  const activeHours = getField('Active hours');
  const [activeStart, activeEnd] = activeHours
    ? activeHours.replace(/\s*IST\s*/g, '').split(' - ').map(s => s.trim())
    : ['08:00', '23:00'];

  const quietHours = getField('Quiet hours');
  const [quietStart, quietEnd] = quietHours
    ? quietHours.replace(/\s*IST\s*/g, '').split(' - ').map(s => s.trim())
    : ['23:00', '08:00'];

  const pulseStr = getField('Preferred pulse interval');
  const pulseMinutes = pulseStr
    ? parseInt(pulseStr.match(/(\d+)/)?.[1] || '90', 10)
    : 90;

  const name = getField('Name') || '[Set during onboarding]';

  return {
    name,
    nickname: getField('Nickname') || name.split(' ')[0] || 'there',
    location: getField('Location') || '',
    timezone: getField('Timezone') || Intl.DateTimeFormat().resolvedOptions().timeZone,
    coordinates: { lat: lat || 0, lng: lng || 0 },
    activeHoursStart: activeStart,
    activeHoursEnd: activeEnd,
    quietHoursStart: quietStart,
    quietHoursEnd: quietEnd,
    pulseIntervalMinutes: pulseMinutes,
  };
}
