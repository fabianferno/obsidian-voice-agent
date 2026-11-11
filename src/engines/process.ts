import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { asString, parseJson, toText, type JsonObject } from '../utils/json.js';

/** Calls onJson for every stdout line that parses as a JSON object. */
export function readJsonLines(child: ChildProcess, onJson: (obj: JsonObject) => void): void {
  if (!child.stdout) return;
  const rl = createInterface({ input: child.stdout });
  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) return;
    // Lines that are not JSON objects (stray log output) are ignored.
    const parsed = parseJson(trimmed);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) onJson(parsed as JsonObject);
  });
}

/** Keeps the last few KB of stderr for error messages. */
export function captureStderr(child: ChildProcess): () => string {
  let buf = '';
  child.stderr?.on('data', (d: Buffer) => {
    buf = (buf + d.toString()).slice(-4000);
  });
  return () => buf.trim();
}

export interface TurnProcess {
  child: ChildProcess;
  /** Resolves when the process exits. */
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null; stderr: string }>;
}

/** Spawns a process for one agent turn, with stdin closed. */
export function spawnTurn(
  bin: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv | undefined,
  onJson: (obj: JsonObject) => void,
): TurnProcess {
  const child = spawn(bin, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], env: env ?? process.env });
  const stderr = captureStderr(child);
  readJsonLines(child, onJson);
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null; stderr: string }>(
    (resolve) => {
      child.on('error', (err) => resolve({ code: -1, signal: null, stderr: `${err.message}\n${stderr()}` }));
      child.on('close', (code, signal) => resolve({ code, signal, stderr: stderr() }));
    },
  );
  return { child, exited };
}

export function kill(child: ChildProcess | undefined): void {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  window.setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }, 3000);
}

/** Short, speakable-free description of a tool call, for the status line. */
export function describeTool(name: string, input: Record<string, unknown> = {}): string {
  const path = asString(input.file_path) ?? asString(input.path) ?? asString(input.notebook_path);
  const short = path ? path.split('/').slice(-2).join('/') : undefined;
  switch (name) {
    case 'Read':
      return short ? `Reading ${short}` : 'Reading';
    case 'Write':
      return short ? `Writing ${short}` : 'Writing';
    case 'Edit':
    case 'MultiEdit':
      return short ? `Editing ${short}` : 'Editing';
    case 'Glob':
    case 'Grep':
      return `Searching the vault${input.pattern ? ` for ${toText(input.pattern)}` : ''}`;
    case 'Bash':
      return `Running ${toText(input.description ?? input.command, 'a command').slice(0, 80)}`;
    case 'WebSearch':
      return `Searching the web${input.query ? ` for ${toText(input.query)}` : ''}`;
    case 'WebFetch':
      return 'Reading a web page';
    case 'Task':
    case 'Agent':
      return 'Working on a sub-task';
    default:
      return `Using ${name}`;
  }
}
