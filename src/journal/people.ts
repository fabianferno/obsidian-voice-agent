// journal/people.ts - a person mentioned in conversation (the older people_note action).

import { captureToNote, type CaptureResult } from './capture.js';

export function handlePersonMention(name: string, note: string, vaultPath: string): CaptureResult {
  return captureToNote(vaultPath, { title: name, noteType: 'people', text: note });
}
