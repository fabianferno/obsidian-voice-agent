import { describe, expect, it } from 'vitest';
import { codexArgs, parseCodexLine, unwrapShell } from '../src/engines/codex.js';
import { antigravityArgs, parseAntigravityLine } from '../src/engines/antigravity.js';
import { newLineState } from '../src/engines/per-turn.js';

const opts = { bin: 'x', cwd: '/v', permissions: 'edit' as const, extraArgs: [], systemPrompt: 'SYS' };

describe('codex', () => {
  it('builds first-turn and resume arguments', () => {
    expect(codexArgs(opts, 'hi')).toEqual([
      'exec', '--json', '--skip-git-repo-check', '-c', 'developer_instructions="SYS"', '-c', 'sandbox_mode="workspace-write"', '--', 'hi',
    ]);
    // Quotes and newlines survive as a TOML basic string.
    const tricky = codexArgs({ ...opts, systemPrompt: 'Say "hi"\nthen stop' }, 'x');
    expect(tricky).toContain('developer_instructions="Say \\"hi\\"\\nthen stop"');
    const resumed = codexArgs({ ...opts, permissions: 'full' }, 'more', 'thread-1');
    expect(resumed.slice(0, 3)).toEqual(['exec', 'resume', '--json']);
    expect(resumed).toContain('--dangerously-bypass-approvals-and-sandbox');
    expect(resumed.slice(-2)).toEqual(['thread-1', 'more']);
    expect(resumed.some(a => a.startsWith('developer_instructions='))).toBe(false);
  });

  it('parses real `codex exec --json` output', () => {
    // Captured from codex-cli 0.166.0.
    const lines = [
      { type: 'thread.started', thread_id: '01a1c4e6' },
      { type: 'turn.started' },
      { type: 'item.started', item: { id: 'item_1', type: 'command_execution', command: 'ls Daily' } },
      { type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text: 'hello there.' } },
      { type: 'item.completed', item: { id: 'item_2', type: 'agent_message', text: 'Done.' } },
      { type: 'turn.completed', usage: {} },
    ];
    const state = newLineState();
    const parsed = lines.map((l) => parseCodexLine(l, state));
    expect(parsed[0]!.conversationId).toBe('01a1c4e6');
    expect(parsed[2]!.events).toEqual([{ type: 'status', text: 'Running ls Daily' }]);
    expect(parsed[3]!.events).toEqual([{ type: 'text', text: 'hello there.' }]);
    expect(parsed[4]!.events).toEqual([{ type: 'text', text: '\nDone.' }]);
    expect(parseCodexLine({ type: 'turn.failed', error: { message: 'quota' } }, state).error).toBe('quota');
  });

  it('shows the command without the shell wrapper', () => {
    expect(unwrapShell(`/bin/zsh -lc "cat 'Projects/Garden Project.md'"`)).toBe(`cat 'Projects/Garden Project.md'`);
    expect(unwrapShell('bash -c ls')).toBe('bash -c ls');
  });
});

describe('antigravity', () => {
  it('puts the prompt last and passes the conversation id', () => {
    const args = antigravityArgs(opts, 'hi', 'conv-1');
    expect(args.slice(-2)).toEqual(['-p', 'hi']);
    expect(args).toEqual(expect.arrayContaining(['--mode', 'accept-edits', '--conversation', 'conv-1']));
  });

  it('parses real `agy -p --output-format stream-json` output', () => {
    // Captured from agy 1.5.4.
    const lines = [
      { event: 'init', conversation_id: 'b85dc2d8', init: {} },
      { event: 'step_update', step_update: { step_index: 0, state: 'DONE', step_type: 'user_input' } },
      { event: 'step_update', step_update: { step_index: 1, state: 'ACTIVE', step_type: 'view_file' } },
      { event: 'step_update', step_update: { step_index: 1, state: 'ACTIVE', step_type: 'view_file' } },
      { event: 'step_update', step_update: { step_index: 2, state: 'ACTIVE', step_type: 'agent_response', text_delta: 'hello ' } },
      { event: 'step_update', step_update: { step_index: 2, state: 'DONE', step_type: 'agent_response', text_delta: 'there.' } },
      { event: 'result', result: { conversation_id: 'b85dc2d8', status: 'SUCCESS', response: 'hello there.' } },
    ];
    const state = newLineState();
    const parsed = lines.map((l) => parseAntigravityLine(l, state));
    expect(parsed[0]!.conversationId).toBe('b85dc2d8');
    expect(parsed[1]!.events).toEqual([]);
    expect(parsed[2]!.events).toEqual([{ type: 'status', text: 'Reading' }]);
    expect(parsed[3]!.events).toEqual([]); // same step, not repeated
    expect(parsed[4]!.events).toEqual([{ type: 'text', text: 'hello ' }]);
    expect(parsed[5]!.events).toEqual([{ type: 'text', text: 'there.' }]);
    expect(parsed[6]!.error).toBeUndefined();
    expect(parseAntigravityLine({ event: 'result', result: { status: 'FAILED', error: 'nope' } }, state).error).toBe('nope');
  });

  it('names the tool in tool steps', () => {
    const step = {
      event: 'step_update',
      step_update: { step_index: 3, state: 'ACTIVE', step_type: 'tool', tool_name: 'read_file', tool_info: { parameters: { Path: '/v/Projects/Garden Project.md' } } },
    };
    expect(parseAntigravityLine(step, newLineState()).events).toEqual([{ type: 'status', text: 'Reading Projects/Garden Project.md' }]);
  });

  it('turns a silent permission denial into an error', () => {
    // agy reports SUCCESS with an empty response when headless mode denied a tool.
    const denied = { event: 'result', result: { status: 'SUCCESS', response: '', denied_actions: [{ action: 'command', display_name: 'RunCommand' }] } };
    expect(parseAntigravityLine(denied, newLineState()).error).toMatch(/not allowed to use RunCommand/);
  });

  it('allows read-only commands in edit mode', () => {
    const args = antigravityArgs(opts, 'hi');
    const settings = JSON.parse(args[args.indexOf('--settings') + 1]!);
    expect(settings.permissions.allow).toContain('command(find)');
    expect(antigravityArgs({ ...opts, permissions: 'full' }, 'hi')).not.toContain('--settings');
  });
});
