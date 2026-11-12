// voice/local/runtime.ts - the ONNX runtime's WASM binary for local Whisper.
//
// The JavaScript (transformers.js and the runtime's loader) is bundled
// into the plugin. The 21 MB WASM binary is too big to bundle, so it is
// downloaded once from jsDelivr, pinned to the exact build the loader was
// bundled with, checked against a SHA-256 baked in at build time, and kept in
// a cache folder outside the vault.

import { createHash } from 'crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';

export const WASM_FILE = 'ort-wasm-simd-threaded.jsep.wasm';

export function cacheRoot(): string {
  return path.join(os.homedir(), '.obsidian-voice-agent');
}

export function sha256(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

export interface RuntimeSource {
  /** e.g. https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1/dist/ */
  baseUrl: string;
  expectedSha256: string;
}

/**
 * Returns the WASM bytes, downloading them on first use. A file whose hash does
 * not match (a dropped download, a different version) is replaced.
 */
export async function ensureWasm(
  source: RuntimeSource,
  download: (url: string) => Promise<ArrayBuffer>,
  dir = path.join(cacheRoot(), 'runtime'),
  onStatus?: (msg: string) => void,
): Promise<Uint8Array> {
  const file = path.join(dir, `${source.expectedSha256.slice(0, 12)}-${WASM_FILE}`);
  if (existsSync(file)) {
    const bytes = new Uint8Array(readFileSync(file));
    if (sha256(bytes) === source.expectedSha256) return bytes;
  }
  onStatus?.('Downloading the local voice runtime (21 MB, once)...');
  const bytes = new Uint8Array(await download(source.baseUrl + WASM_FILE));
  const got = sha256(bytes);
  if (got !== source.expectedSha256) {
    throw new Error(`Local voice runtime download did not match (sha256 ${got.slice(0, 12)}...). Try again later.`);
  }
  mkdirSync(dir, { recursive: true });
  writeFileSync(`${file}.part`, bytes);
  renameSync(`${file}.part`, file);
  return bytes;
}
