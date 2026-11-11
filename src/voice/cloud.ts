// voice/cloud.ts - Sarvam and Soniox speech, both optional and keyed.

import type { SpeechAudio, SpeechToText, TextToSpeech } from './types.js';
import { base64ToArrayBuffer, multipart, type Http } from './http.js';
import { encodeWav } from '../speech/wav.js';

function fail(what: string, status: number, text: string): Error {
  return new Error(`${what} failed (${status}): ${text.slice(0, 300)}`);
}

/** Sarvam speech-to-text (REST). Strong on Indian languages and accents. */
export class SarvamStt implements SpeechToText {
  readonly label = 'Sarvam';
  constructor(private http: Http, private apiKey: string, private opts: { model?: string; language: string }) {}

  async transcribe(samples: Float32Array): Promise<string> {
    const wav = new Uint8Array(encodeWav(samples, 16000));
    const form = multipart(
      { model: this.opts.model, language_code: this.opts.language },
      { field: 'file', name: 'speech.wav', type: 'audio/wav', data: wav },
    );
    const res = await this.http({
      url: 'https://api.sarvam.ai/speech-to-text', method: 'POST',
      headers: { 'api-subscription-key': this.apiKey }, body: form.body, contentType: form.contentType,
    });
    if (res.status >= 300) throw fail('Sarvam speech recognition', res.status, res.text);
    return String((JSON.parse(res.text) as { transcript?: string }).transcript ?? '').trim();
  }
}

/** Sarvam Bulbul text-to-speech (REST). */
export class SarvamTts implements TextToSpeech {
  readonly label: string;
  constructor(private http: Http, private apiKey: string, private opts: { model: string; speaker?: string; language: string; pace?: number }) {
    this.label = `Sarvam (${opts.model}${opts.speaker ? `, ${opts.speaker}` : ''})`;
  }

  async synthesize(text: string): Promise<SpeechAudio> {
    const body: Record<string, unknown> = {
      text, target_language_code: this.opts.language, model: this.opts.model, speech_sample_rate: 24000,
    };
    if (this.opts.speaker) body.speaker = this.opts.speaker;
    if (this.opts.pace) body.pace = this.opts.pace;
    const res = await this.http({
      url: 'https://api.sarvam.ai/text-to-speech', method: 'POST',
      headers: { 'api-subscription-key': this.apiKey }, body: JSON.stringify(body), contentType: 'application/json',
    });
    if (res.status >= 300) throw fail('Sarvam speech', res.status, res.text);
    const b64 = (JSON.parse(res.text) as { audios?: string[] }).audios?.[0];
    if (!b64) throw new Error('Sarvam returned no audio');
    return { kind: 'encoded', data: base64ToArrayBuffer(b64) };
  }
}

/** Soniox text-to-speech (REST). */
export class SonioxTts implements TextToSpeech {
  readonly label: string;
  constructor(private http: Http, private apiKey: string, private opts: { model: string; voice: string; language: string }) {
    this.label = `Soniox (${opts.voice})`;
  }

  async synthesize(text: string): Promise<SpeechAudio> {
    const res = await this.http({
      url: 'https://tts-rt.soniox.com/tts', method: 'POST',
      headers: { Authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({ model: this.opts.model, voice: this.opts.voice, language: this.opts.language, audio_format: 'wav', text }),
      contentType: 'application/json',
    });
    if (res.status >= 300) throw fail('Soniox speech', res.status, res.text);
    return { kind: 'encoded', data: res.arrayBuffer };
  }
}

interface SonioxToken {
  text: string;
  is_final?: boolean;
}

/**
 * Soniox real-time speech-to-text over a WebSocket. Browsers cannot set an
 * Authorization header on a WebSocket, so the key goes in the first (config)
 * message, as Soniox documents for browser clients.
 */
export class SonioxStt implements SpeechToText {
  readonly label = 'Soniox';
  constructor(
    private apiKey: string,
    private opts: { model: string; language: string },
    private makeSocket: (url: string) => WebSocket = (url) => new WebSocket(url),
  ) {}

  transcribe(samples: Float32Array): Promise<string> {
    const wav = encodeWav(samples, 16000);
    return new Promise((resolve, reject) => {
      const ws = this.makeSocket('wss://stt-rt.soniox.com/transcribe-websocket');
      ws.binaryType = 'arraybuffer';
      const finals: string[] = [];
      let settled = false;
      const done = (err?: Error) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        try { ws.close(); } catch { /* closed */ }
        if (err) reject(err);
        else resolve(finals.join('').replace(/<end>/g, '').replace(/\s+/g, ' ').trim());
      };
      const timer = window.setTimeout(() => done(new Error('Soniox speech recognition timed out')), 30000);
      ws.onopen = () => {
        ws.send(JSON.stringify({ api_key: this.apiKey, model: this.opts.model, audio_format: 'auto', language_hints: [this.opts.language] }));
        for (let i = 0; i < wav.length; i += 32 * 1024) ws.send(wav.subarray(i, i + 32 * 1024));
        ws.send(''); // end of audio
      };
      ws.onmessage = (ev) => {
        let msg: { tokens?: SonioxToken[]; finished?: boolean; error_code?: number; error_message?: string };
        try {
          msg = JSON.parse(typeof ev.data === 'string' ? ev.data : new TextDecoder().decode(ev.data as ArrayBuffer)) as typeof msg;
        } catch {
          return;
        }
        if (msg.error_code) return done(new Error(`Soniox error ${msg.error_code}: ${msg.error_message ?? ''}`));
        for (const t of msg.tokens ?? []) if (t.is_final) finals.push(t.text);
        if (msg.finished) done();
      };
      ws.onerror = () => done(new Error('Soniox connection failed'));
      ws.onclose = () => done();
    });
  }
}
