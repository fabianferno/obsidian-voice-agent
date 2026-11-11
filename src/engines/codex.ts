import type { EngineOptions } from './types.js';
import { PerTurnSession, messageText, type LineParsed, type LineState } from './per-turn.js';
import { asObject, asString, toText, type JsonObject } from '../utils/json.js';

export function codexArgs(opts: EngineOptions, prompt: string, threadId?: string): string[] {
  const args = threadId ? ['exec', 'resume', '--json'] : ['exec', '--json'];
  args.push('--skip-git-repo-check');
  // The system prompt goes in as developer instructions (stronger than text in a
  // user message). Only on the first turn: the thread keeps them on resume, and
  // passing them again would add another copy to the context every turn.
  // The value is parsed as TOML; a JSON string is a valid TOML basic string.
  if (opts.systemPrompt && !threadId) args.push('-c', `developer_instructions=${JSON.stringify(opts.systemPrompt)}`);
  args.push(
    ...(opts.permissions === 'full'
      ? ['--dangerously-bypass-approvals-and-sandbox']
      : ['-c', 'sandbox_mode="workspace-write"']),
  );
  if (opts.model) args.push('-m', opts.model);
  args.push(...opts.extraArgs, '--');
  if (threadId) args.push(threadId);
  args.push(prompt);
  return args;
}

/** Codex reports commands as `/bin/zsh -lc "rg ..."`; show just the command. */
export function unwrapShell(command: string): string {
  const m = /^\S*\b(?:ba|z)?sh\s+-l?c\s+(["'])([\s\S]*)\1$/.exec(command.trim());
  return m ? m[2] : command;
}

/** One line of `codex exec --json`. */
export function parseCodexLine(obj: JsonObject, state: LineState): LineParsed {
  const out: LineParsed = { events: [] };
  const item = asObject(obj.item);
  switch (obj.type) {
    case 'thread.started':
      if (typeof obj.thread_id === 'string') out.conversationId = obj.thread_id;
      break;
    case 'item.started':
      if (item.type === 'command_execution') {
        out.events.push({ type: 'status', text: `Running ${unwrapShell(toText(item.command, 'a command')).slice(0, 80)}` });
      } else if (item.type === 'file_change') {
        out.events.push({ type: 'status', text: 'Editing notes' });
      } else if (item.type === 'web_search') {
        out.events.push({ type: 'status', text: 'Searching the web' });
      } else if (item.type === 'mcp_tool_call') {
        out.events.push({ type: 'status', text: `Using ${asString(item.tool) ?? asString(item.server) ?? 'a tool'}` });
      }
      break;
    case 'item.completed':
      if (item.type === 'agent_message' && typeof item.text === 'string') {
        out.events.push(...messageText(item.text, state));
      } else if (item.type === 'error' && item.message) {
        out.error = toText(item.message);
      }
      break;
    case 'turn.failed':
      out.error = toText(asObject(obj.error).message, 'Codex turn failed');
      break;
    case 'error':
      out.error = toText(obj.message, 'Codex error');
      break;
  }
  return out;
}

export class CodexSession extends PerTurnSession {
  readonly label = 'Codex';
  protected systemInFirstMessage = false;
  constructor(opts: EngineOptions) {
    super(opts);
  }
  protected args(prompt: string, conversationId: string | undefined): string[] {
    return codexArgs(this.opts, prompt, conversationId);
  }
  protected parse(obj: JsonObject, state: LineState): LineParsed {
    return parseCodexLine(obj, state);
  }
}
