// plugin/main.ts - the Obsidian plugin: wires the agent, the engine, voice and the panel.

import { FileSystemAdapter, Notice, Platform, Plugin, requestUrl } from 'obsidian';
import { createHash } from 'crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import path from 'path';
import WORKER_SOURCE from 'virtual:voice-worker';
import ORT_GLUE from 'virtual:ort-glue';
import { Agent, type AgentSettings } from '../agent/agent.js';
import { Store, type StoreData } from '../store/store.js';
import { setLayout, setVaultPath } from '../config/paths.js';
import { checkEngine, createEngine, ENGINE_INFO, type EngineSession } from '../engines/index.js';
import { shellEnv } from '../engines/shell-env.js';
import { VoiceSession } from '../voice/session.js';
import { Player } from '../voice/player.js';
import { Mic } from '../voice/mic.js';
import { ElevenLabsTts, SarvamStt, SarvamTts, SonioxStt, SonioxTts } from '../voice/cloud.js';
import { LocalVoiceWorker, LocalWhisper } from '../voice/local/client.js';
import { SystemTts } from '../voice/system.js';
import { cacheRoot, ensureWasm } from '../voice/local/runtime.js';
import { removeOldKokoroModels } from '../voice/local/cleanup.js';
import { createLogger } from '../utils/logger.js';
import type { Http } from '../voice/http.js';
import type { SpeechToText, TextToSpeech } from '../voice/types.js';
import { Transcript } from './transcript.js';
import { VIEW_TYPE, VoiceAgentView } from './view.js';
import { DEFAULT_SETTINGS, VoiceAgentSettingTab, mergeSettings, parseExtraArgs, type VoiceAgentSettings } from './settings.js';

declare const ORT_WASM_SHA256: string;
declare const TRANSFORMERS_VERSION: string;

export default class VoiceAgentPlugin extends Plugin {
  settings: VoiceAgentSettings = DEFAULT_SETTINGS;
  transcript = new Transcript();
  private vaultPath = '';
  private agent?: Agent;
  private store?: Store;
  private env?: NodeJS.ProcessEnv;
  private session?: VoiceSession;
  private player = new Player();
  private mic = new Mic();
  private localWorker?: LocalVoiceWorker;
  private saveTimer?: number;
  private pendingState?: StoreData;
  private stateFile = '';

  async onload(): Promise<void> {
    const saved = (await this.loadData()) as { settings?: Partial<VoiceAgentSettings> } | null;
    this.settings = mergeSettings(saved?.settings);
    if (!Platform.isDesktopApp || !(this.app.vault.adapter instanceof FileSystemAdapter)) {
      new Notice('Voice agent needs Obsidian on desktop.');
      return;
    }
    this.vaultPath = this.app.vault.adapter.getBasePath();
    setVaultPath(this.vaultPath);
    setLayout(this.settings.layout);

    this.registerView(VIEW_TYPE, (leaf) => new VoiceAgentView(leaf, this));
    this.addRibbonIcon('audio-lines', 'Open voice agent', () => void this.openPanel());
    this.addSettingTab(new VoiceAgentSettingTab(this.app, this));

    this.addCommand({ id: 'open-panel', name: 'Open panel', callback: () => void this.openPanel() });
    this.addCommand({ id: 'toggle-listening', name: 'Talk (start or stop listening)', callback: () => void this.toggleListening() });
    this.addCommand({ id: 'stop', name: 'Stop speaking', callback: () => this.interrupt() });
    this.addCommand({ id: 'new-conversation', name: 'New conversation', callback: () => void this.newConversation() });

    this.transcript.onProactive = (text) => {
      if (!this.panelVisible()) new Notice(text, 15000);
    };

    // Engine lookup and agent start can take a moment (login shell, files):
    // do it once the workspace is ready so Obsidian's startup is not delayed.
    this.app.workspace.onLayoutReady(() => {
      void this.startAgent();
      // Free the space Kokoro (0.1.x) used; harmless when there is nothing to remove.
      removeOldKokoroModels().then(
        (n) => { if (n) createLogger('voice').info(`Removed ${n} old Kokoro model files from the cache`); },
        () => undefined,
      );
    });
  }

  onunload(): void {
    this.agent?.stop();
    this.mic.stop();
    this.player.dispose();
    this.localWorker?.dispose();
    this.flushState();
  }

  // --- state ---

  private loadState(): Store {
    const id = createHash('sha1').update(this.vaultPath).digest('hex').slice(0, 12);
    this.stateFile = path.join(cacheRoot(), 'state', `${id}.json`);
    let initial: Partial<StoreData> | null = null;
    try {
      if (existsSync(this.stateFile)) initial = JSON.parse(readFileSync(this.stateFile, 'utf-8')) as Partial<StoreData>;
    } catch (err) {
      console.error('[voice-agent] Could not read state, starting fresh', err);
    }
    return new Store(initial, (data) => {
      this.pendingState = data;
      window.clearTimeout(this.saveTimer);
      this.saveTimer = window.setTimeout(() => this.flushState(), 1000);
    });
  }

