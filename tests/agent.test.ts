import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync, existsSync, utimesSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { Agent, type AgentMessage, type AgentSettings } from '../src/agent/agent.js';
import { executeVaultActions, getPendingConfigEdit, PENDING_EDIT_KEY } from '../src/agent/execute-actions.js';
import { Store } from '../src/store/store.js';
import { setLayout, setVaultPath } from '../src/config/paths.js';
import { buildSystemPrompt } from '../src/brain/prompt-builder.js';
import { loadAgentConfig } from '../src/config/loader.js';
import { suppressPulses, resumePulses } from '../src/checkins/scheduler.js';
import type { EngineEvent, EngineSession, TurnResult } from '../src/engines/types.js';

const BOARD = ['## Backlog', '', '## To Do', '- [ ] Write intro ^aaa111', '- [ ] Gym ^bbb222', '', '## Doing', '', '## Done', ''].join('\n');

function makeVault(): string {
  const dir = join(tmpdir(), `agent-vault-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'Kanban.md'), BOARD, 'utf-8');
  return dir;
}

/** An engine that replies with canned text, streamed in small pieces, and records prompts. */
class FakeEngine implements EngineSession {
  readonly label = 'Fake';
  prompts: string[] = [];
  resets = 0;
  closed = false;
  constructor(public systemPrompt: string, private reply: (prompt: string) => string) {}
  async turn(prompt: string, onEvent: (e: EngineEvent) => void): Promise<TurnResult> {
    this.prompts.push(prompt);
    onEvent({ type: 'status', text: 'Reading a note' });
    const text = this.reply(prompt);
    for (let i = 0; i < text.length; i += 5) onEvent({ type: 'text', text: text.slice(i, i + 5) });
    return { interrupted: false };
  }
  interrupt() {}
  reset() { this.resets++; }
  close() { this.closed = true; }
}

const SETTINGS: AgentSettings = {
  agentName: 'Testy',
  checkpointTimes: { morning: '', midday: '', evening: '' },
  greetOnOpen: false,
  pulses: false,
  weather: false,
  capture: true,
  graduate: false,
  graduatePerDay: 5,
};

describe('Agent', () => {
  let vault: string;
  let store: Store;
  let engines: FakeEngine[];
  let delivered: AgentMessage[];
  let reply: (p: string) => string;
  let agent: Agent;
  let readOnlyEngines: FakeEngine[];

  beforeEach(async () => {
    vault = makeVault();
    setVaultPath(vault);
    setLayout({});
    store = new Store();
    engines = [];
    delivered = [];
    reply = () => 'Hello there.';
    readOnlyEngines = [];
    agent = new Agent(vault, store, (sys, opts) => {
      const e = new FakeEngine(sys, (p) => reply(p));
      (opts?.readOnly ? readOnlyEngines : engines).push(e);
      return e;
    }, SETTINGS, (m) => delivered.push(m));
    await agent.start();
  });

  afterEach(() => {
    agent.stop();
    suppressPulses();
    resumePulses();
  });

  it('tells the engine to file things, and files a note action into the capture folder', async () => {
    reply = () => 'Filed it.<actions>[{"type":"note","title":"Ambition debt","noteType":"concept","text":"every year you delay going big compounds"}]</actions>';
    await agent.handleUserMessage('I call it ambition debt: every year you delay going big compounds');
    expect(engines[0].systemPrompt).toContain('{"type":"note"');
    expect(engines[0].systemPrompt).toContain('Filing (the note action)');
    const note = readFileSync(join(vault, 'Inbox', 'Ambition debt.md'), 'utf-8');
    expect(note).toContain('  - concept');
    expect(note).toContain('every year you delay going big compounds [Source: voice chat]');
  });

  it('reports the notes a turn touched: its own edits and its actions', async () => {
    mkdirSync(join(vault, 'Neurons'), { recursive: true });
    writeFileSync(join(vault, 'Neurons', 'Caleb.md'), '# Caleb\n');
    engines.length = 0;
    agent.stop();
    const seen: string[] = [];
    const editing = new Agent(vault, store, (sys) => {
      const e = new FakeEngine(sys, () => 'Done.<actions>[{"type":"note","title":"Ambition debt","noteType":"concept","text":"x"},{"type":"add_task","text":"Call Caleb","column":"To Do"}]</actions>');
      e.turn = async (prompt, onEvent) => {
        onEvent({ type: 'file', path: join(vault, 'Neurons', 'Caleb.md') });
        onEvent({ type: 'text', text: 'Done.<actions>[{"type":"note","title":"Ambition debt","noteType":"concept","text":"x"},{"type":"add_task","text":"Call Caleb","column":"To Do"}]</actions>' });
        return { interrupted: false };
      };
      return e;
    }, SETTINGS, (m) => delivered.push(m));
    const out = await editing.handleUserMessage('go', { onChange: (c) => seen.push(`${c.kind} ${c.path}`) });
    expect(out.changes).toEqual([
      { kind: 'updated', path: 'Neurons/Caleb.md' },
      { kind: 'created', path: 'Inbox/Ambition debt.md' },
      { kind: 'updated', path: 'Kanban.md' },
    ]);
    expect(seen).toEqual(['updated Neurons/Caleb.md', 'created Inbox/Ambition debt.md', 'updated Kanban.md']);
  });

  it('leaves the filing rule out when capture is off', () => {
    const config = loadAgentConfig(join(vault, 'agent'));
    expect(buildSystemPrompt(config, { capture: false })).not.toContain('Filing (the note action)');
  });

  it('/graduate runs a note pass in a read-only engine and reports it', async () => {
    const file = join(vault, 'Inbox', 'Kanimozhi.md');
    mkdirSync(join(vault, 'Inbox'), { recursive: true });
    writeFileSync(file, '---\ntags:\n  - people\n---\n# Kanimozhi\n');
    const old = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    utimesSync(file, old, old);
    reply = (p) => p.includes('<<<note')
      ? '<actions>[{"type":"ask_note","file":"Inbox/Kanimozhi.md","question":"How do you know Kanimozhi?"}]</actions>'
      : 'Hello there.';
    const ack = await agent.handleUserMessage('/graduate');
    expect(ack.text).toContain('Working through up to 5');
    await vi.waitFor(() => expect(delivered.map(d => d.text)).toContain('Note pass done: left 1 question in notes.'));
    expect(readOnlyEngines).toHaveLength(1);
    expect(engines).toHaveLength(0);
    const pass = delivered.find(d => d.source === 'note-pass')!;
    expect(pass.speak).toBe(false);
    expect(pass.changes).toEqual([{ kind: 'asked', path: 'Inbox/Kanimozhi.md' }]);
    expect(readFileSync(file, 'utf-8')).toContain('> How do you know Kanimozhi?');
  });

  it('the startup greeting mentions what the note pass did, once', async () => {
    agent.stop();
    await store.setSessionState('graduation', JSON.stringify({ asked: {}, report: { moved: ['Maria B'], asked: [], trashed: [] } }));
    const greeter = new Agent(vault, store, (sys) => {
      const e = new FakeEngine(sys, () => 'Morning. Maria B moved to your notes.');
      engines.push(e);
      return e;
    }, { ...SETTINGS, greetOnOpen: true }, (m) => delivered.push(m));
    await greeter.start();
    await vi.waitFor(() => expect(delivered.map(d => d.source)).toContain('startup-briefing'));
    expect(engines.at(-1)!.prompts[0]).toContain('- Moved to notes: Maria B');
    await vi.waitFor(async () => expect(JSON.parse((await store.getSessionState('graduation'))!).report.moved).toEqual([]));
    greeter.stop();
  });

  it('creates starter agent files on first start', () => {
    for (const f of ['soul.md', 'identity.md', 'user.md', 'goals.md', 'memory.md']) {
      expect(existsSync(join(vault, 'agent', f))).toBe(true);
    }
  });

  it('streams a reply without the actions block and runs the actions', async () => {
    reply = () => 'On it, moving Write intro to Doing.<actions>[{"type":"move_task","task":"Write intro","from":"To Do","to":"Doing"}]</actions>';
    let shown = '';
    const statuses: string[] = [];
    const out = await agent.handleUserMessage('start the intro', { spoken: true, onText: t => { shown += t; }, onStatus: s => statuses.push(s) });

    expect(shown).toBe('On it, moving Write intro to Doing.');
    expect(out.text).toBe('On it, moving Write intro to Doing.');
    expect(out.actions).toHaveLength(1);
    expect(statuses).toEqual(['Reading a note']);
    const board = readFileSync(join(vault, 'Kanban.md'), 'utf-8');
    expect(board.indexOf('Write intro')).toBeGreaterThan(board.indexOf('## Doing'));
  });

  it('sends the live context and the user words, and the persona once', async () => {
    await agent.handleUserMessage('what now?', { spoken: true });
    const [engine] = engines;
    expect(engine.systemPrompt).toContain('You are Testy');
    expect(engine.systemPrompt).toContain('Daily');
    expect(engine.prompts[0]).toContain('[Context]');
    expect(engine.prompts[0]).toContain('Write intro');
    expect(engine.prompts[0]).toContain('Columns: Backlog, To Do, Doing, Done (any of these is valid in an action)');
    expect(engine.prompts[0]).toContain('speech recognition');
    expect(engine.prompts[0].trim().endsWith('what now?')).toBe(true);
    await agent.handleUserMessage('and then?');
    expect(engines).toHaveLength(1); // same conversation
  });

  it('starts a new conversation when the personality files change', async () => {
    await agent.handleUserMessage('hi');
    const soul = join(vault, 'agent', 'soul.md');
    writeFileSync(soul, readFileSync(soul, 'utf-8') + '\n- New rule.\n');
    await agent.handleUserMessage('hi again');
    expect(engines).toHaveLength(2);
    expect(engines[0].closed).toBe(true);
    expect(engines[1].systemPrompt).toContain('New rule.');
  });

  it('adds failures to the reply, but not successes the engine already announced', async () => {
    reply = () => 'Pushed Gym to Friday, and moved Ghost.<actions>[{"type":"reschedule_task","task":"Gym","newDate":"2026-11-13"},{"type":"move_task","task":"Ghost","from":"To Do","to":"Doing"}]</actions>';
    let shown = '';
    await agent.handleUserMessage('do it', { onText: t => { shown += t; } });
    expect(shown).toBe('Pushed Gym to Friday, and moved Ghost.\nI couldn\'t find "Ghost" on the board, so nothing moved.');
  });

  it('describes actions when the engine says nothing else', async () => {
    reply = () => '<actions>[{"type":"add_task","text":"Call mom","column":"To Do"}]</actions>';
    let shown = '';
    await agent.handleUserMessage('add call mom', { onText: t => { shown += t; } });
    expect(shown).toBe('Added "Call mom" to To Do.');
  });

  it('handles /pause and /resume without the engine', async () => {
    const out = await agent.handleUserMessage('/pause');
    expect(out.text).toMatch(/Paused/);
    expect(engines).toHaveLength(0);
    expect(await store.getSessionState('agent_paused')).toBe('1');
    await agent.handleUserMessage('/resume');
    expect(await store.getSessionState('agent_paused')).toBeNull();
  });

  it('reports an engine failure as an error, not a reply', async () => {
    agent.setEngineFactory((sys) => {
      const e = new FakeEngine(sys, () => '');
      e.turn = async () => ({ interrupted: false, error: 'not signed in' });
      return e;
    });
    const out = await agent.handleUserMessage('hello');
    expect(out.error).toBe('not signed in');
    expect(out.text).toBe('');
  });

  it('asks for an estimate when a card enters Doing, and starts a focus session from the answer', async () => {
    // Midday, so the board poll is not skipped for quiet hours (23:00-08:00).
    const noon = new Date();
    noon.setHours(12, 0, 0, 0);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'], now: noon });
    try {
      const file = join(vault, 'Kanban.md');
      writeFileSync(file, BOARD.replace('## Doing\n', '## Doing\n- [ ] Write intro ^aaa111\n').replace('- [ ] Write intro ^aaa111\n- [ ] Gym', '- [ ] Gym'));
      await agent.pollKanban();
      expect(delivered.map(d => d.source)).toContain('task-start');
      const out = await agent.handleUserMessage('about an hour');
      expect(out.text).toMatch(/check in at/);
      expect(await store.getActiveSessions()).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('executeVaultActions', () => {
  let vault: string;
  let store: Store;
  beforeEach(async () => {
    vault = makeVault();
    setVaultPath(vault);
    setLayout({});
    store = new Store();
    const agent = new Agent(vault, store, () => new FakeEngine('', () => ''), SETTINGS, () => undefined);
    await agent.start(); // creates the agent files
    agent.stop();
  });

  it('reschedules a card by title and confirms', async () => {
    const out = await executeVaultActions(vault, store, [{ type: 'reschedule_task', task: 'Gym', newDate: '2026-11-12' }]);
    expect(out).toEqual([{ text: 'Moved "Gym" to 2026-11-12.', ok: true }]);
    expect(readFileSync(join(vault, 'Kanban.md'), 'utf-8')).toContain('Gym @{2026-11-12}');
  });

  it('says so when a card is not on the board', async () => {
    const out = await executeVaultActions(vault, store, [{ type: 'complete_task', task: 'Nope', from: 'To Do' }]);
    expect(out[0].ok).toBe(false);
    expect(out[0].text).toMatch(/couldn't find "Nope"/);
  });

  it('records memory without asking', async () => {
    await executeVaultActions(vault, store, [{ type: 'update_memory', observation: 'Prefers mornings' }]);
    expect(loadAgentConfig(join(vault, 'agent')).memory[0]).toMatch(/Prefers mornings/);
  });

  it('gates config edits: propose stages, apply writes, discard drops', async () => {
    await executeVaultActions(vault, store, [{
      type: 'propose_config_edit', file: 'identity.md', section: 'What I never do',
      operation: 'append_bullet', content: 'Never say synergy.', rationale: 'User asked.',
    }]);
    expect(readFileSync(join(vault, 'agent', 'identity.md'), 'utf-8')).not.toContain('synergy');
    expect(await getPendingConfigEdit(store)).not.toBeNull();

    const out = await executeVaultActions(vault, store, [{ type: 'apply_config_edit' }]);
    expect(out).toEqual([{ text: 'Done. identity.md updated.', ok: true }]);
    expect(readFileSync(join(vault, 'agent', 'identity.md'), 'utf-8')).toContain('Never say synergy.');
    expect(await store.getSessionState(PENDING_EDIT_KEY)).toBeNull();
  });

  it('expires a stale proposal', async () => {
    await store.setSessionState(PENDING_EDIT_KEY, JSON.stringify({
      edit: { file: 'goals.md', section: 'This year', operation: 'append_bullet', content: 'x' },
      rationale: 'r', proposedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    }));
    expect(await getPendingConfigEdit(store)).toBeNull();
  });

  it('refuses to stage an edit to memory.md (ungated)', async () => {
    await executeVaultActions(vault, store, [{
      type: 'propose_config_edit', file: 'memory.md', section: 'Entries',
      operation: 'append_bullet', content: 'x', rationale: 'r',
    }]);
    expect(await getPendingConfigEdit(store)).toBeNull();
  });
});

describe('Store', () => {
  it('persists after each change and round-trips', async () => {
    let saved: unknown = null;
    const store = new Store(null, (d) => { saved = d; });
    await store.setSessionState('a', '1');
    const id = await store.createFocusSession({
      taskText: 't', rawTaskLine: '- [ ] t', estimatedMinutes: 30, estimateSource: 'user',
      startedAt: new Date().toISOString(), deadlineAt: new Date().toISOString(),
    });
    await store.updateFocusSession(id, { status: 'completed', completedAt: new Date().toISOString() });
    const copy = new Store(saved as any);
    expect(await copy.getSessionState('a')).toBe('1');
    expect(await copy.getActiveSessions()).toHaveLength(0);
    expect(await copy.getCompletedSessions('2000-01-01')).toHaveLength(1);
  });

  it('counts outgoing messages since the last incoming one', async () => {
    const store = new Store();
    const msg = (direction: 'incoming' | 'outgoing') => store.storeMessage({
      id: Math.random().toString(), channel: 'text', direction, text: 'x', timestamp: new Date(), wasVoiceNote: false, replied: false,
    });
    await msg('outgoing'); await msg('incoming'); await msg('outgoing'); await msg('outgoing');
    expect(await store.getConsecutiveIgnoredPulses()).toBe(2);
    const recent = await store.getMessages(10);
    expect(recent[0].direction).toBe('outgoing');
    expect(recent[0].timestamp).toBeInstanceOf(Date);
  });

  it('computes a workout streak that tolerates no workout yet today', async () => {
    const store = new Store();
    const now = new Date('2026-11-10T12:00:00Z');
    await store.trackWorkout('2026-11-09');
    await store.trackWorkout('2026-11-08');
    expect(await store.getWorkoutStreak(now)).toBe(2);
  });
});

describe('buildSystemPrompt', () => {
  it('keeps the agent out of daily notes and documents the actions block', () => {
    setLayout({ dailyFolder: 'Journal/Days' });
    const prompt = buildSystemPrompt({
      soul: 'S', identity: 'I', user: 'U', goals: 'G', memory: ['[2026-11-10] newest', '[2026-11-01] older'],
      userMeta: {} as any,
    }, { agentName: 'Cortana' });
    expect(prompt).toContain('NEVER read, search, open or write anything under "Journal/Days/"');
    expect(prompt).toContain('<actions>');
    expect(prompt.indexOf('newest')).toBeLessThan(prompt.indexOf('older'));
    setLayout({});
  });
});
