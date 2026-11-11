// brain/actions.ts - the agent actions an engine can ask for, and how they travel.
//
// Every engine (Claude Code, Codex, Antigravity) is a CLI that streams text, and
// each one configures tools differently. So instead of per-engine tool plumbing,
// the engine ends its reply with one block:
//
//   <actions>[{"type":"move_task","task":"Write intro","from":"To Do","to":"Doing"}]</actions>
//
// The plugin strips the block from what is shown and spoken, validates each
// action, and runs it through the tested writers. Ordinary note reading and
// editing the engine does itself with its own tools.

import type { VaultAction } from '../config/types.js';
import type { JsonObject } from '../utils/json.js';

export const OPEN_TAG = '<actions>';
export const CLOSE_TAG = '</actions>';

/**
 * Required fields per action type. Without this a misnamed field reaches the
 * writers as `undefined` and gets written to disk as the literal "undefined".
 */
export const ACTION_SCHEMA: Record<string, string[]> = {
  move_task: ['task', 'from', 'to'],
  complete_task: ['task', 'from'],
  add_task: ['text', 'column'],
  reschedule_task: ['task', 'newDate'],
  people_note: ['name', 'note'],
  literature_note: ['title', 'noteType', 'source', 'note'],
  update_memory: ['observation'],
  propose_config_edit: ['file', 'section', 'operation', 'content', 'rationale'],
  apply_config_edit: [],
  discard_config_edit: [],
};

export function isValidAction(value: unknown): value is VaultAction {
  if (!value || typeof value !== 'object') return false;
  const a = value as JsonObject;
  if (typeof a.type !== 'string') return false;
  const required = ACTION_SCHEMA[a.type];
  if (!required) return false;
  const hasRequired = required.every(f => a[f] !== undefined && a[f] !== null && a[f] !== '');
  if (!hasRequired) return false;
  if (a.type === 'propose_config_edit') {
    if (a.operation === 'replace_line' && !a.match) return false;
    if (a.operation === 'set_field' && !a.field) return false;
  }
  if (a.type === 'reschedule_task' && !(typeof a.newDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(a.newDate))) return false;
  return true;
}

export interface ParsedReply {
  message: string;
  vaultActions: VaultAction[];
  /** Actions that were present but malformed or unknown. Logged, never run. */
  rejected: unknown[];
}

function stripReasoning(text: string): string {
  return text
    .replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, '')
    .replace(/<think(?:ing)?>[\s\S]*$/i, '');
}

/** Splits a finished reply into the words to show and the actions to run. */
export function parseAgentReply(raw: string): ParsedReply {
  const actions: unknown[] = [];
  let message = stripReasoning(raw);

  const blockRe = /<actions>([\s\S]*?)(?:<\/actions>|$)/gi;
  message = message.replace(blockRe, (_m, body: string) => {
    const json = body.trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/, '').trim();
    if (!json) return '';
    try {
      const parsed = JSON.parse(json) as unknown;
      actions.push(...(Array.isArray(parsed) ? (parsed as unknown[]) : [parsed]));
    } catch {
      actions.push({ unparseable: json.slice(0, 200) });
    }
    return '';
  });

  const vaultActions: VaultAction[] = [];
  const rejected: unknown[] = [];
  for (const a of actions) (isValidAction(a) ? vaultActions.push(a) : rejected.push(a));
  return { message: message.trim(), vaultActions, rejected };
}

/**
 * Streaming counterpart of parseAgentReply for what is shown and spoken: passes
 * text through until an <actions> block starts, and holds back a partial tag
 * split across chunks so "<act" never reaches the speaker.
 */
export class ActionStreamFilter {
  private pending = '';
  private inBlock = false;

  push(chunk: string): string {
    if (this.inBlock) {
      const end = chunk.indexOf(CLOSE_TAG);
      if (end === -1) return '';
      this.inBlock = false;
      return this.push(chunk.slice(end + CLOSE_TAG.length));
    }
    const text = this.pending + chunk;
    this.pending = '';
    const start = text.indexOf(OPEN_TAG);
    if (start !== -1) {
      this.inBlock = true;
      return text.slice(0, start) + this.push(text.slice(start + OPEN_TAG.length));
    }
    // Hold back a suffix that could be the start of the tag.
    for (let n = Math.min(OPEN_TAG.length - 1, text.length); n > 0; n--) {
      if (OPEN_TAG.startsWith(text.slice(-n))) {
        this.pending = text.slice(-n);
        return text.slice(0, -n);
      }
    }
    return text;
  }

  /** Whatever was held back, once the stream is over. */
  flush(): string {
    const rest = this.inBlock ? '' : this.pending;
    this.pending = '';
    this.inBlock = false;
    return rest;
  }
}

/**
 * A short summary of what the actions did, used when the engine returned only
 * an actions block and no words. Reschedule and config-edit actions report
 * their own confirmations, so they are left out here.
 */
export function describeActions(actions: VaultAction[] | undefined): string {
  if (!actions || actions.length === 0) return '';
  return actions
    .map(action => {
      switch (action.type) {
        case 'move_task':
          return `Moved "${action.task}" to ${action.to}.`;
        case 'complete_task':
          return `Marked "${action.task}" done.`;
        case 'add_task':
          return `Added "${action.text}" to ${action.column}.`;
        case 'people_note':
          return `Noted that in ${action.name}'s note.`;
        case 'literature_note':
          return `Saved a literature note on "${action.title}".`;
        case 'update_memory':
          return 'Noted.';
        default:
          return '';
      }
    })
    .filter(Boolean)
    .join('\n');
}
