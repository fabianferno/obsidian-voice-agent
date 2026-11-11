// engines/index.ts - pick and start an engine.

import { execFile } from 'node:child_process';
import type { EngineOptions, EngineSession } from './types.js';
import { ClaudeSession } from './claude.js';
import { CodexSession } from './codex.js';
import { AntigravitySession } from './antigravity.js';

export type { EngineSession, EngineEvent, EngineOptions, TurnResult } from './types.js';

export const ENGINES = ['claude', 'codex', 'antigravity'] as const;
export type EngineName = (typeof ENGINES)[number];

export const ENGINE_INFO: Record<EngineName, { label: string; bin: string; install: string }> = {
  claude: { label: 'Claude Code', bin: 'claude', install: 'https://docs.claude.com/en/docs/claude-code' },
  codex: { label: 'Codex', bin: 'codex', install: 'https://github.com/openai/codex' },
  antigravity: { label: 'Antigravity', bin: 'agy', install: 'https://antigravity.google' },
};

export function createEngine(name: EngineName, opts: EngineOptions): EngineSession {
  switch (name) {
    case 'claude':
      return new ClaudeSession(opts);
    case 'codex':
      return new CodexSession(opts);
    case 'antigravity':
      return new AntigravitySession(opts);
  }
}

/** Runs `<bin> --version`. Resolves to the version line, rejects with an install hint. */
export function checkEngine(name: EngineName, bin: string, env?: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(bin, ['--version'], { env: env ?? process.env, timeout: 15000 }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(
          `Could not run "${bin} --version". Install ${ENGINE_INFO[name].label} (${ENGINE_INFO[name].install}), ` +
          'sign in once in a terminal, or set the full path to the binary in settings.',
        ));
        return;
      }
      resolve((String(stdout) || String(stderr)).trim().split('\n')[0] ?? '');
    });
  });
}
