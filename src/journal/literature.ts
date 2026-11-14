// journal/literature.ts - a book, article or podcast mentioned in conversation
// (the older literature_note action).

import { captureToNote, type CaptureResult } from './capture.js';

export function handleLiteratureMention(
  title: string,
  noteType: string,
  source: string,
  note: string,
  vaultPath: string,
): CaptureResult {
  const from = [noteType, source].filter(Boolean).join(', ');
  return captureToNote(vaultPath, { title, noteType: 'literature', text: from ? `${note} (${from})` : note });
}
