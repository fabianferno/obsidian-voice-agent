import { describe, expect, it } from 'vitest';
import { addChange, describeChange } from '../src/agent/changes.js';
import { parseClaudeLine } from '../src/engines/claude.js';
import { parseCodexLine } from '../src/engines/codex.js';
import { parseAntigravityLine } from '../src/engines/antigravity.js';
import { newLineState } from '../src/engines/per-turn.js';
import { Transcript } from '../src/plugin/transcript.js';

describe('change list', () => {
  it('keeps one entry per file, the strongest kind winning', () => {
    let list = addChange([], { kind: 'created', path: 'Synapses/A.md' });
    list = addChange(list, { kind: 'updated', path: 'Synapses/A.md' });
    list = addChange(list, { kind: 'updated', path: 'Neurons/B.md' });
    expect(list).toEqual([{ kind: 'created', path: 'Synapses/A.md' }, { kind: 'updated', path: 'Neurons/B.md' }]);
  });

  it('describes changes by note name', () => {
    expect(describeChange({ kind: 'created', path: '01 Synapses/Ambition debt.md' })).toBe('Created Ambition debt');
    expect(describeChange({ kind: 'moved', path: '01 Synapses/Maria B.md', to: '02 Neurons/Maria B.md' })).toBe('Moved Maria B to 02 Neurons');
    expect(describeChange({ kind: 'asked', path: '01 Synapses/Kanimozhi.md' })).toBe('Asked a question in Kanimozhi');
  });

  it('lands on the transcript entry', () => {
    const t = new Transcript();
    const h = t.agentStart('reply');
    h.change({ kind: 'updated', path: 'Neurons/B.md' });
    h.change({ kind: 'updated', path: 'Neurons/B.md' });
    expect(t.entries.at(-1)!.changes).toEqual([{ kind: 'updated', path: 'Neurons/B.md' }]);
  });
});

describe('engines report file edits', () => {
  it('claude: Write and Edit tool calls, not Read', () => {
    const line = (name: string) => ({
      type: 'assistant', parent_tool_use_id: null,
      message: { content: [{ type: 'tool_use', name, input: { file_path: '/v/Neurons/B.md' } }] },
    });
    expect(parseClaudeLine(line('Edit'), { hadText: false }).events).toContainEqual({ type: 'file', path: '/v/Neurons/B.md' });
    expect(parseClaudeLine(line('Read'), { hadText: false }).events.some(e => e.type === 'file')).toBe(false);
  });

  it('codex: file_change items with their kind', () => {
    const out = parseCodexLine({ type: 'item.completed', item: { type: 'file_change', changes: [{ path: 'A.md', kind: 'add' }, { path: 'B.md', kind: 'update' }] } }, newLineState());
    expect(out.events).toEqual([{ type: 'file', path: 'A.md', kind: 'created' }, { type: 'file', path: 'B.md', kind: 'updated' }]);
  });

  it('antigravity: write steps', () => {
    const out = parseAntigravityLine({ event: 'step_update', step_update: { step_index: 3, state: 'ACTIVE', step_type: 'tool', tool_name: 'write_to_file', tool_info: { parameters: { Path: '/v/A.md' } } } }, newLineState());
    expect(out.events).toContainEqual({ type: 'file', path: '/v/A.md' });
  });
});
