import { describe, it, expect } from 'vitest';
import { Player } from '../src/voice/player.js';
import { SystemTts, isNovelty, pickBestVoice, speechTimeoutMs, voiceQuality, type SystemSpeaker, type SystemSpeech, type VoiceInfo } from '../src/voice/system.js';
import { removeOldKokoroModels } from '../src/voice/local/cleanup.js';
import { ElevenLabsTts } from '../src/voice/cloud.js';
import { mergeSettings, DEFAULT_SETTINGS } from '../src/plugin/settings-data.js';
import type { Http, HttpRequest } from '../src/voice/http.js';

/** A fake OS voice: each sentence finishes when the test says so. */
function fakeSpeaker() {
  const spoken: SystemSpeech[] = [];
  const finishers: Array<() => void> = [];
  let cancels = 0;
  const speaker: SystemSpeaker = {
    speak(item) {
      spoken.push(item);
      return new Promise<void>((resolve) => finishers.push(resolve));
    },
    cancel() {
      cancels++;
      for (const f of finishers.splice(0)) f();
    },
  };
  return { speaker, spoken, finish: () => finishers.shift()?.(), cancels: () => cancels };
}

const tick = () => new Promise(r => setTimeout(r, 0));

describe('SystemTts', () => {
  it('describes the text for the OS voice instead of making audio', async () => {
    const audio = await new SystemTts('Samantha', 1.2).synthesize('Hello there.');
    expect(audio).toEqual({ kind: 'system', text: 'Hello there.', voice: 'Samantha', rate: 1.2 });
    expect(new SystemTts('', 1).label).toBe('System voice (automatic)');
    expect(await new SystemTts('', 1).synthesize('Hi')).toEqual({ kind: 'system', text: 'Hi', voice: undefined, rate: 1 });
  });

  it('gives slow speech more time before the stall guard fires', () => {
    expect(speechTimeoutMs('a'.repeat(100), 0.5)).toBeGreaterThan(speechTimeoutMs('a'.repeat(100), 1.5));
    expect(speechTimeoutMs('', 1)).toBeGreaterThanOrEqual(5000);
  });
});

describe('Player with the system voice', () => {
  it('speaks sentences one after another, in order', async () => {
    const f = fakeSpeaker();
    const states: boolean[] = [];
    const player = new Player(() => f.speaker);
    player.onStateChange = (p) => states.push(p);
    const a = player.enqueue({ kind: 'system', text: 'One.', rate: 1 });
    const b = player.enqueue({ kind: 'system', text: 'Two.', rate: 1 });
    await tick();
    expect(f.spoken.map(s => s.text)).toEqual(['One.']);
    expect(player.playing).toBe(true);
    f.finish();
    await a;
    await tick();
    expect(f.spoken.map(s => s.text)).toEqual(['One.', 'Two.']);
    f.finish();
    await b;
    await tick();
    expect(player.playing).toBe(false);
    expect(states).toEqual([true, false]);
  });

  it('stop cancels the OS voice and drops what is queued', async () => {
    const f = fakeSpeaker();
    const player = new Player(() => f.speaker);
    const a = player.enqueue({ kind: 'system', text: 'One.', rate: 1 });
    const b = player.enqueue({ kind: 'system', text: 'Two.', rate: 1 });
    await tick();
    player.stop();
    await Promise.all([a, b]);
    expect(f.cancels()).toBe(1);
    expect(f.spoken.map(s => s.text)).toEqual(['One.']);
    await tick();
    expect(player.playing).toBe(false);
  });

  it('reports a failing OS voice to the caller', async () => {
    const speaker: SystemSpeaker = { speak: () => Promise.reject(new Error('System voice failed: synthesis-failed')), cancel: () => undefined };
    const player = new Player(() => speaker);
    await expect(player.enqueue({ kind: 'system', text: 'Hi', rate: 1 })).rejects.toThrow(/synthesis-failed/);
    await tick();
    expect(player.playing).toBe(false);
  });
});

describe('ElevenLabsTts', () => {
  const fakeHttp = (status: number, text = '', bytes: number[] = []) => {
    const calls: HttpRequest[] = [];
    const http: Http = async (req) => {
      calls.push(req);
      return { status, text, arrayBuffer: new Uint8Array(bytes).buffer };
    };
    return { http, calls };
  };

  it('posts the text with the key and returns MP3 audio', async () => {
    const { http, calls } = fakeHttp(200, '', [0xff, 0xfb, 1, 2]);
    const audio = await new ElevenLabsTts(http, 'EK', { voice: 'abc123', model: 'eleven_flash_v2_5' }).synthesize('Hi there');
    expect(calls[0].url).toBe('https://api.elevenlabs.io/v1/text-to-speech/abc123?output_format=mp3_44100_128');
    expect(calls[0].headers).toMatchObject({ 'xi-api-key': 'EK' });
    expect(JSON.parse(calls[0].body as string)).toEqual({ text: 'Hi there', model_id: 'eleven_flash_v2_5' });
    expect(audio.kind === 'encoded' && audio.data.byteLength).toBe(4);
  });

  it('errors carry the status and message', async () => {
    const { http } = fakeHttp(401, '{"detail":"invalid_api_key"}');
    await expect(new ElevenLabsTts(http, 'bad', { voice: 'v', model: 'm' }).synthesize('Hi')).rejects.toThrow(/401.*invalid_api_key/);
  });
});

