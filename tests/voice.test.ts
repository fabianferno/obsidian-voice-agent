import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { EnergyVad, rms } from '../src/voice/vad.js';
import { multipart, base64ToArrayBuffer, type Http, type HttpRequest } from '../src/voice/http.js';
import { SarvamStt, SarvamTts, SonioxTts } from '../src/voice/cloud.js';
import { ensureWasm, sha256, WASM_FILE } from '../src/voice/local/runtime.js';
import { VoiceSession, type AgentLike, type PlayerLike, type VoiceState, type VoiceUi } from '../src/voice/session.js';
import type { SpeechAudio, SpeechToText, TextToSpeech } from '../src/voice/types.js';

const frame = (amp: number, n = 480) => new Float32Array(n).fill(amp);

describe('EnergyVad', () => {
  it('finds an utterance between silences and keeps some pre-roll', () => {
    const vad = new EnergyVad({ endSilenceMs: 300, minSpeechMs: 200 });
    const events: string[] = [];
    let audio: Float32Array | undefined;
    for (let i = 0; i < 20; i++) vad.push(frame(0.001));
    for (let i = 0; i < 20; i++) {
      const e = vad.push(frame(0.2));
      if (e) events.push(e.type);
    }
    for (let i = 0; i < 20; i++) {
      const e = vad.push(frame(0.001));
      if (e) {
        events.push(e.type);
        if (e.type === 'end') audio = e.audio;
      }
    }
    expect(events).toEqual(['start', 'end']);
    // 20 loud frames + some pre-roll + the trailing silence.
    expect(audio!.length).toBeGreaterThan(20 * 480);
  });

  it('discards a click too short to be speech', () => {
    const vad = new EnergyVad({ endSilenceMs: 300, minSpeechMs: 300 });
    const events: string[] = [];
    for (let i = 0; i < 20; i++) vad.push(frame(0.001));
    for (let i = 0; i < 4; i++) { const e = vad.push(frame(0.3)); if (e) events.push(e.type); }
    for (let i = 0; i < 20; i++) { const e = vad.push(frame(0.001)); if (e) events.push(e.type); }
    expect(events).toEqual(['start', 'discard']);
  });

  it('adapts to a steady noise floor', () => {
    const vad = new EnergyVad();
    let started = false;
    for (let i = 0; i < 200; i++) if (vad.push(frame(0.02))?.type === 'start') started = true;
    // A constant hum louder than minRms may trigger once at first, but it must not stay "speaking".
    expect(vad.isSpeaking).toBe(false);
    expect(typeof started).toBe('boolean');
    expect(rms(frame(0.5))).toBeCloseTo(0.5);
  });
});

describe('multipart', () => {
  it('builds a form body with fields and a file', () => {
    const { body, contentType } = multipart({ model: 'm', skip: undefined }, { field: 'file', name: 'a.wav', type: 'audio/wav', data: new Uint8Array([1, 2]) }, 'XX');
    expect(contentType).toBe('multipart/form-data; boundary=XX');
    const text = new TextDecoder().decode(body);
    expect(text).toContain('name="model"\r\n\r\nm\r\n');
    expect(text).not.toContain('skip');
    expect(text).toContain('filename="a.wav"');
    expect(text.endsWith('\r\n--XX--\r\n')).toBe(true);
  });

  it('decodes base64 audio', () => {
    expect(new Uint8Array(base64ToArrayBuffer(Buffer.from([7, 8, 9]).toString('base64')))).toEqual(new Uint8Array([7, 8, 9]));
  });
});

