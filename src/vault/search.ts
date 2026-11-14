// vault/search.ts

import { readdirSync, readFileSync } from 'fs';
import path from 'path';
import { parseFrontmatter } from './parser.js';
import { getLayout } from '../config/paths.js';

interface SearchResult {
  filePath: string;
  fileName: string;
  tags: string[];
}

export interface NoteSearchResult {
  fileName: string;
  filePath: string;   // relative to the vault root, for display
  tags: string[];
  snippet: string;    // a short window of body text around the first term match
  content: string;    // the note body (frontmatter stripped), truncated
  score: number;      // higher = better match; filename hits weigh more than body hits
}

// Terms shorter than this or in the stopword set are ignored so a query like
// "what did I write about the vault" matches on "write" and "vault", not "the".
const MIN_TERM_LEN = 2;
const STOPWORDS = new Set([
  'the', 'and', 'for', 'that', 'this', 'with', 'you', 'your', 'was', 'were',
  'are', 'did', 'does', 'about', 'what', 'when', 'where', 'who', 'how', 'why',
  'from', 'into', 'note', 'notes', 'have', 'has', 'had', 'any', 'all',
]);

/** Split a query into meaningful lowercase search terms. */
export function queryTerms(query: string): string[] {
  return Array.from(
    new Set(
      query
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((t) => t.length >= MIN_TERM_LEN && !STOPWORDS.has(t)),
    ),
  );
}

/** Strip a leading YAML frontmatter block so only the note body remains. */
export function stripFrontmatter(content: string): string {
  return content.replace(/^---\n[\s\S]*?\n---\n?/, '').trim();
}

/**
 * Full-text + filename search across the vault. Matches each query term against
 * the note's filename (weighted heavily) and body, ranks by score, and returns
 * the top matches with a snippet and a truncated body so an LLM can answer from
 * the content. Read-only; never touches git.
 */
export function searchNotesWithContent(
  vaultPath: string,
  query: string,
  opts: { limit?: number; maxContentChars?: number } = {},
): NoteSearchResult[] {
  const limit = opts.limit ?? 5;
  const maxContentChars = opts.maxContentChars ?? 1500;
  const terms = queryTerms(query);
  if (terms.length === 0) return [];

  const scored: NoteSearchResult[] = [];

  walkVault(vaultPath, (filePath) => {
    // The agent never reads daily notes (see CLAUDE.md); keep them out of search.
    if (filePath.includes(`${path.sep}Daily${path.sep}`)) return;

    const fileName = path.basename(filePath, '.md');
    const raw = readFileSync(filePath, 'utf-8');
    const fm = parseFrontmatter(raw);
    const body = stripFrontmatter(raw);

    const lowerName = fileName.toLowerCase();
    const lowerBody = body.toLowerCase();

    let score = 0;
    let firstBodyIdx = -1;
    for (const term of terms) {
      // Match whole words only so "persona" does not hit "personal". Terms are
      // [a-z0-9] (see queryTerms), so they are safe to drop into a regex.
      if (new RegExp(`\\b${term}\\b`).test(lowerName)) score += 5;
      const bodyRe = new RegExp(`\\b${term}\\b`, 'g');
      let m: RegExpExecArray | null;
      while ((m = bodyRe.exec(lowerBody)) !== null) {
        score += 1;
        if (firstBodyIdx === -1 || m.index < firstBodyIdx) firstBodyIdx = m.index;
      }
    }

    if (score <= 0) return;

    scored.push({
      fileName,
      filePath: path.relative(vaultPath, filePath),
      tags: fm.tags,
      snippet: makeSnippet(body, firstBodyIdx),
      content: body.length > maxContentChars ? `${body.slice(0, maxContentChars)}...` : body,
      score,
    });
  });

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

/** A ~240-char window of body text centered on the first matched term. */
function makeSnippet(body: string, matchIdx: number): string {
  if (!body) return '';
  const window = 240;
  if (matchIdx < 0) return body.slice(0, window).replace(/\s+/g, ' ').trim();
  const start = Math.max(0, matchIdx - window / 2);
  const end = Math.min(body.length, matchIdx + window / 2);
  const prefix = start > 0 ? '...' : '';
  const suffix = end < body.length ? '...' : '';
  return `${prefix}${body.slice(start, end).replace(/\s+/g, ' ').trim()}${suffix}`;
}

export function searchByName(vaultPath: string, name: string): SearchResult[] {
  const results: SearchResult[] = [];
  const lowerName = name.toLowerCase();

  walkVault(vaultPath, (filePath) => {
    const fileName = path.basename(filePath, '.md');
    if (fileName.toLowerCase().includes(lowerName)) {
      const content = readFileSync(filePath, 'utf-8');
      const fm = parseFrontmatter(content);
      results.push({ filePath, fileName, tags: fm.tags });
    }
  });

  return results;
}

export function searchByTag(vaultPath: string, tag: string): SearchResult[] {
  const results: SearchResult[] = [];

  walkVault(vaultPath, (filePath) => {
    const content = readFileSync(filePath, 'utf-8');
    const fm = parseFrontmatter(content);
    if (fm.tags.includes(tag)) {
      results.push({
        filePath,
        fileName: path.basename(filePath, '.md'),
        tags: fm.tags,
      });
    }
  });

  return results;
}

function walkVault(dir: string, callback: (filePath: string) => void, root: string = dir): void {
  // Hidden folders (the Obsidian config folder, .trash, .git) are skipped below.
  const skipDirs = ['node_modules', 'dist'];
  // The agent's own folder and the daily notes are never searched: daily notes
  // are off limits to the agent entirely.
  const { agentFolder, dailyFolder } = getLayout();
  const skipPaths = [agentFolder, dailyFolder].filter(Boolean).map(p => path.join(root, p));

  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const full = path.join(dir, entry.name);
        if (!entry.name.startsWith('.') && !skipDirs.includes(entry.name) && !skipPaths.includes(full)) {
          walkVault(full, callback, root);
        }
      } else if (entry.name.endsWith('.md')) {
        callback(path.join(dir, entry.name));
      }
    }
  } catch {
    // Directory doesn't exist or isn't readable
  }
}
