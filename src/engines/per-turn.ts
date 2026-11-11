import type { EngineEvent, EngineOptions, EngineSession, TurnResult } from './types.js';
import { kill, spawnTurn, type TurnProcess } from './process.js';
import type { JsonObject } from '../utils/json.js';

export interface LineState {
  hadText: boolean;
  seenSteps: Set<string>;
}

export interface LineParsed {
  events: EngineEvent[];
  conversationId?: string;
  error?: string;
}

export function newLineState(): LineState {
  return { hadText: false, seenSteps: new Set() };
}

/**
 * Backends whose CLI runs one process per turn and resumes the conversation by
 * id (Codex, Antigravity). Antigravity has no system prompt flag, so the
 * instructions go at the top of the first message; Codex takes them as
 * developer instructions on every turn.
 */
export abstract class PerTurnSession implements EngineSession {
  abstract readonly label: string;
  protected conversationId?: string;
  private current?: TurnProcess;
  private interrupting = false;

  constructor(protected readonly opts: EngineOptions) {}

  /** False when the CLI takes the system prompt another way (see CodexSession). */
  protected systemInFirstMessage = true;

  protected abstract args(prompt: string, conversationId: string | undefined): string[];
  protected abstract parse(obj: JsonObject, state: LineState): LineParsed;

  async turn(prompt: string, onEvent: (e: EngineEvent) => void): Promise<TurnResult> {
    if (this.current) throw new Error('A turn is already running');
    const fullPrompt = this.conversationId || !this.systemInFirstMessage ? prompt : `${this.opts.systemPrompt}\n\n---\n\n${prompt}`;
    const state = newLineState();
    let error: string | undefined;
    this.interrupting = false;

    this.current = spawnTurn(this.opts.bin, this.args(fullPrompt, this.conversationId), this.opts.cwd, this.opts.env, (obj) => {
      const parsed = this.parse(obj, state);
      if (parsed.conversationId) this.conversationId = parsed.conversationId;
      if (parsed.error) error = parsed.error;
      for (const e of parsed.events) onEvent(e);
    });
    const { code, signal, stderr } = await this.current.exited;
    this.current = undefined;

    if (this.interrupting) {
      this.interrupting = false;
      return { interrupted: true };
    }
    if (!error && code !== 0) {
      error = `${this.label} exited with ${signal ? `signal ${signal}` : `code ${code}`}. ${stderr}`.trim();
    }
    return { interrupted: false, error };
  }

  interrupt(): void {
    if (!this.current) return;
    this.interrupting = true;
    kill(this.current.child);
  }

  reset(): void {
    this.interrupt();
    this.conversationId = undefined;
  }

  close(): void {
    this.interrupt();
  }
}

/** Joins separate agent messages so their sentences don't run together. */
export function messageText(text: string, state: LineState): EngineEvent[] {
  if (!text) return [];
  const prefix = state.hadText ? '\n' : '';
  state.hadText = true;
  return [{ type: 'text', text: prefix + text }];
}
