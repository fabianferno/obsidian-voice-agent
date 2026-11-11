// voice/local/worker.ts - local speech models, run in a Web Worker.
//
// Whisper (speech to text) and Kokoro (text to speech) via transformers.js on
// the ONNX runtime's WASM backend. Built as its own browser bundle and started
// from a blob URL, so it never blocks Obsidian's UI thread. The ONNX runtime
// files come in through the init message (see runtime.ts); models download
// from Hugging Face on first use and are cached by the browser.

import { env, pipeline } from '@huggingface/transformers';
import { KokoroTTS } from 'kokoro-js';

type Asr = (audio: Float32Array, opts?: Record<string, unknown>) => Promise<{ text: string } | Array<{ text: string }>>;

export type WorkerRequest =
  | { id: number; type: 'init'; wasm: { mjs: string; wasm: string } }
  | { id: number; type: 'load'; what: 'stt' | 'tts'; model: string }
  | { id: number; type: 'transcribe'; model: string; audio: Float32Array }
  | { id: number; type: 'synthesize'; model: string; text: string; voice: string; speed: number };

export type WorkerResponse =
  | { id: number; ok: true; text?: string; audio?: Float32Array; sampleRate?: number }
  | { id: number; ok: false; error: string }
  | { id: -1; progress: { file?: string; loaded?: number; total?: number; status?: string; name?: string } };

const ctx = self as unknown as {
  postMessage(msg: WorkerResponse, transfer?: Transferable[]): void;
  onmessage: ((e: MessageEvent<WorkerRequest>) => void) | null;
};

let asr: { model: string; p: Promise<Asr> } | undefined;
let tts: { model: string; p: Promise<KokoroTTS> } | undefined;
type KokoroVoice = NonNullable<Parameters<KokoroTTS['generate']>[1]>['voice'];
let ttsQueue: Promise<unknown> = Promise.resolve();

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

function loadTts(model: string): Promise<KokoroTTS> {
  if (tts?.model !== model) {
    const p = withRepair(() => KokoroTTS.from_pretrained(model, { dtype: 'q8', device: 'wasm', progress_callback: progress }));
    tts = { model, p };
    p.catch(() => { if (tts?.p === p) tts = undefined; });
  }
  return tts.p;
}

async function handle(msg: WorkerRequest): Promise<void> {
  try {
    switch (msg.type) {
      case 'init':
        env.allowLocalModels = false;
        env.useBrowserCache = true;
        {
          const onnx = env.backends.onnx as { wasm: { wasmPaths?: unknown; numThreads?: number } };
          onnx.wasm.wasmPaths = msg.wasm;
          onnx.wasm.numThreads = 1;
        }
        ctx.postMessage({ id: msg.id, ok: true });
        break;
      case 'load':
        await (msg.what === 'stt' ? loadAsr(msg.model) : loadTts(msg.model));
        ctx.postMessage({ id: msg.id, ok: true });
        break;
      case 'transcribe': {
        const run = await loadAsr(msg.model);
        const out = await run(msg.audio);
        const text = Array.isArray(out) ? out.map(o => o.text).join(' ') : out.text;
        ctx.postMessage({ id: msg.id, ok: true, text });
        break;
      }
      case 'synthesize': {
        // Kokoro is not re-entrant: one generation at a time.
        const job = ttsQueue.then(async () => {
          const model = await loadTts(msg.model);
          return model.generate(msg.text, { voice: msg.voice as KokoroVoice, speed: msg.speed });
        });
        ttsQueue = job.catch(() => undefined);
        const audio = await job;
        const samples = audio.audio;
        ctx.postMessage({ id: msg.id, ok: true, audio: samples, sampleRate: audio.sampling_rate }, [samples.buffer]);
        break;
      }
    }
  } catch (err) {
    ctx.postMessage({ id: msg.id, ok: false, error: err instanceof Error ? err.message : String(err) });
  }
}

ctx.onmessage = (e) => void handle(e.data);
