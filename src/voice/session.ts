// voice/session.ts - one spoken conversation inside Obsidian.
//
// Mic frames -> VAD -> utterance -> speech recognition -> agent turn, whose
// streamed words are cut into sentences, spoken one at a time, and played in
// order. A new utterance interrupts the current turn once its words are known
// (a cough must not kill a long task). Typed messages and proactive messages
// (briefings) go through the same speaking path.

import type { SpeechAudio, SpeechToText, TextToSpeech } from './types.js';
import { EnergyVad, type VadOptions } from './vad.js';
import { SentenceChunker } from '../speech/chunker.js';
import { cleanForSpeech, hasSpeakableText } from '../speech/clean.js';
import type { ReplyHandlers, TurnOutcome } from '../agent/agent.js';
import type { NoteChange } from '../agent/changes.js';

export type VoiceState = 'idle' | 'listening' | 'hearing' | 'transcribing' | 'thinking' | 'speaking';

export interface AgentLike {
  handleUserMessage(text: string, opts?: { spoken?: boolean } & ReplyHandlers): Promise<TurnOutcome>;
  interrupt(): void;
}

export interface PlayerLike {
  readonly playing: boolean;
  enqueue(audio: Promise<SpeechAudio> | SpeechAudio): Promise<void>;
  stop(): void;
  onStateChange?: (playing: boolean) => void;
}

export interface VoiceUi {
  state(s: VoiceState): void;
  user(text: string, spoken: boolean): void;
  /** A new agent message begins (reply or proactive). Returns a handle for updates. */
  agentStart(kind: 'reply' | 'proactive', source?: string): AgentMessageHandle;
  error(message: string): void;
}

export interface AgentMessageHandle {
  append(text: string): void;
  status(text: string): void;
  /** A note or file the message's turn touched. Shown, never spoken. */
  change(change: NoteChange): void;
  end(opts?: { error?: string; interrupted?: boolean }): void;
}

export interface VoiceSessionOptions {
  /** Speak replies aloud. */
  speak: boolean;
  /** Speak proactive messages (briefings, nudges). */
  speakProactive: boolean;
  /** Let the user's voice cut off the agent's speech. Best with headphones. */
  bargeIn: boolean;
  vad?: Partial<VadOptions>;
}

/** Said while the agent is still working, so a slow turn doesn't feel dead. */
const FILLERS = ['One moment.', 'On it.', 'Let me check.', 'Give me a second.'];
const FILLER_AFTER_MS = 2500;

export class VoiceSession {
  private vad: EnergyVad;
  private listening = false;
  private turnId = 0;
  private running: Promise<void> = Promise.resolve();
  private sttQueue: Promise<unknown> = Promise.resolve();
  private inputTicket = 0;
  private pendingText = '';
  private busy = 0;
  private transcribing = 0;
  private speechGen = 0;

  constructor(
    private readonly agent: AgentLike,
    private stt: SpeechToText | null,
    private tts: TextToSpeech | null,
    private readonly player: PlayerLike,
    private readonly ui: VoiceUi,
    private opts: VoiceSessionOptions,
  ) {
    this.vad = new EnergyVad(opts.vad);
    player.onStateChange = () => this.refreshState();
  }

  setProviders(stt: SpeechToText | null, tts: TextToSpeech | null): void {
    this.stt = stt;
    this.tts = tts;
  }

  setOptions(opts: VoiceSessionOptions): void {
    this.opts = opts;
  }

  get isListening(): boolean {
    return this.listening;
  }

  setListening(on: boolean): void {
    this.listening = on;
    this.vad.reset();
    this.refreshState();
  }

  private refreshState(): void {
    let s: VoiceState = 'idle';
    if (this.listening) s = 'listening';
    if (this.vad.isSpeaking) s = 'hearing';
    if (this.transcribing > 0) s = 'transcribing';
    else if (this.player.playing) s = 'speaking';
    else if (this.busy > 0) s = 'thinking';
    this.ui.state(s);
  }

  /** A 30 ms frame of 16 kHz mic audio. */
  onFrame(frame: Float32Array): void {
    if (!this.listening) return;
    // Without barge-in, the mic is ignored while the agent speaks, so it can
    // never hear itself and reply to its own voice.
    if (this.player.playing && !this.opts.bargeIn) {
      if (this.vad.isSpeaking) this.vad.reset();
      return;
    }
    const ev = this.vad.push(frame);
    if (!ev) return;
    if (ev.type === 'start') {
      if (this.opts.bargeIn && this.player.playing) this.stopSpeaking();
      this.refreshState();
    } else if (ev.type === 'end') {
      void this.onUtterance(ev.audio);
    } else {
      this.refreshState();
    }
  }

