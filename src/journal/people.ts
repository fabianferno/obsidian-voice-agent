// journal/people.ts

import { writeFileSync, existsSync, mkdirSync } from 'fs';
import path from 'path';
import { findPersonNote } from '../vault/search.js';
import { appendToSection } from '../vault/writer.js';
import { notesDir } from '../config/paths.js';

export function handlePersonMention(
  name: string,
  note: string,
  vaultPath: string,
): { action: 'appended' | 'created'; filePath: string } {
  const existing = findPersonNote(vaultPath, name);
  const today = new Date().toISOString().split('T')[0];

  if (existing) {
    const entry = `- **${today}** ${note}`;
    appendToSection(existing.filePath, '## Notes', entry);
    return { action: 'appended', filePath: existing.filePath };
  }

  // Create new person note
  const neuronsDir = notesDir(vaultPath);
  if (!existsSync(neuronsDir)) mkdirSync(neuronsDir, { recursive: true });

  const filePath = path.join(neuronsDir, `${name}.md`);

  // A file with this exact name already exists but findPersonNote did not match
  // it (e.g. it is missing the `people` tag). Append instead of overwriting so we
  // never clobber an existing note's content.
  if (existsSync(filePath)) {
    appendToSection(filePath, '## Notes', `- **${today}** ${note}`);
    return { action: 'appended', filePath };
  }

  const content = `---
tags: [people]
---

# ${name}

## Context
- ${note}

## Notes
- **${today}** First mention

## Follow-ups
`;

  writeFileSync(filePath, content, 'utf-8');
  return { action: 'created', filePath };
}