  /** Agent state lives outside the vault so obsidian-git does not commit it. */
  private flushState(): void {
    if (!this.pendingState || !this.stateFile) return;
    try {
      mkdirSync(path.dirname(this.stateFile), { recursive: true });
      writeFileSync(`${this.stateFile}.tmp`, JSON.stringify(this.pendingState));
      renameSync(`${this.stateFile}.tmp`, this.stateFile);
      this.pendingState = undefined;
    } catch (err) {
      console.error('[voice-agent] Could not save state', err);
    }
  }

  // --- agent ---

  private agentSettings(): AgentSettings {
    const s = this.settings;
    return {
      agentName: s.agentName,
      checkpointTimes: s.checkpointTimes,
      greetOnOpen: s.greetOnOpen,
      pulses: s.pulses,
      weather: s.weather,
    };
  }

  private engineFactory() {
    const s = this.settings;
    return (systemPrompt: string): EngineSession => createEngine(s.engine, {
      bin: s.engineBin[s.engine] || ENGINE_INFO[s.engine].bin,
      cwd: this.vaultPath,
      model: s.model || undefined,
      permissions: s.permissions,
      extraArgs: parseExtraArgs(s.extraArgs),
      systemPrompt,
      env: this.env,
      denyPaths: [s.layout.dailyFolder],
      protectPaths: [s.layout.boardPath, s.layout.agentFolder],
    });
  }

  private async startAgent(): Promise<void> {
    try {
      this.env = await shellEnv();
      this.store = this.loadState();
      this.session = new VoiceSession(
        { handleUserMessage: (t, o) => this.requireAgent().handleUserMessage(t, o), interrupt: () => this.agent?.interrupt() },
        null, null, this.player, this.transcript, this.voiceOptions(),
      );
      this.rebuildVoice();
      this.agent = new Agent(this.vaultPath, this.store, this.engineFactory(), this.agentSettings(), (m) => {
        void this.session?.proactive(m.text, m.source);
      });
      await this.agent.start();
    } catch (err) {
      console.error('[voice-agent] Failed to start', err);
      new Notice(`Voice agent could not start: ${(err as Error).message}`, 10000);
    }
  }

  private requireAgent(): Agent {
    if (!this.agent) throw new Error('The agent is still starting. Try again in a moment.');
    return this.agent;
  }

  async checkEngine(): Promise<string> {
    const s = this.settings;
    this.env ??= await shellEnv();
    return checkEngine(s.engine, s.engineBin[s.engine] || ENGINE_INFO[s.engine].bin, this.env);
  }

  // --- voice ---

  private voiceOptions() {
    const s = this.settings;
    return { speak: s.tts !== 'off', speakProactive: s.speakProactive, bargeIn: s.bargeIn };
  }

  private http: Http = async (req) => {
    const res = await requestUrl({ url: req.url, method: req.method, headers: req.headers, body: req.body, contentType: req.contentType, throw: false });
    return { status: res.status, text: res.text, arrayBuffer: res.arrayBuffer };
  };

  private secret(name: string, label: string): string {
    const value = name ? this.app.secretStorage.getSecret(name) : null;
    if (!value) throw new Error(`Set your ${label} API key in the voice agent settings.`);
    return value;
  }

  private worker(): LocalVoiceWorker {
    this.localWorker ??= new LocalVoiceWorker({
      workerSource: WORKER_SOURCE,
      runtime: async () => {
        const wasm = await ensureWasm(
          { baseUrl: `https://cdn.jsdelivr.net/npm/@huggingface/transformers@${TRANSFORMERS_VERSION}/dist/`, expectedSha256: ORT_WASM_SHA256 },
          async (url) => (await requestUrl({ url })).arrayBuffer,
          undefined,
          (msg) => this.setNotice(msg),
        );
        this.setNotice('');
        return {
          mjs: URL.createObjectURL(new Blob([ORT_GLUE], { type: 'text/javascript' })),
          wasm: URL.createObjectURL(new Blob([wasm as Uint8Array<ArrayBuffer>], { type: 'application/wasm' })),
        };
      },
      onProgress: (msg) => this.setNotice(msg),
    });
    return this.localWorker;
  }

  private buildStt(): SpeechToText | null {
    const s = this.settings;
    try {
      switch (s.stt) {
        case 'local': return new LocalWhisper(this.worker(), s.localSttModel);
        case 'sarvam': return new SarvamStt(this.http, this.secret(s.sarvamSecret, 'Sarvam'), { language: s.sarvamSttLanguage });
        case 'soniox': return new SonioxStt(this.secret(s.sonioxSecret, 'Soniox'), { model: s.sonioxSttModel, language: s.sonioxLanguage });
      }
    } catch (err) {
      this.transcript.error((err as Error).message);
      return null;
    }
  }