  /** A finished utterance (16 kHz samples). */
  async onUtterance(samples: Float32Array): Promise<void> {
    const stt = this.stt;
    if (!stt) return;
    const ticket = ++this.inputTicket;
    this.transcribing++;
    this.refreshState();
    let text = '';
    const job = this.sttQueue.then(() => stt.transcribe(samples));
    this.sttQueue = job.catch(() => undefined);
    try {
      text = (await job).trim();
    } catch (err) {
      this.ui.error(`Speech recognition failed: ${errMessage(err)}`);
    } finally {
      this.transcribing--;
      this.refreshState();
    }
    if (text && hasSpeakableText(text)) this.pendingText = this.pendingText ? `${this.pendingText} ${text}` : text;
    // A newer utterance is still being transcribed: it carries this text along.
    if (ticket !== this.inputTicket) return;
    const full = this.pendingText;
    this.pendingText = '';
    if (full) await this.startTurn(full, true);
  }

  /** Typed input. */
  async sendText(text: string): Promise<void> {
    const t = text.trim();
    if (t) await this.startTurn(t, false);
  }

  /** Stops speech and the agent's current turn. */
  interrupt(): void {
    this.turnId++;
    this.stopSpeaking();
    this.agent.interrupt();
  }

  private stopSpeaking(): void {
    this.speechGen++;
    this.player.stop();
  }

  /** Shows (and maybe speaks) a message the agent started on its own. */
  async proactive(text: string, source: string, extra: { changes?: NoteChange[]; speak?: boolean } = {}): Promise<void> {
    const handle = this.ui.agentStart('proactive', source);
    handle.append(text);
    for (const c of extra.changes ?? []) handle.change(c);
    handle.end();
    if (extra.speak !== false && this.opts.speak && this.opts.speakProactive && this.tts) {
      const speaker = this.makeSpeaker(() => true);
      const chunker = new SentenceChunker();
      for (const piece of chunker.push(text)) speaker.say(piece);
      const rest = chunker.flush();
      if (rest) speaker.say(rest);
      await speaker.done();
    }
  }

  /**
   * Turns are chained: each waits for the previous (already interrupted) one
   * to wind down. A turn superseded before it began is skipped.
   */
  private async startTurn(text: string, spoken: boolean): Promise<void> {
    this.interrupt();
    const turn = this.turnId;
    const prev = this.running;
    const run = (async () => {
      await prev.catch(() => undefined);
      if (turn !== this.turnId) return;
      this.ui.user(text, spoken);
      await this.runTurn(turn, text, spoken);
    })();
    this.running = run;
    await run;
  }

  private makeSpeaker(alive: () => boolean) {
    const gen = this.speechGen;
    let chain: Promise<void> = Promise.resolve();
    const live = () => alive() && gen === this.speechGen;
    return {
      say: (raw: string) => {
        const tts = this.tts;
        if (!tts || !this.opts.speak) return;
        const spoken = cleanForSpeech(raw);
        if (!hasSpeakableText(spoken)) return;
        // Synthesis runs ahead (one at a time in the provider); playback is ordered.
        const audio = tts.synthesize(spoken);
        audio.catch(() => undefined);
        chain = chain.then(async () => {
          if (!live()) return;
          try {
            await this.player.enqueue(audio);
          } catch (err) {
            if (live()) this.ui.error(`Speech failed: ${errMessage(err)}`);
          }
        });
      },
      done: () => chain,
    };
  }

  private async runTurn(turn: number, text: string, spoken: boolean): Promise<void> {
    const alive = () => turn === this.turnId;
    this.busy++;
    this.refreshState();
    const handle = this.ui.agentStart('reply');
    const speaker = this.makeSpeaker(alive);
    const chunker = new SentenceChunker();
    let gotText = false;
    const filler = spoken
      ? window.setTimeout(() => { if (alive() && !gotText) speaker.say(FILLERS[Math.floor(Math.random() * FILLERS.length)]); }, FILLER_AFTER_MS)
      : undefined;

    let outcome: TurnOutcome | undefined;
    try {
      outcome = await this.agent.handleUserMessage(text, {
        spoken,
        onText: (delta) => {
          if (!alive()) return;
          gotText = true;
          handle.append(delta);
          for (const piece of chunker.push(delta)) speaker.say(piece);
        },
        onStatus: (s) => { if (alive()) handle.status(s); },
        onChange: (c) => { if (alive()) handle.change(c); },
      });
    } catch (err) {
      outcome = { text: '', actions: [], interrupted: false, error: errMessage(err) };
    } finally {
      if (filler) window.clearTimeout(filler);
    }

    try {
      if (!alive() || outcome.interrupted) {
        handle.end({ interrupted: true });
        return;
      }
      const rest = chunker.flush();
      if (rest) speaker.say(rest);
      if (outcome.error) {
        handle.end({ error: outcome.error });
        speaker.say("Sorry, that didn't work. The details are on screen.");
      } else {
        handle.end();
      }
      await speaker.done();
    } finally {
      this.busy--;
      this.refreshState();
    }
  }
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
