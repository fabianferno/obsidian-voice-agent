// vault/notes.ts - note-level helpers shared by capture and graduation.
//
// A note grows in a fixed shape: a short summary the agent may rewrite, the
// user's own text (never rewritten), a `## Timeline` of dated lines that are
// only ever appended, then `##### References`. The agent's open question sits in
// a callout under the title. Everything here is plain string work so it can be
// tested without a vault.

import { createHash } from 'crypto';
import { readdirSync, readFileSync } from 'fs';
import path from 'path';
import { getLayout } from '../config/paths.js';
import { parseFrontmatter } from './parser.js';

export const QUESTION_HEADER = '> [!question] Voice Agent';
const REFERENCES_RE = /^#####\s+References\s*$/;
const TIMELINE_RE = /^##\s+Timeline\s*$/;

export function hashContent(content: string): string {
  return createHash('sha1').update(content).digest('hex');
}

/** Splits off the frontmatter block (with its --- lines, or '' when there is none). */
export function splitFrontmatter(content: string): { frontmatter: string; body: string } {
  const m = content.match(/^---\n[\s\S]*?\n---\n?/);
  return m ? { frontmatter: m[0], body: content.slice(m[0].length) } : { frontmatter: '', body: content };
}

/** Every markdown note in the vault the agent may see: no hidden, agent or daily folders. */
export function listNotes(vaultPath: string): string[] {
  const { agentFolder, dailyFolder } = getLayout();
  const skip = [agentFolder, dailyFolder].filter(Boolean).map(p => path.join(vaultPath, p));
  const out: string[] = [];
  const walk = (dir: string) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!e.name.startsWith('.') && e.name !== 'node_modules' && !skip.includes(full)) walk(full);
      } else if (e.name.endsWith('.md')) {
        out.push(full);
      }
    }
  };
  walk(vaultPath);
  return out;
}

/** The note whose file name, or one of whose aliases, is `title` (case-insensitive). */
export function findNote(vaultPath: string, title: string): string | null {
  const want = title.trim().toLowerCase();
  if (!want) return null;
  const notes = listNotes(vaultPath);
  const byName = notes.find(p => path.basename(p, '.md').toLowerCase() === want);
  if (byName) return byName;
  for (const p of notes) {
    const { aliases } = parseFrontmatter(readFileSync(p, 'utf-8'));
    if (aliases.some(a => a.toLowerCase() === want)) return p;
  }
  return null;
}

export function timelineLine(date: string, text: string, source: string): string {
  return `- **${date}** | ${text.replace(/\s+/g, ' ').trim()} [Source: ${source}]`;
}

/**
 * Adds a line at the end of the note's `## Timeline` section. Without one, the
 * section is created just above `##### References`, or at the end of the note.
 */
export function appendTimeline(content: string, line: string): string {
  const lines = content.replace(/\s+$/, '').split('\n');
  const t = lines.findIndex(l => TIMELINE_RE.test(l));
  if (t !== -1) {
    let end = t + 1;
    while (end < lines.length && !/^#{1,6}\s/.test(lines[end])) end++;
    let insertAt = end;
    while (insertAt > t + 1 && lines[insertAt - 1].trim() === '') insertAt--;
    lines.splice(insertAt, 0, line);
    return lines.join('\n') + '\n';
  }
  const r = lines.findIndex(l => REFERENCES_RE.test(l));
  const block = ['## Timeline', line, ''];
  if (r !== -1) {
    while (r > 0 && lines[r - 1].trim() === '' && lines[r - 2]?.trim() === '') lines.splice(r - 1, 1);
    const at = lines.findIndex(l => REFERENCES_RE.test(l));
    if (at > 0 && lines[at - 1].trim() !== '') block.unshift('');
    lines.splice(at, 0, ...block);
    return lines.join('\n') + '\n';
  }
  return `${lines.join('\n')}\n\n${block.join('\n')}`;
}

/** Index range [start, end) of each question callout in `lines`. */
function questionBlocks(lines: string[]): Array<[number, number]> {
  const blocks: Array<[number, number]> = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() !== QUESTION_HEADER) continue;
    let end = i + 1;
    while (end < lines.length && lines[end].startsWith('>')) end++;
    blocks.push([i, end]);
    i = end - 1;
  }
  return blocks;
}

export function hasQuestion(content: string): boolean {
  return questionBlocks(content.split('\n')).length > 0;
}

/** The agent's question text (the line under the callout header), or null. */
export function questionText(content: string): string | null {
  const lines = content.split('\n');
  const [b] = questionBlocks(lines);
  if (!b) return null;
  return lines[b[0] + 1]?.replace(/^>\s?/, '').trim() || null;
}

/**
 * Drops the agent's question callouts. Lines the user typed inside a callout
 * (anything after the question line) are kept, without the `>` marker.
 */
export function removeQuestions(content: string): string {
  const lines = content.split('\n');
  const blocks = questionBlocks(lines);
  for (const [start, end] of blocks.reverse()) {
    const kept = lines.slice(start + 2, end).map(l => l.replace(/^>\s?/, '')).filter(l => l.trim());
    let stop = end;
    if (!kept.length && lines[stop]?.trim() === '') stop++;
    lines.splice(start, stop - start, ...kept);
  }
  return lines.join('\n');
}

/** Puts one question callout under the title (or at the top of the body), replacing older ones. */
export function addQuestion(content: string, question: string): string {
  const { frontmatter, body } = splitFrontmatter(removeQuestions(content));
  const callout = `${QUESTION_HEADER}\n> ${question.replace(/\s+/g, ' ').trim()}\n`;
  const lines = body.replace(/^\n+/, '').split('\n');
  if (/^#\s/.test(lines[0] ?? '')) {
    const rest = lines.slice(1).join('\n').replace(/^\n+/, '');
    return `${frontmatter}${lines[0]}\n\n${callout}\n${rest}`;
  }
  return `${frontmatter}${callout}\n${lines.join('\n')}`;
}

/** A line reduced to its words: no quote or list markers, no surrounding space. */
function normalizeLine(line: string): string {
  return line.replace(/^(\s*>)+/, '').trim().replace(/^[-*+]\s+/, '').trim();
}

/**
 * The lines the user wrote: the body without the agent's question (header and
 * question line), the title, `##### References` and blank or empty-bullet lines.
 */
export function userLines(content: string): string[] {
  const lines = splitFrontmatter(content).body.split('\n');
  const skip = new Set<number>();
  for (const [start] of questionBlocks(lines)) {
    skip.add(start);
    skip.add(start + 1);
  }
  return lines
    .filter((l, i) => !skip.has(i))
    .filter(l => !/^#\s/.test(l) && !REFERENCES_RE.test(l) && !/^<!--.*-->$/.test(l.trim()))
    .map(normalizeLine)
    .filter(l => l !== '' && l !== '-');
}

/** User lines from `before` that no longer appear in `after`. Empty means nothing was lost. */
export function missingUserLines(before: string, after: string): string[] {
  const present = new Set(splitFrontmatter(after).body.split('\n').map(normalizeLine));
  return userLines(before).filter(l => !present.has(l));
}

/** Tags of the note, from its frontmatter. */
export function noteTags(content: string): string[] {
  return parseFrontmatter(content).tags;
}