  private buildTts(): TextToSpeech | null {
    const s = this.settings;
    try {
      switch (s.tts) {
        case 'off': return null;
        case 'system': return new SystemTts(s.systemVoice, s.speechRate);
        case 'elevenlabs': return new ElevenLabsTts(this.http, this.secret(s.elevenlabsSecret, 'ElevenLabs'), {
          voice: s.elevenlabsVoice, model: s.elevenlabsModel,
        });
        case 'sarvam': return new SarvamTts(this.http, this.secret(s.sarvamSecret, 'Sarvam'), {
          model: s.sarvamTtsModel, speaker: s.sarvamTtsSpeaker || undefined, language: s.sarvamTtsLanguage,
        });
        case 'soniox': return new SonioxTts(this.http, this.secret(s.sonioxSecret, 'Soniox'), {
          model: s.sonioxTtsModel, voice: s.sonioxTtsVoice, language: s.sonioxLanguage,
        });
      }
    } catch (err) {
      this.transcript.error((err as Error).message);
      return null;
    }
  }

  private stt: SpeechToText | null = null;
  private tts: TextToSpeech | null = null;
  private warmed = false;

  private rebuildVoice(): void {
    if (this.settings.stt !== 'local') {
      this.localWorker?.dispose();
      this.localWorker = undefined;
    }
    this.stt = this.buildStt();
    this.tts = this.buildTts();
    this.warmed = false;
    this.session?.setProviders(this.stt, this.tts);
    this.session?.setOptions(this.voiceOptions());
  }

  /** Loads local models ahead of the first turn (downloads them the first time). */
  private warmup(): void {
    if (this.warmed) return;
    this.warmed = true;
    for (const p of [this.stt, this.tts]) {
      if (!p?.warmup) continue;
      this.setNotice(`Loading ${p.label}...`);
      p.warmup().then(
        () => this.setNotice(''),
        (err) => {
          this.warmed = false;
          this.setNotice('');
          this.transcript.error(`Could not load ${p.label}: ${(err as Error).message}`);
        },
      );
    }
  }

  get isListening(): boolean {
    return this.mic.active;
  }

  async toggleListening(): Promise<void> {
    if (!this.session) return void new Notice('The voice agent is still starting.');
    if (this.mic.active) {
      this.mic.stop();
      this.session.setListening(false);
      return;
    }
    if (!this.stt) {
      this.stt = this.buildStt();
      this.session.setProviders(this.stt, this.tts);
      if (!this.stt) return;
    }
    await this.openPanel();
    this.warmup();
    try {
      this.mic.onFrame = (f) => this.session?.onFrame(f);
      await this.mic.start();
      this.session.setListening(true);
    } catch (err) {
      this.transcript.error(`Microphone unavailable: ${(err as Error).message}. Check that Obsidian may use the microphone in your system settings.`);
    }
  }

  async sendText(text: string): Promise<void> {
    if (!this.session) return void new Notice('The voice agent is still starting.');
    if (this.tts && !this.warmed) this.warmup();
    await this.session.sendText(text);
  }

  interrupt(): void {
    this.session?.interrupt();
  }

  /** Speaks a sample sentence with the current voice (settings, Test voice). */
  async previewVoice(): Promise<void> {
    const tts = this.tts ?? this.buildTts();
    if (!tts) return;
    const name = this.settings.agentName || 'your voice agent';
    try {
      this.player.stop();
      await this.player.enqueue(tts.synthesize(`Hi, I'm ${name}. This is how I sound.`));
    } catch (err) {
      new Notice(`Voice test failed: ${(err as Error).message}`);
    }
  }

  async newConversation(): Promise<void> {
    this.interrupt();
    await this.agent?.resetConversation();
    this.transcript.clear();
  }

  // --- panel ---

  private panelVisible(): boolean {
    return this.app.workspace.getLeavesOfType(VIEW_TYPE).some(l => (l.view as VoiceAgentView).containerEl.isShown());
  }

  private setNotice(text: string): void {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) (leaf.view as VoiceAgentView).setNotice(text);
  }

  async openPanel(): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0];
    if (existing) {
      await this.app.workspace.revealLeaf(existing);
      return;
    }
    const leaf = this.app.workspace.getRightLeaf(false);
    if (!leaf) return;
    await leaf.setViewState({ type: VIEW_TYPE, active: true });
    await this.app.workspace.revealLeaf(leaf);
  }

  // --- settings ---

  async saveSettings(opts: { restartAgent?: boolean; voice?: boolean; engine?: boolean } = {}): Promise<void> {
    await this.saveData({ settings: this.settings });
    if (opts.restartAgent) {
      setLayout(this.settings.layout);
      this.agent?.updateSettings(this.agentSettings());
    }
    if (opts.engine) this.agent?.setEngineFactory(this.engineFactory());
    if (opts.voice) this.rebuildVoice();
  }
}