describe('settings migration', () => {
  it('moves 0.1.x local (Kokoro) speech to the system voice and drops Kokoro fields', () => {
    const s = mergeSettings({ tts: 'local', localVoice: 'af_heart', localSpeed: 1.1 } as never);
    expect(s.tts).toBe('system');
    expect('localVoice' in s).toBe(false);
    expect('localSpeed' in s).toBe(false);
    expect(s.speechRate).toBe(1);
  });

  it('keeps a valid choice and defaults new installs to the system voice', () => {
    expect(mergeSettings({ tts: 'elevenlabs' }).tts).toBe('elevenlabs');
    expect(mergeSettings({ tts: 'off' }).tts).toBe('off');
    expect(mergeSettings(null).tts).toBe('system');
    expect(DEFAULT_SETTINGS.stt).toBe('local');
  });
});

describe('choosing the system voice', () => {
  const v = (name: string, lang: string, isDefault = false): VoiceInfo => ({ name, lang, isDefault });
  // What Chromium lists on a stock Mac (compact voices only), plus extras per test.
  const stock = [v('Samantha', 'en-US', true), v('Albert', 'en-US'), v('Bells', 'en-US'), v('Daniel', 'en-GB'), v('Rishi', 'en-IN'), v('Alice', 'it-IT')];

  it('spots novelty voices and voice quality from the name', () => {
    expect(isNovelty('Bad News')).toBe(true);
    expect(isNovelty('Grandma (English (United States))')).toBe(false);
    expect(isNovelty('Samantha')).toBe(false);
    expect(voiceQuality('Ava (Premium)')).toBe(2);
    expect(voiceQuality('Samantha (Enhanced)')).toBe(1);
    expect(voiceQuality('Samantha')).toBe(0);
  });

  it('falls back to the default voice in the language, never a novelty one', () => {
    expect(pickBestVoice(stock, 'en-US')?.name).toBe('Samantha');
    expect(pickBestVoice([v('Albert', 'en-US'), v('Bells', 'en-US')], 'en-US')).toBeUndefined();
  });

  it('prefers the exact region among equal voices', () => {
    expect(pickBestVoice(stock, 'en-GB')?.name).toBe('Daniel');
    expect(pickBestVoice(stock, 'en-IN')?.name).toBe('Rishi');
    expect(pickBestVoice(stock, 'en_IN')?.name).toBe('Rishi');
  });

  it('prefers Premium, then Enhanced, over the region and the default', () => {
    expect(pickBestVoice([...stock, v('Samantha (Enhanced)', 'en-US')], 'en-IN')?.name).toBe('Samantha (Enhanced)');
    expect(pickBestVoice([...stock, v('Samantha (Enhanced)', 'en-US'), v('Zoe (Premium)', 'en-US')], 'en-US')?.name).toBe('Zoe (Premium)');
  });

  it('returns nothing when no voice speaks the language', () => {
    expect(pickBestVoice(stock, 'ja-JP')).toBeUndefined();
  });
});

describe('removeOldKokoroModels', () => {
  function fakeStorage(urls: string[] | null) {
    const entries = urls ? [...urls] : null;
    const cache = {
      keys: async () => (entries ?? []).map(url => ({ url }) as Request),
      delete: async (req: Request) => {
        const i = entries!.indexOf(req.url);
        if (i < 0) return false;
        entries!.splice(i, 1);
        return true;
      },
    };
    const storage = { has: async () => entries !== null, open: async () => cache } as unknown as CacheStorage;
    return { storage, entries };
  }

  it('deletes Kokoro files and keeps Whisper', async () => {
    const { storage, entries } = fakeStorage([
      'https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/onnx/model_quantized.onnx',
      'https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/voices/af_heart.bin',
      'https://huggingface.co/Xenova/whisper-base.en/resolve/main/onnx/encoder_model_quantized.onnx',
    ]);
    expect(await removeOldKokoroModels(storage)).toBe(2);
    expect(entries).toEqual(['https://huggingface.co/Xenova/whisper-base.en/resolve/main/onnx/encoder_model_quantized.onnx']);
    expect(await removeOldKokoroModels(storage)).toBe(0);
  });

  it('does nothing without a cache or cache support', async () => {
    expect(await removeOldKokoroModels(fakeStorage(null).storage)).toBe(0);
    expect(await removeOldKokoroModels(undefined)).toBe(0);
  });
});
