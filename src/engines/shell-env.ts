// engines/shell-env.ts - a PATH that can find claude, codex and agy.
//
// Obsidian opened from the Dock or Finder does not inherit the PATH your
// terminal has (Homebrew, npm globals, ~/.local/bin), so spawning "claude"
// would fail with ENOENT. Ask the login shell once for its PATH and merge it.

import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

let cached: Promise<NodeJS.ProcessEnv> | undefined;

/** Common install folders, added even if the shell lookup fails. */
export function fallbackDirs(home = os.homedir()): string[] {
  return [
    path.join(home, '.local', 'bin'),
    path.join(home, '.claude', 'local'),
    path.join(home, '.npm-global', 'bin'),
    path.join(home, '.bun', 'bin'),
    path.join(home, '.volta', 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
  ];
}

export function mergePath(...parts: Array<string | undefined>): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of parts) {
    for (const dir of (part ?? '').split(path.delimiter)) {
      if (dir && !seen.has(dir)) {
        seen.add(dir);
        out.push(dir);
      }
    }
  }
  return out.join(path.delimiter);
}

function loginShellPath(): Promise<string> {
  if (process.platform === 'win32') return Promise.resolve('');
  const shell = process.env.SHELL || '/bin/zsh';
  const marker = '__VA_PATH__';
  return new Promise((resolve) => {
    execFile(shell, ['-ilc', `printf '${marker}%s${marker}' "$PATH"`], { timeout: 5000 }, (err, stdout) => {
      if (err) return resolve('');
      const m = new RegExp(`${marker}(.*)${marker}`).exec(String(stdout));
      resolve(m ? m[1] : '');
    });
  });
}

/** process.env with the login shell's PATH and common install folders merged in. */
export function shellEnv(): Promise<NodeJS.ProcessEnv> {
  cached ??= loginShellPath().then((shellPath) => ({
    ...process.env,
    PATH: mergePath(shellPath, process.env.PATH, fallbackDirs().join(path.delimiter)),
  }));
  return cached;
}
