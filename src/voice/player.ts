// voice/player.ts - plays reply audio in order, and stops instantly on interrupt.

import type { SpeechAudio } from './types.js';

export class Player {
  private ctx?: AudioContext;
  private chain: Promise<void> = Promise.resolve();
  private current?: AudioBufferSourceNode;
  private generation = 0;
  private pending = 0;
  onStateChange?: (playing: boolean) => void;

  get playing(): boolean {
    return this.pending > 0;
  }

  private context(): AudioContext {
    this.ctx ??= new AudioContext();
    if (this.ctx.state === 'suspended') void this.ctx.resume();
    return this.ctx;
  }

  private async toBuffer(audio: SpeechAudio): Promise<AudioBuffer> {
    const ctx = this.context();
    if (audio.kind === 'encoded') return ctx.decodeAudioData(audio.data.slice(0));
    const buf = ctx.createBuffer(1, audio.samples.length, audio.sampleRate);
    buf.copyToChannel(audio.samples as Float32Array<ArrayBuffer>, 0);
    return buf;
  }

  /** Queues audio after whatever is already playing. Resolves when it has played (or was stopped). */
  enqueue(audio: Promise<SpeechAudio> | SpeechAudio): Promise<void> {
    const gen = this.generation;
    this.pending++;
    if (this.pending === 1) this.onStateChange?.(true);
    // Decode now (in parallel with what is playing); play in order.
    const decoded = Promise.resolve(audio).then(a => this.toBuffer(a));
    decoded.catch(() => undefined);
    const run = this.chain.then(async () => {
      if (gen !== this.generation) return;
      const buffer = await decoded;
      if (gen !== this.generation) return;
      await new Promise<void>((resolve) => {
        const src = this.context().createBufferSource();
        src.buffer = buffer;
        src.connect(this.context().destination);
        src.onended = () => resolve();
        this.current = src;
        src.start();
      });
      this.current = undefined;
    });
    this.chain = run.catch(() => undefined).finally(() => {
      this.pending = Math.max(0, this.pending - 1);
      if (this.pending === 0) this.onStateChange?.(false);
    });
    return run;
  }

  /** Stops playback and drops everything queued. */
  stop(): void {
    this.generation++;
    try {
      this.current?.stop();
    } catch {
      // already stopped
    }
    this.current = undefined;
  }

  dispose(): void {
    this.stop();
    void this.ctx?.close().catch(() => undefined);
    this.ctx = undefined;
  }
}
