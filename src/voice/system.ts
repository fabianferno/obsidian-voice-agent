// voice/system.ts - the operating system's own text-to-speech.
//
// Uses the Web Speech API (speechSynthesis), which Obsidian's Chromium wires
// to the native engine: AVSpeechSynthesizer on macOS, Windows' speech voices
// (SAPI / OneCore) on Windows, and speech-dispatcher on Linux. Nothing to
// download, no key, nothing leaves the computer. The OS plays the audio
// itself, so synthesize() only describes what to say; the Player speaks it.

import type { SpeechAudio, TextToSpeech } from './types.js';

export type SystemSpeech = Extract<SpeechAudio, { kind: 'system' }>;

/** Speaks one piece of text and resolves when it is done (or cancelled). */
export interface SystemSpeaker {
  speak(item: SystemSpeech): Promise<void>;
  cancel(): void;
}

export interface VoiceInfo {
  name: string;
  lang: string;
  isDefault: boolean;
}

/** macOS joke and sound-effect voices: never picked, not listed. */
const NOVELTY = new Set([
  'albert', 'bad news', 'bahh', 'bells', 'boing', 'bubbles', 'cellos', 'deranged', 'good news', 'hysterical',
  'jester', 'organ', 'pipe organ', 'superstar', 'trinoids', 'whisper', 'wobble', 'zarvox',
]);

export function isNovelty(name: string): boolean {
  return NOVELTY.has(name.replace(/\s*\(.*$/, '').trim().toLowerCase());
}

/** 2 for a Premium voice, 1 for Enhanced, 0 for the basic (compact) ones. */
export function voiceQuality(name: string): number {
  if (/\(premium\)/i.test(name)) return 2;
  if (/\(enhanced\)/i.test(name)) return 1;
  return 0;
}

/**
 * The best installed voice for a locale: Premium, then Enhanced, then the
 * rest; within each, the exact region, then the system's default voice.
 * Undefined when nothing speaks the language (the OS then picks).
 */
export function pickBestVoice(voices: VoiceInfo[], locale: string): VoiceInfo | undefined {
  const want = locale.replace('_', '-').toLowerCase();
  const base = want.split('-')[0];
  const candidates = voices.filter(v => !isNovelty(v.name) && v.lang.replace('_', '-').toLowerCase().split('-')[0] === base);
  const score = (v: VoiceInfo) =>
    voiceQuality(v.name) * 100 + (v.lang.replace('_', '-').toLowerCase() === want ? 10 : 0) + (v.isDefault ? 1 : 0);
  let best: VoiceInfo | undefined;
  for (const v of candidates) if (!best || score(v) > score(best)) best = v;
  return best;
}

function userLocale(): string {
  return (typeof navigator !== 'undefined' && navigator.language) || 'en-US';
}

function synth(): SpeechSynthesis {
  const s = typeof window === 'undefined' ? undefined : window.speechSynthesis;
  if (!s) throw new Error('This system has no built-in speech (speechSynthesis is missing).');
  return s;
}

/** The installed voices. They load asynchronously, so wait briefly for them. */
export async function systemVoices(timeoutMs = 1500): Promise<VoiceInfo[]> {
  const s = synth();
  let voices = s.getVoices();
  if (!voices.length) {
    voices = await new Promise<SpeechSynthesisVoice[]>((resolve) => {
      const done = () => {
        window.clearTimeout(timer);
        s.removeEventListener('voiceschanged', done);
        resolve(s.getVoices());
      };
      const timer = window.setTimeout(done, timeoutMs);
      s.addEventListener('voiceschanged', done);
    });
  }
  return voices
    .filter(v => v.localService && !isNovelty(v.name))
    .map(v => ({ name: v.name, lang: v.lang, isDefault: v.default }));
}

/** The voice "Automatic" resolves to right now, for showing in settings. */
export async function automaticVoice(): Promise<VoiceInfo | undefined> {
  return pickBestVoice(await systemVoices(), userLocale());
}

/** Rough upper bound on how long a sentence takes to say, in case the end event never comes. */
export function speechTimeoutMs(text: string, rate: number): number {
  return 5000 + (text.length * 200) / Math.max(rate, 0.1);
}

export function browserSpeaker(): SystemSpeaker {
  let current: SpeechSynthesisUtterance | undefined;
  return {
    speak(item) {
      const s = synth();
      return new Promise<void>((resolve, reject) => {
        const u = new SpeechSynthesisUtterance(item.text);
        const all = s.getVoices();
        let voice = item.voice ? all.find(v => v.name === item.voice || v.voiceURI === item.voice) : undefined;
        if (!voice) {
          // Automatic (or the chosen voice was removed): the best one installed.
          const best = pickBestVoice(all.filter(v => v.localService).map(v => ({ name: v.name, lang: v.lang, isDefault: v.default })), userLocale());
          voice = best && all.find(v => v.name === best.name);
        }
        if (voice) {
          u.voice = voice;
          u.lang = voice.lang;
        }
        u.rate = item.rate;
        let settled = false;
        const finish = (err?: Error) => {
          if (settled) return;
          settled = true;
          window.clearTimeout(timer);
          if (current === u) current = undefined;
          if (err) reject(err);
          else resolve();
        };
        // Chromium can drop the end event; never let one sentence stall the queue.
        const timer = window.setTimeout(() => finish(), speechTimeoutMs(item.text, item.rate));
        u.onend = () => finish();
        u.onerror = (e) => {
          if (e.error === 'interrupted' || e.error === 'canceled') finish();
          else finish(new Error(`System voice failed: ${e.error}`));
        };
        // Keep a reference: Chromium stops firing events for collected utterances.
        current = u;
        s.speak(u);
      });
    },
    cancel() {
      current = undefined;
      try {
        synth().cancel();
      } catch {
        // No speech support: nothing to cancel.
      }
    },
  };
}

/** The OS voice as a TextToSpeech provider. An empty voice name means Automatic (best installed). */
export class SystemTts implements TextToSpeech {
  readonly label: string;
  constructor(private readonly voice: string, private readonly rate: number) {
    this.label = voice ? `System voice (${voice})` : 'System voice (automatic)';
  }

  async warmup(): Promise<void> {
    const voices = await systemVoices();
    if (!voices.length) {
      throw new Error('No system voices found. On Linux, install speech-dispatcher with a voice (for example espeak-ng) and restart Obsidian, or pick a cloud voice.');
    }
  }

  synthesize(text: string): Promise<SpeechAudio> {
    return Promise.resolve({ kind: 'system', text, voice: this.voice || undefined, rate: this.rate });
  }
}
