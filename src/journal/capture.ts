// journal/capture.ts - files something from a conversation into the vault.
//
// An existing note (found by name or alias anywhere the agent may look) gets a
// dated line in its Timeline; the user's own text is never touched. A new
// subject gets a new note in the capture folder, where the daily graduation pass
// picks it up later.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';
import { captureDir, notesDir } from '../config/paths.js';
import { localDate } from '../checkins/scheduler.js';
import { appendTimeline, findNote, timelineLine } from '../vault/notes.js';

export interface CaptureInput {
  /** The note's name: a person, project, idea... */
  title: string;
  /** The vault's type tag for a new note (people, projects, concept...). */
  noteType?: string;
  /** What to record, in the user's words. */
  text: string;
  /** Where it came from. Defaults to the conversation. */
  source?: string;
  date?: string;
}

export interface CaptureResult {
  action: 'appended' | 'created';
  filePath: string;
}

/** A title made safe as a file name. */
export function noteFileName(title: string): string {
  return title.replace(/[\\/:*?"<>|#^[\]]/g, ' ').replace(/\s+/g, ' ').trim().replace(/^\.+/, '') || 'Untitled';
}

export function captureToNote(vaultPath: string, input: CaptureInput): CaptureResult {
  const date = input.date ?? localDate(new Date());
  const line = timelineLine(date, input.text, input.source ?? 'voice chat');
  const title = noteFileName(input.title);

  const existing = findNote(vaultPath, input.title) ?? findNote(vaultPath, title);
  if (existing) {
    writeFileSync(existing, appendTimeline(readFileSync(existing, 'utf-8'), line), 'utf-8');
    return { action: 'appended', filePath: existing };
  }

  const dir = captureDir(vaultPath) ?? notesDir(vaultPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `${title}.md`);
  const type = input.noteType && /^[a-z][a-z0-9/-]*$/.test(input.noteType) ? input.noteType : '';
  const frontmatter = type ? `---\ntags:\n  - ${type}\n---\n` : '';
  writeFileSync(filePath, `${frontmatter}# ${title}\n\n## Timeline\n${line}\n\n##### References\n`, 'utf-8');
  return { action: 'created', filePath };
}