describe('cloud providers', () => {
  const fakeHttp = (respond: (r: HttpRequest) => { status: number; text?: string; bytes?: number[] }) => {
    const calls: HttpRequest[] = [];
    const http: Http = async (req) => {
      calls.push(req);
      const r = respond(req);
      return { status: r.status, text: r.text ?? '', arrayBuffer: new Uint8Array(r.bytes ?? []).buffer };
    };
    return { http, calls };
  };

  it('Sarvam STT posts a WAV with the key and returns the transcript', async () => {
    const { http, calls } = fakeHttp(() => ({ status: 200, text: JSON.stringify({ transcript: ' hello ' }) }));
    const out = await new SarvamStt(http, 'KEY', { language: 'unknown' }).transcribe(new Float32Array(1600));
    expect(out).toBe('hello');
    expect(calls[0].headers).toEqual({ 'api-subscription-key': 'KEY' });
    expect(calls[0].contentType).toMatch(/^multipart\/form-data/);
    expect(new TextDecoder().decode(calls[0].body as ArrayBuffer)).toContain('RIFF');
  });

  it('Sarvam TTS returns encoded audio, and errors carry the status', async () => {
    const ok = fakeHttp(() => ({ status: 200, text: JSON.stringify({ audios: [Buffer.from('RIFFxx').toString('base64')] }) }));
    const audio = await new SarvamTts(ok.http, 'K', { model: 'bulbul:v3', language: 'en-IN' }).synthesize('Hi');
    expect(audio.kind).toBe('encoded');
    expect(JSON.parse(ok.calls[0].body as string)).toMatchObject({ text: 'Hi', model: 'bulbul:v3', target_language_code: 'en-IN' });
    const bad = fakeHttp(() => ({ status: 403, text: 'invalid key' }));
    await expect(new SarvamTts(bad.http, 'K', { model: 'bulbul:v3', language: 'en-IN' }).synthesize('Hi')).rejects.toThrow(/403.*invalid key/);
  });

  it('Soniox TTS sends a bearer key', async () => {
    const { http, calls } = fakeHttp(() => ({ status: 200, bytes: [1, 2, 3] }));
    const audio = await new SonioxTts(http, 'SK', { model: 'tts-rt-v2', voice: 'Adrian', language: 'en' }).synthesize('Hi');
    expect(calls[0].headers).toEqual({ Authorization: 'Bearer SK' });
    expect(audio.kind === 'encoded' && audio.data.byteLength).toBe(3);
  });
});

describe('ensureWasm', () => {
  it('downloads once, verifies the hash, and reuses the cached file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rt-'));
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const download = vi.fn(async () => bytes.buffer.slice(0));
    const src = { baseUrl: 'https://cdn/x/', expectedSha256: sha256(bytes) };
    expect(await ensureWasm(src, download, dir)).toEqual(bytes);
    expect(download).toHaveBeenCalledWith(`https://cdn/x/${WASM_FILE}`);
    expect(await ensureWasm(src, download, dir)).toEqual(bytes);
    expect(download).toHaveBeenCalledTimes(1);
  });

  it('rejects a download with the wrong hash and replaces a corrupt cache', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rt-'));
    const good = new Uint8Array([9, 9]);
    const src = { baseUrl: 'u/', expectedSha256: sha256(good) };
    await expect(ensureWasm(src, async () => new Uint8Array([0]).buffer, dir)).rejects.toThrow(/did not match/);
    writeFileSync(join(dir, `${src.expectedSha256.slice(0, 12)}-${WASM_FILE}`), 'junk');
    expect(await ensureWasm(src, async () => good.buffer.slice(0), dir)).toEqual(good);
    expect(new Uint8Array(readFileSync(join(dir, `${src.expectedSha256.slice(0, 12)}-${WASM_FILE}`)))).toEqual(good);
  });
});

