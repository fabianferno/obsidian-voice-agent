import { spawn, type ChildProcess } from 'node:child_process';
import type { EngineEvent, EngineOptions, EngineSession, TurnResult } from './types.js';
import { captureStderr, describeTool, kill, readJsonLines } from './process.js';
import { asArray, asObject, asString, type JsonObject } from '../utils/json.js';

const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

export interface ClaudeParseState {
  hadText: boolean;
}

export interface ClaudeParsed {
  events: EngineEvent[];
  sessionId?: string;
  /** Present when this line ends the turn. */
  result?: { error?: string };
}

/**
 * Turns one line of `claude -p --output-format stream-json --include-partial-messages`
 * into agent events. Only top-level messages count: subagent output
 * (parent_tool_use_id set) is not spoken.
 */
export function parseClaudeLine(obj: JsonObject, state: ClaudeParseState): ClaudeParsed {
  const out: ClaudeParsed = { events: [] };
  const topLevel = obj.parent_tool_use_id == null;
  const sessionId = asString(obj.session_id);

  if (obj.type === 'system' && obj.subtype === 'init' && sessionId) {
    out.sessionId = sessionId;
  } else if (obj.type === 'stream_event' && topLevel) {
    const ev = asObject(obj.event);
    const delta = asObject(ev.delta);
    const text = asString(delta.text);
    if (ev.type === 'message_start' && state.hadText) {
      // A new assistant message after a tool call: keep its words apart from the last ones.
      out.events.push({ type: 'text', text: '\n' });
    } else if (ev.type === 'content_block_delta' && delta.type === 'text_delta' && text) {
      state.hadText = true;
      out.events.push({ type: 'text', text });
    }
  } else if (obj.type === 'assistant' && topLevel) {
    for (const item of asArray(asObject(obj.message).content)) {
      const block = asObject(item);
      if (block.type === 'tool_use') {
        const name = asString(block.name) ?? 'a tool';
        const input = asObject(block.input);
        out.events.push({ type: 'status', text: describeTool(name, input) });
        const file = asString(input.file_path) ?? asString(input.notebook_path);
        if (file && WRITE_TOOLS.has(name)) out.events.push({ type: 'file', path: file });
      }
    }
  } else if (obj.type === 'result') {
    if (sessionId) out.sessionId = sessionId;
    out.result = obj.is_error
      ? { error: asString(obj.result) || asString(obj.subtype) || 'error' }
      : {};
  }
  return out;
}

/**
 * Permission rules that keep Claude Code out of the daily notes and away from
 * editing the board and agent files directly (those go through agent actions).
 * Paths are relative to the vault, which is Claude's working directory.
 */
export function claudeDeniedTools(opts: Pick<EngineOptions, 'denyPaths' | 'protectPaths'>): string[] {
  const glob = (p: string) => {
    const clean = p.replace(/^\/+|\/+$/g, '');
    return /\.[a-z0-9]+$/i.test(clean) ? clean : `${clean}/**`;
  };
  const rules: string[] = [];
  for (const p of opts.denyPaths ?? []) {
    if (!p) continue;
    rules.push(`Read(${glob(p)})`, `Edit(${glob(p)})`, `Write(${glob(p)})`);
  }
  for (const p of opts.protectPaths ?? []) {
    if (!p) continue;
    rules.push(`Edit(${glob(p)})`, `Write(${glob(p)})`);
  }
  return rules;
}

export function claudeArgs(opts: EngineOptions, resumeId?: string): string[] {
  const args = [
    '-p',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--append-system-prompt', opts.systemPrompt,
  ];
  const denied = claudeDeniedTools(opts);
  if (opts.readOnly) denied.push('Edit', 'Write', 'NotebookEdit');
  if (denied.length) args.push('--disallowedTools', ...denied);
  // Read-only: the default mode cannot ask for approval in print mode, so anything
  // beyond reading and searching (shell commands included) is refused.
  if (opts.readOnly) args.push('--permission-mode', 'default');
  else args.push(...(opts.permissions === 'full' ? ['--dangerously-skip-permissions'] : ['--permission-mode', 'acceptEdits']));
  if (opts.model) args.push('--model', opts.model);
  if (resumeId) args.push('--resume', resumeId);
  args.push(...opts.extraArgs);
  return args;
}

interface PendingTurn {
  onEvent: (e: EngineEvent) => void;
  resolve: (r: TurnResult) => void;
  state: ClaudeParseState;
}

/**
 * Claude Code kept running between turns (stream-json on stdin), so follow-up
 * turns skip process start-up. Interrupting kills the process; the next turn
 * starts a new one with --resume, so the conversation carries on.
 */
export class ClaudeSession implements EngineSession {
  readonly label = 'Claude Code';
  private child?: ChildProcess;
  private stderr: () => string = () => '';
  private sessionId?: string;
  private pending?: PendingTurn;
  private interrupting = false;

  constructor(private readonly opts: EngineOptions) {}

  private start(): ChildProcess {
    const child = spawn(this.opts.bin, claudeArgs(this.opts, this.sessionId), {
      cwd: this.opts.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: this.opts.env ?? process.env,
    });
    this.child = child;
    this.stderr = captureStderr(child);
    child.stdin?.on('error', () => {
      // EPIPE when the process died; the close handler reports it.
    });
    readJsonLines(child, (obj) => this.onJson(obj));
    const onGone = (detail: string) => {
      if (this.child !== child) return;
      this.child = undefined;
      const pending = this.pending;
      this.pending = undefined;
      if (!pending) return;
      if (this.interrupting) {
        pending.resolve({ interrupted: true });
      } else {
        pending.resolve({ interrupted: false, error: `Claude Code stopped unexpectedly (${detail}). ${this.stderr()}`.trim() });
      }
      this.interrupting = false;
    };
    child.on('error', (err) => onGone(err.message));
    child.on('close', (code, signal) => onGone(signal ? `signal ${signal}` : `exit code ${code}`));
    return child;
  }

  private onJson(obj: JsonObject): void {
    const pending = this.pending;
    const parsed = parseClaudeLine(obj, pending?.state ?? { hadText: false });
    if (parsed.sessionId) this.sessionId = parsed.sessionId;
    if (!pending) return;
    for (const e of parsed.events) pending.onEvent(e);
    if (parsed.result) {
      this.pending = undefined;
      pending.resolve({ interrupted: false, error: parsed.result.error });
    }
  }

  turn(prompt: string, onEvent: (e: EngineEvent) => void): Promise<TurnResult> {
    if (this.pending) return Promise.reject(new Error('A turn is already running'));
    const child = this.child ?? this.start();
    this.interrupting = false;
    return new Promise<TurnResult>((resolve) => {
      this.pending = { onEvent, resolve, state: { hadText: false } };
      const message = { type: 'user', message: { role: 'user', content: prompt } };
      child.stdin?.write(JSON.stringify(message) + '\n');
    });
  }

  interrupt(): void {
    if (!this.pending || !this.child) return;
    this.interrupting = true;
    kill(this.child);
  }

  reset(): void {
    if (this.pending) {
      this.interrupt();
    } else {
      // Idle process: drop it now so the next turn never writes to a dying one.
      kill(this.child);
      this.child = undefined;
    }
    this.sessionId = undefined;
  }

  close(): void {
    this.interrupt();
    kill(this.child);
  }
}
