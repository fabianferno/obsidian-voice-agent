import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { setLayout } from '../src/config/paths.js';
import { captureToNote } from '../src/journal/capture.js';
import { handlePersonMention } from '../src/journal/people.js';
import { handleLiteratureMention } from '../src/journal/literature.js';

let vault: string;
let neurons: string;

beforeEach(() => {
  vault = mkdtempSync(path.join(tmpdir(), 'vault-journal-'));
  setLayout({ captureFolder: 'Synapses', notesFolder: 'Neurons', agentFolder: 'agent', dailyFolder: 'Daily' });
  neurons = path.join(vault, 'Neurons');
  mkdirSync(neurons, { recursive: true });
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

describe('captureToNote', () => {
  it('creates a new note in the capture folder with one type tag and a Timeline line', () => {
    const res = captureToNote(vault, { title: 'Ambition debt', noteType: 'concept', text: 'every year you delay going big compounds', date: '2026-11-14' });
    expect(res.action).toBe('created');
    expect(res.filePath).toBe(path.join(vault, 'Synapses', 'Ambition debt.md'));
    expect(readFileSync(res.filePath, 'utf-8')).toBe(
      '---\ntags:\n  - concept\n---\n# Ambition debt\n\n## Timeline\n- **2026-11-14** | every year you delay going big compounds [Source: voice chat]\n\n##### References\n',
    );
  });

  it('adds a dated line to an existing note found by alias, leaving the user text alone', () => {
    const file = path.join(neurons, 'Caleb Chanthi Raj.md');
    writeFileSync(file, '---\ntags:\n  - people\naliases:\n  - Caleb\n---\n# Caleb Chanthi Raj\n\n- Dean of LICET\n\n##### References\n');
    const res = captureToNote(vault, { title: 'Caleb', noteType: 'people', text: 'moving to Bangalore', date: '2026-11-14' });
    expect(res).toEqual({ action: 'appended', filePath: file });
    expect(readFileSync(file, 'utf-8')).toContain('- Dean of LICET\n\n## Timeline\n- **2026-11-14** | moving to Bangalore [Source: voice chat]\n\n##### References');
  });

  it('drops an invalid type tag and unsafe file name characters', () => {
    const res = captureToNote(vault, { title: 'a/b: c?', noteType: 'Not A Tag', text: 'x' });
    expect(path.basename(res.filePath)).toBe('a b c.md');
    expect(readFileSync(res.filePath, 'utf-8').startsWith('# a b c')).toBe(true);
  });
});

describe('older people and literature actions', () => {
  it('a person goes through capture', () => {
    const res = handlePersonMention('Alice', 'met at conference', vault);
    expect(res.action).toBe('created');
    const body = readFileSync(res.filePath, 'utf-8');
    expect(body).toContain('  - people');
    expect(body).toContain('met at conference');
  });

  it('never overwrites a same-named note, whatever its tag', () => {
    const file = path.join(neurons, 'Rust.md');
    writeFileSync(file, '---\ntags: [literature]\n---\n\n# Rust\n\nImportant existing content that must survive.\n');
    const res = handlePersonMention('Rust', 'someone named Rust', vault);
    expect(res.action).toBe('appended');
    const body = readFileSync(file, 'utf-8');
    expect(body).toContain('Important existing content that must survive.');
    expect(body).toContain('someone named Rust');
  });

  it('literature records the kind and source', () => {
    const res = handleLiteratureMention('Dune', 'book', 'Herbert', 'great read', vault);
    const body = readFileSync(res.filePath, 'utf-8');
    expect(body).toContain('  - literature');
    expect(body).toContain('great read (book, Herbert)');
  });
});
