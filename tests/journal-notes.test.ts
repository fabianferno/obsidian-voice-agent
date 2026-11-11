import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { handlePersonMention } from '../src/journal/people.js';
import { handleLiteratureMention } from '../src/journal/literature.js';

let vault: string;
let neurons: string;

beforeEach(() => {
  vault = mkdtempSync(path.join(tmpdir(), 'vault-journal-'));
  neurons = path.join(vault, 'Notes');
  mkdirSync(neurons, { recursive: true });
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

describe('handlePersonMention', () => {
  it('creates a new person note when none exists', () => {
    const res = handlePersonMention('Alice', 'met at conference', vault);
    expect(res.action).toBe('created');
    const body = readFileSync(res.filePath, 'utf-8');
    expect(body).toContain('tags: [people]');
    expect(body).toContain('met at conference');
  });

  it('appends to an existing people-tagged note without dropping prior content', () => {
    const file = path.join(neurons, 'Alice.md');
    writeFileSync(file, '---\ntags: [people]\n---\n\n# Alice\n\n## Notes\n- **2026-01-01** old note\n');
    const res = handlePersonMention('Alice', 'new observation', vault);
    expect(res.action).toBe('appended');
    const body = readFileSync(res.filePath, 'utf-8');
    expect(body).toContain('old note'); // prior content preserved
    expect(body).toContain('new observation');
  });

  it('appends the new bullet directly under the last one, keeping a blank line before the next heading', () => {
    const file = path.join(neurons, 'Bob.md');
    writeFileSync(
      file,
      '---\ntags: [people]\n---\n\n# Bob\n\n## Notes\n- **2026-01-01** first\n\n## Follow-ups\n',
    );
    handlePersonMention('Bob', 'second', vault);
    const body = readFileSync(file, 'utf-8');
    // No stray blank line between the two bullets...
    expect(body).toMatch(/- \*\*2026-01-01\*\* first\n- \*\*\d{4}-\d{2}-\d{2}\*\* second\n/);
    // ...and the blank line before the next heading survives.
    expect(body).toContain('second\n\n## Follow-ups');
  });

  it('does NOT overwrite a same-named note that lacks the people tag', () => {
    const file = path.join(neurons, 'Rust.md');
    const original = '---\ntags: [literature]\n---\n\n# Rust\n\nImportant existing content that must survive.\n';
    writeFileSync(file, original);
    const res = handlePersonMention('Rust', 'someone named Rust', vault);
    expect(res.action).toBe('appended');
    const body = readFileSync(file, 'utf-8');
    expect(body).toContain('Important existing content that must survive.');
    expect(body).toContain('someone named Rust');
  });
});

describe('handleLiteratureMention', () => {
  it('creates a new literature note when none exists', () => {
    const res = handleLiteratureMention('Dune', 'book', 'Herbert', 'great read', vault);
    expect(res.action).toBe('created');
    const body = readFileSync(res.filePath, 'utf-8');
    expect(body).toContain('tags: [literature');
    expect(body).toContain('great read');
  });

  it('does NOT overwrite a same-named note that lacks the literature tag', () => {
    const file = path.join(neurons, 'Dune.md');
    const original = '---\ntags: [people]\n---\n\n# Dune\n\nExisting note that must survive.\n';
    writeFileSync(file, original);
    const res = handleLiteratureMention('Dune', 'book', 'Herbert', 'a note', vault);
    expect(res.action).toBe('appended');
    const body = readFileSync(file, 'utf-8');
    expect(body).toContain('Existing note that must survive.');
    expect(body).toContain('a note');
    expect(existsSync(file)).toBe(true);
  });
});
