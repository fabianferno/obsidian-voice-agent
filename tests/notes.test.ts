import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { setLayout } from '../src/config/paths.js';
import {
  addQuestion, appendTimeline, findNote, hasQuestion, missingUserLines, questionText, removeQuestions, timelineLine, userLines,
} from '../src/vault/notes.js';

const NOTE = `---
tags:
  - people
---
# Maria B
- From Germany
- Product manager

##### References
`;

describe('timeline', () => {
  it('creates the section above References', () => {
    const out = appendTimeline(NOTE, timelineLine('2026-11-14', 'Moved to Berlin', 'voice chat'));
    expect(out).toContain('- Product manager\n\n## Timeline\n- **2026-11-14** | Moved to Berlin [Source: voice chat]\n\n##### References');
  });

  it('appends to an existing section, before the next heading', () => {
    const once = appendTimeline(NOTE, '- one');
    const twice = appendTimeline(once, '- two');
    expect(twice).toContain('## Timeline\n- one\n- two\n\n##### References');
  });

  it('adds the section at the end when there is no References heading', () => {
    expect(appendTimeline('# X\n- a\n', '- b')).toBe('# X\n- a\n\n## Timeline\n- b\n');
  });
});

describe('question callout', () => {
  it('goes under the title and replaces an older one', () => {
    const asked = addQuestion(NOTE, 'How did you meet?');
    expect(asked).toContain('# Maria B\n\n> [!question] Voice Agent\n> How did you meet?\n\n- From Germany');
    expect(questionText(asked)).toBe('How did you meet?');
    const again = addQuestion(asked, 'Still in touch?');
    expect(again.match(/\[!question\]/g)).toHaveLength(1);
    expect(questionText(again)).toBe('Still in touch?');
  });

  it('is removed, keeping what the user typed inside it', () => {
    const answered = addQuestion(NOTE, 'How did you meet?').replace('> How did you meet?', '> How did you meet?\n> At EthCC');
    const out = removeQuestions(answered);
    expect(hasQuestion(out)).toBe(false);
    expect(out).toContain('At EthCC');
    expect(out).not.toContain('How did you meet?');
  });
});

describe('user lines', () => {
  it('ignore the question, title and References', () => {
    const asked = addQuestion(NOTE, 'How did you meet?');
    expect(userLines(asked)).toEqual(['From Germany', 'Product manager']);
  });

  it('flag a rewrite that drops the user words', () => {
    const rewritten = NOTE.replace('- From Germany\n- Product manager', 'Maria is a German product manager.');
    expect(missingUserLines(NOTE, rewritten)).toEqual(['From Germany', 'Product manager']);
  });

  it('accept a restructure that keeps every line (summary added, bullets moved, answer folded in)', () => {
    const answered = addQuestion(NOTE, 'How did you meet?').replace('> How did you meet?', '> How did you meet?\n> At EthCC');
    const restructured = `---\ntags:\n  - people\n---\n# Maria B\nPM from Germany, met at EthCC.\n\n- Product manager\n- From Germany\n- At EthCC\n\n##### References\n`;
    expect(missingUserLines(answered, restructured)).toEqual([]);
  });
});

describe('findNote', () => {
  let vault: string;
  beforeEach(() => {
    vault = mkdtempSync(path.join(tmpdir(), 'notes-'));
    setLayout({ agentFolder: 'agent', dailyFolder: 'Daily' });
    mkdirSync(path.join(vault, 'Neurons'));
    mkdirSync(path.join(vault, 'Daily'));
    writeFileSync(path.join(vault, 'Neurons', 'Caleb Chanthi Raj.md'), '---\naliases:\n  - Caleb\n---\n# Caleb\n');
    writeFileSync(path.join(vault, 'Daily', 'Secret.md'), '# Secret\n');
  });
  afterEach(() => rmSync(vault, { recursive: true, force: true }));

  it('matches the file name or an alias, case-insensitively, never in the daily folder', () => {
    expect(findNote(vault, 'caleb chanthi raj')).toContain('Caleb Chanthi Raj.md');
    expect(findNote(vault, 'Caleb')).toContain('Caleb Chanthi Raj.md');
    expect(findNote(vault, 'Secret')).toBeNull();
    expect(findNote(vault, 'Nobody')).toBeNull();
  });
});

describe('layout', () => {
  it('adds .md to a board path given without it', async () => {
    const { getLayout } = await import('../src/config/paths.js');
    setLayout({ boardPath: '00 Meta/Boards/Inbox' });
    expect(getLayout().boardPath).toBe('00 Meta/Boards/Inbox.md');
    setLayout({ boardPath: 'Kanban.md' });
    expect(getLayout().boardPath).toBe('Kanban.md');
  });
});