describe('VoiceSession', () => {
  function setup(opts: { reply?: string; bargeIn?: boolean; heard?: string } = {}) {
    const said: string[] = [];
    const states: VoiceState[] = [];
    const log: string[] = [];
    const agent: AgentLike & { calls: Array<{ text: string; spoken?: boolean }> } = {
      calls: [],
      async handleUserMessage(text, o) {
        this.calls.push({ text, spoken: o?.spoken });
        const reply = opts.reply ?? 'First sentence here is long enough to speak now. Second one.';
        for (let i = 0; i < reply.length; i += 7) o?.onText?.(reply.slice(i, i + 7));
        return { text: reply, actions: [], interrupted: false };
      },
      interrupt: vi.fn(),
    };
    const stt: SpeechToText = { label: 's', transcribe: vi.fn(async () => opts.heard ?? 'hello agent') };
    const tts: TextToSpeech = { label: 't', synthesize: vi.fn(async (text: string): Promise<SpeechAudio> => { said.push(text); return { kind: 'pcm', samples: new Float32Array(1), sampleRate: 24000 }; }) };
    const player: PlayerLike = {
      playing: false,
      enqueue: vi.fn(async () => undefined),
      stop: vi.fn(),
    };
    const ui: VoiceUi = {
      state: (s) => states.push(s),
      user: (t, spoken) => log.push(`user${spoken ? '(voice)' : ''}: ${t}`),
      agentStart: (kind) => {
        let text = '';
        return { append: (t) => { text += t; }, status: () => undefined, change: () => undefined, end: (o) => log.push(`${kind}: ${text}${o?.error ? ` [error ${o.error}]` : ''}`) };
      },
      error: (m) => log.push(`error: ${m}`),
    };
    const session = new VoiceSession(agent, stt, tts, player, ui, { speak: true, speakProactive: true, bargeIn: opts.bargeIn ?? false });
    return { session, agent, stt, tts, player, said, states, log };
  }

  it('turns an utterance into a spoken reply, sentence by sentence', async () => {
    const { session, agent, said, log, player } = setup();
    await session.onUtterance(new Float32Array(16000));
    expect(agent.calls).toEqual([{ text: 'hello agent', spoken: true }]);
    expect(said).toEqual(['First sentence here is long enough to speak now.', 'Second one.']);
    expect(player.enqueue).toHaveBeenCalledTimes(2);
    expect(log).toEqual(['user(voice): hello agent', 'reply: First sentence here is long enough to speak now. Second one.']);
  });

  it('ignores an utterance that was only noise', async () => {
    const { session, agent } = setup({ heard: '' });
    await session.onUtterance(new Float32Array(100));
    expect(agent.calls).toHaveLength(0);
  });

  it('sends typed text as not spoken, and speaks proactive messages', async () => {
    const { session, agent, said, log } = setup();
    await session.sendText('typed');
    expect(agent.calls[0]).toEqual({ text: 'typed', spoken: false });
    said.length = 0;
    await session.proactive('Good morning. Your top priority is the plugin.', 'checkpoint:morning');
    expect(said).toEqual(['Good morning.', 'Your top priority is the plugin.']);
    expect(log.at(-1)).toBe('proactive: Good morning. Your top priority is the plugin.');
  });

  it('a new turn interrupts the agent and stops speech', async () => {
    const { session, agent, player } = setup();
    await session.sendText('one');
    await session.sendText('two');
    expect(agent.interrupt).toHaveBeenCalled();
    expect(player.stop).toHaveBeenCalled();
    expect(agent.calls.map(c => c.text)).toEqual(['one', 'two']);
  });

  it('ignores the mic while speaking unless barge-in is on', () => {
    const quiet = setup();
    (quiet.player as { playing: boolean }).playing = true;
    quiet.session.setListening(true);
    for (let i = 0; i < 30; i++) quiet.session.onFrame(frame(0.3));
    expect(quiet.player.stop).not.toHaveBeenCalled();

    const barge = setup({ bargeIn: true });
    (barge.player as { playing: boolean }).playing = true;
    barge.session.setListening(true);
    for (let i = 0; i < 30; i++) barge.session.onFrame(frame(0.3));
    expect(barge.player.stop).toHaveBeenCalled();
  });

  it('shows an engine error and says so', async () => {
    const { session, agent, log, said } = setup();
    agent.handleUserMessage = async () => ({ text: '', actions: [], interrupted: false, error: 'claude not found' });
    await session.sendText('hi');
    expect(log.at(-1)).toBe('reply:  [error claude not found]');
    expect(said.at(-1)).toMatch(/didn't work/);
  });
});
