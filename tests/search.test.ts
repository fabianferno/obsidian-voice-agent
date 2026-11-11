import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import {
  searchNotesWithContent,
  queryTerms,
  stripFrontmatter,
} from '../src/vault/search.js';

let vault: string;

beforeAll(() => {
  vault = mkdtempSync(path.join(tmpdir(), 'vault-search-'));
  mkdirSync(path.join(vault, 'Notes'), { recursive: true });
  mkdirSync(path.join(vault, 'Daily'), { recursive: true });

  writeFileSync(
    path.join(vault, 'Notes', 'Rust Ownership.md'),
    '---\ntags: [literature]\n---\nRust borrow checker enforces ownership at compile time. No garbage collector.',
  );
  writeFileSync(
    path.join(vault, 'Notes', 'Alice.md'),
    '---\ntags: [people]\n---\nAlice is a systems engineer who loves Rust and mentored me on ownership.',
  );
  // A daily note that mentions the term but must never be returned.
  writeFileSync(
    path.join(vault, 'Daily', '2026-07-15.md'),
    'Today I studied Rust ownership all afternoon.',
  );
});

afterAll(() => {
  rmSync(vault, { recursive: true, force: true });
});

describe('queryTerms', () => {
  it('drops stopwords and short tokens, dedupes', () => {
    expect(queryTerms('what did I write about the Rust ownership')).toEqual([
      'write',
      'rust',
      'ownership',
    ]);
  });

  it('returns empty for a stopword-only query', () => {
    expect(queryTerms('what did the')).toEqual([]);
  });
});

describe('stripFrontmatter', () => {
  it('removes a leading YAML block', () => {
    expect(stripFrontmatter('---\ntags: [x]\n---\nbody here')).toBe('body here');
  });

  it('leaves body-only content untouched', () => {
    expect(stripFrontmatter('just body')).toBe('just body');
  });
});

describe('searchNotesWithContent', () => {
  it('matches on filename and body, ranking filename hits higher', () => {
    const results = searchNotesWithContent(vault, 'Rust ownership');
    expect(results.length).toBeGreaterThanOrEqual(2);
    // "Rust Ownership.md" hits both terms in the filename -> highest score.
    expect(results[0].fileName).toBe('Rust Ownership');
    expect(results[0].content).toContain('borrow checker');
    expect(results[0].snippet.length).toBeGreaterThan(0);
    expect(results[0].tags).toContain('literature');
  });

  it('never returns daily notes', () => {
    const results = searchNotesWithContent(vault, 'Rust ownership');
    expect(results.some((r) => r.filePath.includes('Daily'))).toBe(false);
  });

  it('returns empty when the query is all stopwords', () => {
    expect(searchNotesWithContent(vault, 'what about the')).toEqual([]);
  });

  it('matches whole words only (persona does not hit personal)', () => {
    const results = searchNotesWithContent(vault, 'persona');
    // "Rust Ownership" / "Alice" bodies contain neither "persona" nor "personal",
    // so a whole-word search returns nothing rather than a substring false hit.
    expect(results).toEqual([]);
  });

  it('still matches a full word inside prose', () => {
    // Alice's body: "...mentored me on ownership." -- whole word "ownership".
    const results = searchNotesWithContent(vault, 'ownership');
    expect(results.some((r) => r.fileName === 'Alice')).toBe(true);
  });

  it('respects the limit option', () => {
    const results = searchNotesWithContent(vault, 'Rust', { limit: 1 });
    expect(results.length).toBe(1);
  });

  it('truncates content to maxContentChars', () => {
    const results = searchNotesWithContent(vault, 'Rust', { maxContentChars: 10 });
    expect(results[0].content.endsWith('...')).toBe(true);
    expect(results[0].content.length).toBeLessThanOrEqual(13);
  });
});
