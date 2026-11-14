import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { setLayout } from '../src/config/paths.js';
import { Store } from '../src/store/store.js';
import type { EngineEvent, EngineSession, TurnResult } from '../src/engines/types.js';
import {
  Graduation, fsVaultOps, loadGraduationState, parseGraduationReply, pickCandidates, saveGraduationState,
} from '../src/agent/graduation.js';
import { addQuestion } from '../src/vault/notes.js';

class ScriptedEngine implements EngineSession {
  readonly label = 'Scripted';
  prompts: string[] = [];
  closed = false;
  constructor(public systemPrompt: string, private reply: (prompt: string) => string) {}
  async turn(prompt: string, onEvent: (e: EngineEvent) => void): Promise<TurnResult> {
    this.prompts.push(prompt);
    onEvent({ type: 'text', text: this.reply(prompt) });
    return { interrupted: false };
  }
  interrupt() {}
  reset() {}
  close() { this.closed = true; }
}

const NOW = new Date('2026-11-14T10:00:00');
const DAY = 24 * 60 * 60 * 1000;
const MARIA = '---\ntags:\n  - people\n---\n# Maria B\n- From Germany\n- Product manager\n\n##### References\n';

const block = (a: object) => `<actions>${JSON.stringify([a])}</actions>`;

