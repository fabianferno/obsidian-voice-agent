// journal/literature.ts

import { writeFileSync, existsSync, mkdirSync } from 'fs';
import path from 'path';
import { findLiteratureNote } from '../vault/search.js';
import { appendToSection } from '../vault/writer.js';
import { notesDir } from '../config/paths.js';

export function handleLiteratureMention(
  title: string,
  noteType: string,
  source: string,
  note: string,
  vaultPath: string,
): { action: 'appended' | 'created'; filePath: string } {
  const existing = findLiteratureNote(vaultPath, title);
  const today = new Date().toISOString().split('T')[0];

  if (existing) {
    const entry = `- **${today}** ${note}`;
    appendToSection(existing.filePath, '## Notes', entry);
    return { action: 'appended', filePath: existing.filePath };
  }

  const neuronsDir = notesDir(vaultPath);
  if (!existsSync(neuronsDir)) mkdirSync(neuronsDir, { recursive: true });

  const filePath = path.join(neuronsDir, `${title}.md`);

  // A file with this exact name already exists but findLiteratureNote did not
  // match it (e.g. it is missing the `literature` tag). Append instead of
  // overwriting so we never clobber an existing note's content.
  if (existsSync(filePath)) {
    appendToSection(filePath, '## Notes', `- **${today}** ${note}`);
    return { action: 'appended', filePath };
  }

  const content = `---
tags: [literature, reading-status/unread]
---

# ${title}

## Meta
- Author: [unknown]
- Type: ${noteType}
- Source: ${source}
- Added: ${today}

## Notes
- **${today}** ${note}
`;

  writeFileSync(filePath, content, 'utf-8');
  return { action: 'created', filePath };
}
