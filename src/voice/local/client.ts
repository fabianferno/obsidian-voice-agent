// voice/local/client.ts - talks to the local speech recognition worker.

import type { SpeechToText } from '../types.js';
import type { WorkerRequest, WorkerResponse } from './worker.js';
import { cleanWhisper } from '../../speech/whisper-text.js';

type Pending = { resolve: (r: Extract<WorkerResponse, { ok: true }>) => void; reject: (e: Error) => void };
type Distribute<T> = T extends unknown ? Omit<T, 'id'> : never;

export interface LocalVoiceOptions {
  workerSource: string;
  /** Resolves the runtime files (loader JS and WASM bytes) as blob URLs. */
  runtime: () => Promise<{ mjs: string; wasm: string }>;
  onProgress?: (msg: string) => void;
}

/** The Web Worker that runs Whisper. */
export class LocalVoiceWorker {
  private worker?: Worker;
  private ready?: Promise<void>;
  private seq = 0;
  private pending = new Map<number, Pending>();
  private lastProgress = 0;

  constructor(private readonly opts: LocalVoiceOptions) {}

  private start(): Promise<void> {
    this.ready ??= (async () => {
      const wasm = await this.opts.runtime();
      const url = URL.createObjectURL(new Blob([this.opts.workerSource], { type: 'text/javascript' }));
      this.worker = new Worker(url, { type: 'module' });
      this.worker.onmessage = (e: MessageEvent<WorkerResponse>) => this.onMessage(e.data);
      this.worker.onerror = (e) => {
        const err = new Error(`Local voice worker crashed: ${e.message}`);
        for (const p of this.pending.values()) p.reject(err);
        this.pending.clear();
        this.dispose();
      };
      await this.send({ type: 'init', wasm });
    })();
    this.ready.catch(() => { this.ready = undefined; });
    return this.ready;
  }

  private onMessage(m: WorkerResponse): void {
    if ('progress' in m) {
      const p = m.progress;
      if (p.status === 'progress' && p.total && Date.now() - this.lastProgress > 1000) {
        this.lastProgress = Date.now();
        this.opts.onProgress?.(`Downloading ${p.file ?? 'model'}: ${Math.round(((p.loaded ?? 0) / p.total) * 100)}%`);
      }
      return;
    }
    const p = this.pending.get(m.id);
    if (!p) return;
    this.pending.delete(m.id);
    if (m.ok) p.resolve(m);
    else p.reject(new Error((m as { error: string }).error));
  }

  private send(msg: Distribute<WorkerRequest>, transfer: Transferable[] = []): Promise<Extract<WorkerResponse, { ok: true }>> {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker!.postMessage({ ...msg, id }, transfer);
    });
  }

  async call(msg: Distribute<Exclude<WorkerRequest, { type: 'init' }>>, transfer: Transferable[] = []) {
    await this.start();
    return this.send(msg, transfer);
  }

  dispose(): void {
    this.worker?.terminate();
    this.worker = undefined;
    this.ready = undefined;
  }
}

export class LocalWhisper implements SpeechToText {
  readonly label: string;
  constructor(private w: LocalVoiceWorker, private model: string) {
    this.label = `Whisper (local, ${model.split('/').pop()})`;
  }
  async warmup(): Promise<void> {
    await this.w.call({ type: 'load', model: this.model });
  }
  async transcribe(samples: Float32Array): Promise<string> {
    const copy = samples.slice();
    const r = await this.w.call({ type: 'transcribe', model: this.model, audio: copy }, [copy.buffer]);
    return cleanWhisper(r.text ?? '');
  }
}
