// voice/player.ts - plays reply audio in order, and stops instantly on interrupt.

import type { SpeechAudio } from './types.js';
import { browserSpeaker, type SystemSpeaker, type SystemSpeech } from './system.js';

type Ready = { kind: 'buffer'; buffer: AudioBuffer } | SystemSpeech;

export class Player {
  private ctx?: AudioContext;
  private speaker?: SystemSpeaker;
  private chain: Promise<void> = Promise.resolve();
  private stopCurrent?: () => void;
  private generation = 0;
  private pending = 0;
  onStateChange?: (playing: boolean) => void;

  constructor(private readonly makeSpeaker: () => SystemSpeaker = browserSpeaker) {}

  get playing(): boolean {
    return this.pending > 0;
  }

  private context(): AudioContext {
    this.ctx ??= new AudioContext();
    if (this.ctx.state === 'suspended') void this.ctx.resume();
    return this.ctx;
  }

  private systemSpeaker(): SystemSpeaker {
    this.speaker ??= this.makeSpeaker();
    return this.speaker;
  }

  private async prepare(audio: SpeechAudio): Promise<Ready> {
    if (audio.kind === 'system') return audio;
    const ctx = this.context();
    if (audio.kind === 'encoded') return { kind: 'buffer', buffer: await ctx.decodeAudioData(audio.data.slice(0)) };
    const buf = ctx.createBuffer(1, audio.samples.length, audio.sampleRate);
    buf.copyToChannel(audio.samples as Float32Array<ArrayBuffer>, 0);
    return { kind: 'buffer', buffer: buf };
  }

  private play(item: Ready): Promise<void> {
    if (item.kind === 'system') {
      const speaker = this.systemSpeaker();
      this.stopCurrent = () => speaker.cancel();
      return speaker.speak(item);
    }
    return new Promise<void>((resolve) => {
      const src = this.context().createBufferSource();
      src.buffer = item.buffer;
      src.connect(this.context().destination);
      src.onended = () => resolve();
      this.stopCurrent = () => src.stop();
      src.start();
    });
  }

  /** Queues audio after whatever is already playing. Resolves when it has played (or was stopped). */
  enqueue(audio: Promise<SpeechAudio> | SpeechAudio): Promise<void> {
    const gen = this.generation;
    this.pending++;
    if (this.pending === 1) this.onStateChange?.(true);
    // Decode now (in parallel with what is playing); play in order.
    const ready = Promise.resolve(audio).then(a => this.prepare(a));
    ready.catch(() => undefined);
    const run = this.chain.then(async () => {
      if (gen !== this.generation) return;
      const item = await ready;
      if (gen !== this.generation) return;
      try {
        await this.play(item);
      } finally {
        this.stopCurrent = undefined;
      }
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
      this.stopCurrent?.();
    } catch {
      // already stopped
    }
    this.stopCurrent = undefined;
  }

  dispose(): void {
    this.stop();
    void this.ctx?.close().catch(() => undefined);
    this.ctx = undefined;
  }
}
