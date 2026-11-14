import { chmodSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { ClaudeSession, claudeArgs, claudeDeniedTools, parseClaudeLine } from '../src/engines/claude.js';
import type { EngineEvent } from '../src/engines/types.js';

const FAKE = resolve(__dirname, 'fixtures/fake-claude.mjs');

describe('parseClaudeLine', () => {
  it('reads the session id, text deltas, tool use and the result', () => {
    const state = { hadText: false };
    expect(parseClaudeLine({ type: 'system', subtype: 'init', session_id: 's1' }, state).sessionId).toBe('s1');

    const delta = parseClaudeLine(
      { type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hi' } } },
      state,
    );
    expect(delta.events).toEqual([{ type: 'text', text: 'Hi' }]);

    // A second assistant message after text gets a separator.
    const next = parseClaudeLine({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'message_start' } }, state);
    expect(next.events).toEqual([{ type: 'text', text: '\n' }]);

    const tool = parseClaudeLine(
      { type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: '/v/Projects/Garden.md' } }] } },
      state,
    );
    expect(tool.events).toEqual([{ type: 'status', text: 'Editing Projects/Garden.md' }, { type: 'file', path: '/v/Projects/Garden.md' }]);

    expect(parseClaudeLine({ type: 'result', is_error: false, session_id: 's1' }, state).result).toEqual({});
    expect(parseClaudeLine({ type: 'result', is_error: true, result: 'boom' }, state).result).toEqual({ error: 'boom' });
  });

  it('ignores subagent output', () => {
    const parsed = parseClaudeLine(
      { type: 'stream_event', parent_tool_use_id: 'x', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'no' } } },
      { hadText: false },
    );
    expect(parsed.events).toEqual([]);
  });
});

describe('claudeArgs', () => {
  const base = { bin: 'claude', cwd: '/v', permissions: 'edit' as const, extraArgs: [], systemPrompt: 'SYS' };
  it('accepts edits by default and resumes when given a session', () => {
    const args = claudeArgs(base, 'abc');
    expect(args).toContain('acceptEdits');
    expect(args.slice(args.indexOf('--resume'))).toEqual(['--resume', 'abc']);
  });
  it('skips permissions in full mode and passes model and extra args', () => {
    const args = claudeArgs({ ...base, permissions: 'full', model: 'sonnet', extraArgs: ['--foo'] });
    expect(args).toContain('--dangerously-skip-permissions');
    expect(args).not.toContain('acceptEdits');
    expect(args).toEqual(expect.arrayContaining(['--model', 'sonnet', '--foo']));
  });
  it('read-only blocks edits and ignores full permissions', () => {
    const args = claudeArgs({ ...base, permissions: 'full', readOnly: true });
    expect(args).not.toContain('--dangerously-skip-permissions');
    expect(args.slice(args.indexOf('--permission-mode'), args.indexOf('--permission-mode') + 2)).toEqual(['--permission-mode', 'default']);
    expect(args).toEqual(expect.arrayContaining(['Edit', 'Write', 'NotebookEdit']));
  });
});

describe('claudeDeniedTools', () => {
  it('blocks reading and writing denied folders, and editing protected paths', () => {
    const rules = claudeDeniedTools({ denyPaths: ['03 Cortex/Daily'], protectPaths: ['00 Meta/Boards/Inbox.md', 'agent'] });
    expect(rules).toEqual([
      'Read(03 Cortex/Daily/**)', 'Edit(03 Cortex/Daily/**)', 'Write(03 Cortex/Daily/**)',
      'Edit(00 Meta/Boards/Inbox.md)', 'Write(00 Meta/Boards/Inbox.md)',
      'Edit(agent/**)', 'Write(agent/**)',
    ]);
  });
  it('passes the rules and the system prompt to claude', () => {
    const args = claudeArgs({ bin: 'claude', cwd: '/v', permissions: 'edit', extraArgs: [], systemPrompt: 'BE NICE', denyPaths: ['D'] });
    expect(args.slice(args.indexOf('--append-system-prompt'), args.indexOf('--append-system-prompt') + 2)).toEqual(['--append-system-prompt', 'BE NICE']);
    expect(args.slice(args.indexOf('--disallowedTools'), args.indexOf('--disallowedTools') + 4)).toEqual(['--disallowedTools', 'Read(D/**)', 'Edit(D/**)', 'Write(D/**)']);
  });
});

describe('ClaudeSession (against a fake claude)', () => {
  let logFile: string;
  beforeAll(() => {
    chmodSync(FAKE, 0o755);
    logFile = join(mkdtempSync(join(tmpdir(), 'vv-')), 'argv.log');
    process.env.FAKE_CLAUDE_LOG = logFile;
  });

  it('keeps one process across turns, and resumes after an interrupt', async () => {
    const session = new ClaudeSession({ bin: FAKE, cwd: tmpdir(), permissions: 'edit', extraArgs: [], systemPrompt: 'SYS' });
    const events: EngineEvent[] = [];

    const r1 = await session.turn('hello', (e) => events.push(e));
    expect(r1).toEqual({ interrupted: false, error: undefined });
    expect(events).toContainEqual({ type: 'text', text: 'You said: hello' });
    expect(events).toContainEqual({ type: 'status', text: 'Reading Daily/2026-11-10.md' });
    expect(events.some((e) => e.type === 'text' && e.text.includes('SUBAGENT'))).toBe(false);

    await session.turn('again', () => undefined);
    expect(readFileSync(logFile, 'utf8').trim().split('\n')).toHaveLength(1); // same process

    const slow = session.turn('SLOW task', () => undefined);
    setTimeout(() => session.interrupt(), 50);
    expect(await slow).toEqual({ interrupted: true });

    const after: EngineEvent[] = [];
    await session.turn('back', (e) => after.push(e));
    expect(after).toContainEqual({ type: 'text', text: 'You said: back' });
    const runs = readFileSync(logFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as string[]);
    expect(runs).toHaveLength(2);
    expect(runs[1]!.slice(runs[1]!.indexOf('--resume'), runs[1]!.indexOf('--resume') + 2)).toEqual(['--resume', 'session-1']);
    session.close();
  });

  it('reports a missing binary as a turn error', async () => {
    const session = new ClaudeSession({ bin: '/nonexistent/claude', cwd: tmpdir(), permissions: 'edit', extraArgs: [], systemPrompt: 'SYS' });
    const r = await session.turn('hi', () => undefined);
    expect(r.interrupted).toBe(false);
    expect(r.error).toMatch(/stopped unexpectedly/);
  });
});
