// voice/vad.ts - finds where speech starts and ends in the mic signal.
//
// Energy based, no model: tracks the room's noise floor and calls it speech
// when a frame is clearly louder. Good enough for a laptop mic with the
// browser's noise suppression on, and it has no download and no latency.

export interface VadOptions {
  /** Frame length the caller pushes, in ms. */
  frameMs: number;
  /** Speech must be this much louder than the noise floor (ratio). */
  ratio: number;
  /** Absolute floor for "loud enough", in RMS. */
  minRms: number;
  /** Frames of loudness needed to start an utterance. */
  startFrames: number;
  /** Silence that ends an utterance, in ms. */
  endSilenceMs: number;
  /** Audio kept from before the start, in ms, so first syllables survive. */
  preRollMs: number;
  /** Utterances shorter than this are dropped as noise, in ms. */
  minSpeechMs: number;
  /** An utterance is cut here even without silence, in ms. */
  maxSpeechMs: number;
}

export const DEFAULT_VAD: VadOptions = {
  frameMs: 30,
  ratio: 3,
  minRms: 0.01,
  startFrames: 3,
  endSilenceMs: 900,
  preRollMs: 300,
  minSpeechMs: 350,
  maxSpeechMs: 30000,
};

export type VadEvent = { type: 'start' } | { type: 'end'; audio: Float32Array } | { type: 'discard' };

export function rms(frame: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i];
  return Math.sqrt(sum / Math.max(1, frame.length));
}

export class EnergyVad {
  private noise = 0.005;
  private loudRun = 0;
  private silentMs = 0;
  private speaking = false;
  private pre: Float32Array[] = [];
  private speech: Float32Array[] = [];
  private speechMs = 0;
  private voicedFrames = 0;
  private readonly o: VadOptions;

  constructor(opts: Partial<VadOptions> = {}) {
    this.o = { ...DEFAULT_VAD, ...opts };
  }

  get isSpeaking(): boolean {
    return this.speaking;
  }

  reset(): void {
    this.loudRun = 0;
    this.silentMs = 0;
    this.speaking = false;
    this.pre = [];
    this.speech = [];
    this.speechMs = 0;
    this.voicedFrames = 0;
  }

  push(frame: Float32Array): VadEvent | null {
    const level = rms(frame);
    const loud = level > Math.max(this.o.minRms, this.noise * this.o.ratio);
    // Follow the noise floor: quickly on quiet frames, slowly on loud ones, so a
    // fan or hum that starts mid-utterance becomes "noise" within seconds
    // instead of holding the utterance open.
    const rate = loud ? 0.005 : 0.05;
    this.noise = this.noise * (1 - rate) + level * rate;

    if (!this.speaking) {
      this.pre.push(frame);
      const keep = Math.ceil(this.o.preRollMs / this.o.frameMs) + this.o.startFrames;
      if (this.pre.length > keep) this.pre.shift();
      this.loudRun = loud ? this.loudRun + 1 : 0;
      if (this.loudRun >= this.o.startFrames) {
        this.speaking = true;
        this.speech = [...this.pre];
        this.speechMs = this.speech.length * this.o.frameMs;
        this.voicedFrames = this.loudRun;
        this.pre = [];
        this.silentMs = 0;
        return { type: 'start' };
      }
      return null;
    }

    this.speech.push(frame);
    this.speechMs += this.o.frameMs;
    if (loud) this.voicedFrames++;
    this.silentMs = loud ? 0 : this.silentMs + this.o.frameMs;
    if (this.silentMs >= this.o.endSilenceMs || this.speechMs >= this.o.maxSpeechMs) {
      const voicedMs = this.voicedFrames * this.o.frameMs;
      const audio = concat(this.speech);
      this.reset();
      return voicedMs >= this.o.minSpeechMs ? { type: 'end', audio } : { type: 'discard' };
    }
    return null;
  }
}

export function concat(parts: Float32Array[]): Float32Array {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}
