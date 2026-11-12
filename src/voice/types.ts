// voice/types.ts

/**
 * Audio to play: raw samples, an encoded file (WAV, MP3) the browser decodes,
 * or text for the operating system's own voice to speak.
 */
export type SpeechAudio =
  | { kind: 'pcm'; samples: Float32Array; sampleRate: number }
  | { kind: 'encoded'; data: ArrayBuffer }
  | { kind: 'system'; text: string; voice?: string; rate: number };

export interface SpeechToText {
  readonly label: string;
  /** Mono 16 kHz samples in [-1, 1] -> words. Empty string for noise. */
  transcribe(samples: Float32Array): Promise<string>;
  warmup?(): Promise<void>;
  dispose?(): void;
}

export interface TextToSpeech {
  readonly label: string;
  synthesize(text: string): Promise<SpeechAudio>;
  warmup?(): Promise<void>;
  dispose?(): void;
}
