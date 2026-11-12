// voice/local/worker.ts - local speech models, run in a Web Worker.
//
// Whisper (speech to text) via transformers.js on the ONNX runtime's WASM
// backend. (Speech out uses the operating system's voice, see voice/system.ts.) Built as its own browser bundle and started
// from a blob URL, so it never blocks Obsidian's UI thread. The ONNX runtime
// files come in through the init message (see runtime.ts); models download
// from Hugging Face on first use and are cached by the browser.

// Must stay the first import: it hides Obsidian's Node globals before the
// libraries below check for them.
import { nodeGlobalsLeft } from './hide-node.js';
import { env, pipeline } from '@huggingface/transformers';

type Asr = (audio: Float32Array, opts?: Record<string, unknown>) => Promise<{ text: string } | Array<{ text: string }>>;

export type WorkerRequest =
  | { id: number; type: 'init'; wasm: { mjs: string; wasm: string } }
  | { id: number; type: 'load'; model: string }
  | { id: number; type: 'transcribe'; model: string; audio: Float32Array };

export type WorkerResponse =
  | { id: number; ok: true; text?: string }
  | { id: number; ok: false; error: string }
  | { id: -1; progress: { file?: string; loaded?: number; total?: number; status?: string; name?: string } };

const ctx = self as unknown as {
  postMessage(msg: WorkerResponse): void;
  onmessage: ((e: MessageEvent<WorkerRequest>) => void) | null;
};

let asr: { model: string; p: Promise<Asr> } | undefined;

interface ProgressInfo { file?: string; loaded?: number; total?: number; status?: string; name?: string }
const progress = (p: ProgressInfo | undefined) =>
  ctx.postMessage({ id: -1, progress: { file: p?.file, loaded: p?.loaded, total: p?.total, status: p?.status, name: p?.name } });

const CORRUPT = /protobuf parsing failed|unexpected end|invalid (onnx )?model|failed to load model|corrupt/i;

/** A dropped download can leave a truncated file in the cache; clear it and retry once. */
async function withRepair<T>(load: () => Promise<T>): Promise<T> {
  try {
    return await load();
  } catch (err) {
    if (!CORRUPT.test(String((err as Error)?.message ?? err))) throw err;
    await caches.delete('transformers-cache').catch(() => undefined);
    return load();
  }
}

function loadAsr(model: string): Promise<Asr> {
  if (asr?.model !== model) {
    const p = withRepair(() => pipeline('automatic-speech-recognition', model, { dtype: 'q8', device: 'wasm', progress_callback: progress })) as unknown as Promise<Asr>;
    asr = { model, p };
    p.catch(() => { if (asr?.p === p) asr = undefined; });
  }
  return asr.p;
}

async function handle(msg: WorkerRequest): Promise<void> {
  try {
    switch (msg.type) {
      case 'init':
        env.allowLocalModels = false;
        env.useBrowserCache = true;
        {
          const onnx = env.backends.onnx as { wasm?: { wasmPaths?: unknown; numThreads?: number } } | undefined;
          if (!onnx?.wasm) {
            const left = nodeGlobalsLeft.length ? ` (Node globals still present: ${nodeGlobalsLeft.join(', ')})` : '';
            throw new Error(`The ONNX runtime did not load in the voice worker${left}.`);
          }
          onnx.wasm.wasmPaths = msg.wasm;
          onnx.wasm.numThreads = 1;
        }
        ctx.postMessage({ id: msg.id, ok: true });
        break;
      case 'load':
        await loadAsr(msg.model);
        ctx.postMessage({ id: msg.id, ok: true });
        break;
      case 'transcribe': {
        const run = await loadAsr(msg.model);
        const out = await run(msg.audio);
        const text = Array.isArray(out) ? out.map(o => o.text).join(' ') : out.text;
        ctx.postMessage({ id: msg.id, ok: true, text });
        break;
      }
    }
  } catch (err) {
    ctx.postMessage({ id: msg.id, ok: false, error: err instanceof Error ? err.message : String(err) });
  }
}

ctx.onmessage = (e) => void handle(e.data);
