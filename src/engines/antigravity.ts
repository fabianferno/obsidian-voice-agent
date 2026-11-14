import type { EngineOptions } from './types.js';
import { PerTurnSession, messageText, type LineParsed, type LineState } from './per-turn.js';
import { asArray, asObject, asString, toText, type JsonObject } from '../utils/json.js';

/**
 * Headless agy auto-denies every shell command it would otherwise ask about,
 * including the find/grep it uses to locate notes. In edit mode, allow the
 * read-only ones so it can search the vault.
 */
export const READ_ONLY_COMMANDS = ['find', 'ls', 'grep', 'rg', 'cat', 'head', 'tail', 'wc'];

export function antigravityArgs(opts: EngineOptions, prompt: string, conversationId?: string): string[] {
  const readOnlySettings = ['--settings', JSON.stringify({ permissions: { allow: READ_ONLY_COMMANDS.map((c) => `command(${c})`) } })];
  // Read-only: without accept-edits, headless agy refuses every edit it would ask about.
  const args = opts.readOnly
    ? readOnlySettings
    : opts.permissions === 'full'
      ? ['--dangerously-skip-permissions']
      : ['--mode', 'accept-edits', ...readOnlySettings];
  args.push('--output-format', 'stream-json');
  if (opts.model) args.push('--model', opts.model);
  if (conversationId) args.push('--conversation', conversationId);
  args.push(...opts.extraArgs);
  // The prompt goes last: flags after a positional argument may not be parsed.
  args.push('-p', prompt);
  return args;
}

function humanize(name: string): string {
  return name.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
}

function describeStep(step: JsonObject): string {
  const tool = asString(step.tool_name) ?? asString(step.step_type) ?? 'step';
  const params = asObject(asObject(step.tool_info).parameters);
  const path = asString(params.Path)?.split('/').slice(-2).join('/');
  if (tool === 'read_file' || tool === 'view_file') return path ? `Reading ${path}` : 'Reading';
  if (/write|replace|edit/.test(tool)) return path ? `Editing ${path}` : 'Editing';
  if (tool === 'run_command') return `Running ${toText(params.CommandLine, 'a command').slice(0, 80)}`;
  if (/search|grep|find/.test(tool)) return 'Searching the vault';
  return humanize(tool);
}

/** One line of `agy -p --output-format stream-json`. */
export function parseAntigravityLine(obj: JsonObject, state: LineState): LineParsed {
  const out: LineParsed = { events: [] };
  if (obj.event === 'init' && typeof obj.conversation_id === 'string') {
    out.conversationId = obj.conversation_id;
  } else if (obj.event === 'step_update') {
    const step = asObject(obj.step_update);
    const key = toText(step.step_index);
    if (step.step_type === 'agent_response') {
      const delta = asString(step.text_delta) ?? '';
      if (delta) {
        // First delta of a new response step after earlier text: separate it.
        const firstOfStep = !state.seenSteps.has(key);
        state.seenSteps.add(key);
        if (firstOfStep) out.events.push(...messageText(delta, state));
        else out.events.push({ type: 'text', text: delta });
      }
    } else if (step.step_type && step.step_type !== 'user_input' && step.state === 'ACTIVE' && !state.seenSteps.has(key)) {
      state.seenSteps.add(key);
      out.events.push({ type: 'status', text: describeStep(step) });
      const tool = asString(step.tool_name) ?? '';
      const file = asString(asObject(asObject(step.tool_info).parameters).Path);
      if (file && /write|replace|edit/.test(tool)) out.events.push({ type: 'file', path: file });
    }
  } else if (obj.event === 'result') {
    const result = asObject(obj.result);
    if (typeof result.conversation_id === 'string') out.conversationId = result.conversation_id;
    const denied = asArray(result.denied_actions).map(asObject);
    const status = asString(result.status);
    if (status && status !== 'SUCCESS') {
      out.error = toText(result.error ?? result.response, `Antigravity finished with ${status}`);
    } else if (denied.length && !toText(result.response).trim()) {
      const names = denied.map((d) => asString(d.display_name) ?? asString(d.action) ?? 'a tool').join(', ');
      out.error = `Antigravity was not allowed to use ${names}. Allow it in agy's settings.json, or run with --permissions full.`;
    }
  }
  return out;
}

export class AntigravitySession extends PerTurnSession {
  readonly label = 'Antigravity';
  constructor(opts: EngineOptions) {
    super(opts);
  }
  protected args(prompt: string, conversationId: string | undefined): string[] {
    return antigravityArgs(this.opts, prompt, conversationId);
  }
  protected parse(obj: JsonObject, state: LineState): LineParsed {
    return parseAntigravityLine(obj, state);
  }
}
