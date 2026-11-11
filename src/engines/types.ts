export type EngineEvent =
  /** Words the agent is saying. Streamed; spoken aloud and shown in the transcript. */
  | { type: 'text'; text: string }
  /** What the agent is doing (reading a note, running a command). Shown, not spoken. */
  | { type: 'status'; text: string };

export interface TurnResult {
  /** True when the turn was cut short by interrupt(). */
  interrupted: boolean;
  /** Set when the agent reported a failure for this turn. */
  error?: string;
}

/**
 * One ongoing conversation with a coding-agent CLI (an "engine"), rooted in the vault.
 * Turns run one at a time; call interrupt() to stop the current one.
 */
export interface EngineSession {
  readonly label: string;
  turn(prompt: string, onEvent: (e: EngineEvent) => void): Promise<TurnResult>;
  interrupt(): void;
  /** Forget the conversation so the next turn starts fresh. */
  reset(): void;
  close(): void;
}

export interface EngineOptions {
  bin: string;
  cwd: string;
  model?: string;
  permissions: 'edit' | 'full';
  extraArgs: string[];
  /** Who the agent is and how it works. Claude Code takes it as an appended system
   * prompt; Codex and Antigravity get it at the top of the first message. */
  systemPrompt: string;
  /** Environment for the CLI, with a PATH that can find it (see shell-env.ts). */
  env?: NodeJS.ProcessEnv;
  /** Vault-relative folders the engine must not read or write (daily notes). */
  denyPaths?: string[];
  /** Vault-relative paths the engine must not edit directly (board, agent folder). */
  protectPaths?: string[];
}