describe('graduation', () => {
  let vault: string;
  let store: Store;
  let engines: ScriptedEngine[];

  const write = (rel: string, content: string, ageMs: number) => {
    const file = path.join(vault, rel);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, content);
    const t = new Date(NOW.getTime() - ageMs);
    utimesSync(file, t, t);
  };
  const read = (rel: string) => readFileSync(path.join(vault, rel), 'utf-8');
  const graduation = (reply: (prompt: string) => string) =>
    new Graduation(vault, store, (sys) => {
      const e = new ScriptedEngine(sys, reply);
      engines.push(e);
      return e;
    }, fsVaultOps(vault));

  beforeEach(() => {
    vault = mkdtempSync(path.join(tmpdir(), 'grad-'));
    setLayout({ captureFolder: 'Synapses', notesFolder: 'Neurons', agentFolder: 'agent', dailyFolder: 'Daily' });
    store = new Store();
    engines = [];
  });
  afterEach(() => rmSync(vault, { recursive: true, force: true }));

  it('picks answered notes first, then notes quiet for 48 hours, oldest first', async () => {
    write('Synapses/Fresh.md', '# Fresh\n- new\n', 2 * 60 * 60 * 1000);
    write('Synapses/Old.md', '# Old\n- old\n', 5 * DAY);
    write('Synapses/Older.md', '# Older\n- older\n', 9 * DAY);
    write('Synapses/Asked.md', addQuestion('# Asked\n- a\n', 'Who?'), 3 * DAY);
    const state = await loadGraduationState(store);
    // First sight of a note that already has a question: recorded, not picked.
    expect(pickCandidates(vault, state, NOW, 5).map(c => c.rel)).toEqual(['Synapses/Older.md', 'Synapses/Old.md']);
    expect(state.asked['Synapses/Asked.md']).toBeDefined();
    // The user answers it; once it has settled for an hour it comes first.
    write('Synapses/Asked.md', read('Synapses/Asked.md') + '- Met at EthCC\n', 2 * 60 * 60 * 1000);
    const picked = pickCandidates(vault, state, NOW, 2);
    expect(picked).toEqual([{ rel: 'Synapses/Asked.md', answered: true, question: 'Who?' }, { rel: 'Synapses/Older.md', answered: false }]);
  });

  it('moves a ready note to the notes folder with its new shape, and logs it', async () => {
    write('Synapses/Maria B.md', MARIA, 3 * DAY);
    const content = '---\ntags:\n  - people\n---\n# Maria B\nProduct manager from Germany.\n\n- From Germany\n- Product manager\n\n## Timeline\n- **2026-11-14** | Teammate on Binder [Source: Binder]\n\n##### References\n';
    const result = await graduation(() => block({ type: 'graduate_note', file: 'Synapses/Maria B.md', content })).run(5, NOW);
    expect(result.moved).toEqual(['Maria B']);
    expect(existsSync(path.join(vault, 'Synapses/Maria B.md'))).toBe(false);
    expect(read('Neurons/Maria B.md')).toBe(content);
    expect(read('agent/log.md')).toContain('## [2026-11-14] graduate | Maria B');
    expect(engines).toHaveLength(1);
    expect(engines[0].closed).toBe(true);
    expect(engines[0].prompts[0]).toContain('- From Germany');
    expect((await loadGraduationState(store)).report.moved).toEqual(['Maria B']);
  });

  it('refuses a rewrite that drops the user words and leaves the note alone', async () => {
    write('Synapses/Maria B.md', MARIA, 3 * DAY);
    const content = '---\ntags:\n  - people\n---\n# Maria B\nMaria is a German product manager.\n';
    const result = await graduation(() => block({ type: 'graduate_note', file: 'Synapses/Maria B.md', content })).run(5, NOW);
    expect(result.moved).toEqual([]);
    expect(result.skipped[0].reason).toContain('dropped 2');
    expect(read('Synapses/Maria B.md')).toBe(MARIA);
  });

  it('never overwrites a note of the same name in the notes folder', async () => {
    write('Synapses/Maria B.md', MARIA, 3 * DAY);
    write('Neurons/Maria B.md', '# Other Maria\n', 3 * DAY);
    const result = await graduation(() => block({ type: 'graduate_note', file: 'Synapses/Maria B.md', content: MARIA })).run(5, NOW);
    expect(result.skipped[0].reason).toContain('already exists');
    expect(read('Neurons/Maria B.md')).toBe('# Other Maria\n');
  });

  it('asks a question inside a thin note, then waits for an answer', async () => {
    write('Synapses/Kanimozhi.md', '---\ntags:\n  - people\n---\n# Kanimozhi\n\n##### References\n', 3 * DAY);
    const g = graduation(() => block({ type: 'ask_note', file: 'Synapses/Kanimozhi.md', question: 'How do you know Kanimozhi?' }));
    const result = await g.run(5, NOW);
    expect(result.asked).toEqual(['Kanimozhi']);
    expect(read('Synapses/Kanimozhi.md')).toContain('# Kanimozhi\n\n> [!question] Voice Agent\n> How do you know Kanimozhi?\n');
    // Not picked again until the user writes something.
    const state = await loadGraduationState(store);
    expect(pickCandidates(vault, state, new Date(NOW.getTime() + 3 * DAY), 5)).toEqual([]);
  });

  it('trashes only a note whose delete question the user answered', async () => {
    write('Synapses/country.md', '', 3 * DAY);
    const trash = () => block({ type: 'trash_note', file: 'Synapses/country.md' });
    const first = await graduation(trash).run(5, NOW);
    expect(first.skipped[0].reason).toContain('not answered');
    expect(existsSync(path.join(vault, 'Synapses/country.md'))).toBe(true);

    write('Synapses/country.md', addQuestion('', 'This note is empty. Delete it?'), 3 * DAY);
    const state = await loadGraduationState(store);
    pickCandidates(vault, state, NOW, 5); // records the question
    await saveGraduationState(store, state);
    write('Synapses/country.md', read('Synapses/country.md') + 'yes\n', 2 * 60 * 60 * 1000);
    const second = await graduation(trash).run(5, NOW);
    expect(second.trashed).toEqual(['country']);
    expect(existsSync(path.join(vault, '.trash/country.md'))).toBe(true);
  });

  it('does not start an engine when there is nothing to do', async () => {
    write('Synapses/Fresh.md', '# Fresh\n', 60 * 1000);
    await graduation(() => '').run(5, NOW);
    expect(engines).toHaveLength(0);
    expect((await loadGraduationState(store)).lastRun).toBe('2026-11-14');
  });

  it('parses only well-formed actions', () => {
    const raw = `ok <actions>[{"type":"graduate_note","file":"a.md"},{"type":"ask_note","file":"b.md","question":"Q?"},{"type":"nope"}]</actions>`;
    expect(parseGraduationReply(raw)).toEqual([{ type: 'ask_note', file: 'b.md', question: 'Q?' }]);
  });
});
