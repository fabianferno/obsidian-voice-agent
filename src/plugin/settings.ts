// plugin/settings.ts - everything the user can set, and the settings tab.

import { App, Notice, PluginSettingTab, SecretComponent, Setting } from 'obsidian';
import type VoiceAgentPlugin from './main.js';
import { ENGINES, ENGINE_INFO, type EngineName } from '../engines/index.js';
import { DEFAULT_LAYOUT, type VaultLayout } from '../config/paths.js';
import { DEFAULT_CHECKPOINT_TIMES, parseTime, type CheckpointTimes } from '../checkins/scheduler.js';

export const STT_CHOICES = ['local', 'sarvam', 'soniox'] as const;
export const TTS_CHOICES = ['local', 'sarvam', 'soniox', 'off'] as const;
export type SttChoice = (typeof STT_CHOICES)[number];
export type TtsChoice = (typeof TTS_CHOICES)[number];

/** Settings holding plain text, edited with the generic text field. */
type StringSettingKey = {
  [K in keyof VoiceAgentSettings]: VoiceAgentSettings[K] extends string ? K : never;
}[keyof VoiceAgentSettings];

export interface VoiceAgentSettings {
  engine: EngineName;
  /** Optional full path per engine, when it is not on PATH. */
  engineBin: Record<EngineName, string>;
  model: string;
  permissions: 'edit' | 'full';
  extraArgs: string;

  agentName: string;
  layout: VaultLayout;
  checkpointTimes: CheckpointTimes;
  greetOnOpen: boolean;
  pulses: boolean;
  weather: boolean;

  stt: SttChoice;
  tts: TtsChoice;
  speakProactive: boolean;
  bargeIn: boolean;
  /** Start listening as soon as the panel opens. */
  listenOnOpen: boolean;
  localSttModel: string;
  localVoice: string;
  localSpeed: number;
  /** Names of secrets in Obsidian's secret storage (not the keys themselves). */
  sarvamSecret: string;
  sonioxSecret: string;
  sarvamSttLanguage: string;
  sarvamTtsModel: string;
  sarvamTtsSpeaker: string;
  sarvamTtsLanguage: string;
  sonioxSttModel: string;
  sonioxTtsModel: string;
  sonioxTtsVoice: string;
  sonioxLanguage: string;
}

export const DEFAULT_SETTINGS: VoiceAgentSettings = {
  engine: 'claude',
  engineBin: { claude: '', codex: '', antigravity: '' },
  model: '',
  permissions: 'edit',
  extraArgs: '',

  agentName: '',
  layout: { ...DEFAULT_LAYOUT },
  checkpointTimes: { ...DEFAULT_CHECKPOINT_TIMES },
  greetOnOpen: true,
  pulses: true,
  weather: true,

  stt: 'local',
  tts: 'local',
  speakProactive: true,
  bargeIn: false,
  listenOnOpen: false,
  localSttModel: 'Xenova/whisper-base.en',
  localVoice: 'af_heart',
  localSpeed: 1.1,
  sarvamSecret: '',
  sonioxSecret: '',
  sarvamSttLanguage: 'unknown',
  sarvamTtsModel: 'bulbul:v3',
  sarvamTtsSpeaker: '',
  sarvamTtsLanguage: 'en-IN',
  sonioxSttModel: 'stt-rt-v3',
  sonioxTtsModel: 'tts-rt-v2',
  sonioxTtsVoice: 'Adrian',
  sonioxLanguage: 'en',
};

/** Fills in anything missing from saved settings (older versions, hand edits). */
export function mergeSettings(saved: Partial<VoiceAgentSettings> | null | undefined): VoiceAgentSettings {
  const s = saved ?? {};
  return {
    ...DEFAULT_SETTINGS,
    ...s,
    engineBin: { ...DEFAULT_SETTINGS.engineBin, ...(s.engineBin ?? {}) },
    layout: { ...DEFAULT_SETTINGS.layout, ...(s.layout ?? {}) },
    checkpointTimes: { ...DEFAULT_SETTINGS.checkpointTimes, ...(s.checkpointTimes ?? {}) },
    engine: ENGINES.includes(s.engine as EngineName) ? (s.engine as EngineName) : DEFAULT_SETTINGS.engine,
  };
}

/** Splits extra CLI args, honouring simple quotes. */
export function parseExtraArgs(raw: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw))) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

const KOKORO_VOICES = [
  'af_heart', 'af_bella', 'af_nicole', 'af_sarah', 'af_kore', 'af_aoede', 'am_michael', 'am_fenrir', 'am_puck',
  'bf_emma', 'bf_isabella', 'bm_george', 'bm_fable',
];
const WHISPER_MODELS: Record<string, string> = {
  'Xenova/whisper-tiny.en': 'Tiny (English, fastest)',
  'Xenova/whisper-base.en': 'Base (English, recommended)',
  'Xenova/whisper-small.en': 'Small (English, most accurate, slower)',
  'Xenova/whisper-base': 'Base (multilingual)',
};

export class VoiceAgentSettingTab extends PluginSettingTab {
  constructor(app: App, private readonly plugin: VoiceAgentPlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    const s = this.plugin.settings;
    const save = async (opts: { restartAgent?: boolean; voice?: boolean; engine?: boolean } = {}) => {
      await this.plugin.saveSettings(opts);
    };
    containerEl.empty();

    // --- engine ---
    new Setting(containerEl).setName('Brain').setHeading();
    new Setting(containerEl)
      .setName('Engine')
      .setDesc('The coding agent that thinks and works in your vault. It must be installed and signed in on this computer.')
      .addDropdown(d => {
        for (const e of ENGINES) d.addOption(e, ENGINE_INFO[e].label);
        d.setValue(s.engine).onChange(async v => {
          s.engine = v as EngineName;
          await save({ engine: true });
          this.display();
        });
      })
      .addButton(b => b.setButtonText('Check').onClick(async () => {
        try {
          new Notice(`${ENGINE_INFO[s.engine].label}: ${await this.plugin.checkEngine()}`);
        } catch (err) {
          new Notice((err as Error).message, 10000);
        }
      }));
    new Setting(containerEl)
      .setName('Path to binary')
      .setDesc(`Leave empty to find "${ENGINE_INFO[s.engine].bin}" on your PATH.`)
      .addText(t => t.setPlaceholder(ENGINE_INFO[s.engine].bin).setValue(s.engineBin[s.engine]).onChange(async v => {
        s.engineBin[s.engine] = v.trim();
        await save({ engine: true });
      }));
    new Setting(containerEl)
      .setName('Model')
      .setDesc('Optional. Passed to the engine as --model (for example "sonnet" or "opus" for Claude Code).')
      .addText(t => t.setValue(s.model).onChange(async v => {
        s.model = v.trim();
        await save({ engine: true });
      }));
    new Setting(containerEl)
      .setName('Permissions')
      .setDesc('Edit: the engine may read and edit notes. Full: no restrictions, including shell commands. Use full only if you trust it with your machine.')
      .addDropdown(d => d.addOption('edit', 'Edit notes').addOption('full', 'Full access').setValue(s.permissions).onChange(async v => {
        s.permissions = v as 'edit' | 'full';
        await save({ engine: true });
      }));
    new Setting(containerEl)
      .setName('Extra arguments')
      .setDesc('Optional flags passed to the engine CLI as-is.')
      .addText(t => t.setValue(s.extraArgs).onChange(async v => {
        s.extraArgs = v;
        await save({ engine: true });
      }));

    // --- voice ---
    new Setting(containerEl).setName('Voice').setHeading();
    new Setting(containerEl)
      .setName('Listen with')
      .setDesc('Local runs Whisper on this computer: free, private, no key. Downloads the model once.')
      .addDropdown(d => d.addOption('local', 'Local (Whisper)').addOption('sarvam', 'Sarvam').addOption('soniox', 'Soniox')
        .setValue(s.stt).onChange(async v => {
          s.stt = v as SttChoice;
          await save({ voice: true });
          this.display();
        }));
    new Setting(containerEl)
      .setName('Speak with')
      .setDesc('Local runs Kokoro on this computer: free, private, no key.')
      .addDropdown(d => d.addOption('local', 'Local (Kokoro)').addOption('sarvam', 'Sarvam').addOption('soniox', 'Soniox').addOption('off', 'Off (text only)')
        .setValue(s.tts).onChange(async v => {
          s.tts = v as TtsChoice;
          await save({ voice: true });
          this.display();
        }));

    if (s.stt === 'local') {
      new Setting(containerEl).setName('Whisper model').addDropdown(d => {
        for (const [id, label] of Object.entries(WHISPER_MODELS)) d.addOption(id, label);
        d.setValue(s.localSttModel).onChange(async v => {
          s.localSttModel = v;
          await save({ voice: true });
        });
      });
    }
    if (s.tts === 'local') {
      new Setting(containerEl).setName('Kokoro voice').addDropdown(d => {
        for (const v of KOKORO_VOICES) d.addOption(v, v);
        d.setValue(s.localVoice).onChange(async v => {
          s.localVoice = v;
          await save({ voice: true });
        });
      });
      new Setting(containerEl).setName('Speaking speed').addSlider(sl => sl.setLimits(0.7, 1.5, 0.05).setValue(s.localSpeed).onChange(async v => {
        s.localSpeed = v;
        await save({ voice: true });
      }));
    }

    const usesSarvam = s.stt === 'sarvam' || s.tts === 'sarvam';
    const usesSoniox = s.stt === 'soniox' || s.tts === 'soniox';
    if (usesSarvam) {
      new Setting(containerEl)
        .setName('Sarvam API key')
        .setDesc('Stored in Obsidian\'s secret storage, not in the plugin settings file.')
        .addComponent(el => new SecretComponent(this.app, el).setValue(s.sarvamSecret).onChange(async v => {
          s.sarvamSecret = v ?? '';
          await save({ voice: true });
        }));
      if (s.stt === 'sarvam') this.text(containerEl, 'Sarvam recognition language', 'Language code, or "unknown" to detect.', 'sarvamSttLanguage');
      if (s.tts === 'sarvam') {
        this.text(containerEl, 'Sarvam voice model', '', 'sarvamTtsModel');
        this.text(containerEl, 'Sarvam speaker', 'Optional speaker name.', 'sarvamTtsSpeaker');
        this.text(containerEl, 'Sarvam speech language', 'For example en-IN or hi-IN.', 'sarvamTtsLanguage');
      }
    }
    if (usesSoniox) {
      new Setting(containerEl)
        .setName('Soniox API key')
        .setDesc('Stored in Obsidian\'s secret storage, not in the plugin settings file.')
        .addComponent(el => new SecretComponent(this.app, el).setValue(s.sonioxSecret).onChange(async v => {
          s.sonioxSecret = v ?? '';
          await save({ voice: true });
        }));
      if (s.stt === 'soniox') this.text(containerEl, 'Soniox recognition model', '', 'sonioxSttModel');
      if (s.tts === 'soniox') {
        this.text(containerEl, 'Soniox voice model', '', 'sonioxTtsModel');
        this.text(containerEl, 'Soniox voice', '', 'sonioxTtsVoice');
      }
      this.text(containerEl, 'Soniox language', '', 'sonioxLanguage');
    }

    this.toggle(containerEl, 'Speak briefings and nudges', 'Read proactive messages aloud, not just show them.', 'speakProactive', { voice: true });
    this.toggle(containerEl, 'Interrupt by talking', 'Your voice cuts the agent off mid-sentence. Best with headphones, or it may hear itself.', 'bargeIn', { voice: true });
    this.toggle(containerEl, 'Listen when the panel opens', 'Turn the microphone on automatically.', 'listenOnOpen');

    // --- check-ins ---
    new Setting(containerEl).setName('Check-ins').setHeading();
    new Setting(containerEl)
      .setName('Agent name')
      .setDesc('What the agent calls itself. Its voice and personality live in identity.md and soul.md in the agent folder.')
      .addText(t => t.setPlaceholder('Agent').setValue(s.agentName).onChange(async v => {
        s.agentName = v.trim();
        await save({ restartAgent: true });
      }));
    for (const [key, label] of [['morning', 'Morning briefing'], ['midday', 'Midday check'], ['evening', 'Evening wind-down']] as const) {
      new Setting(containerEl)
        .setName(label)
        .setDesc('Local time, HH:MM. Empty turns it off.')
        .addText(t => t.setPlaceholder('off').setValue(s.checkpointTimes[key]).onChange(async v => {
          const value = v.trim();
          if (value && !parseTime(value)) return;
          s.checkpointTimes[key] = value;
          await save({ restartAgent: true });
        }));
    }
    this.toggle(containerEl, 'Greet when Obsidian opens', 'A short snapshot when you open Obsidian (at most every 3 hours).', 'greetOnOpen', { restartAgent: true });
    this.toggle(containerEl, 'Nudges between check-ins', 'Short adaptive nudges. Quiet hours and the pulse interval come from user.md.', 'pulses', { restartAgent: true });
    this.toggle(containerEl, 'Weather', 'Adds local weather to briefings (open-meteo, no key). Needs Coordinates in user.md.', 'weather', { restartAgent: true });

    // --- vault layout ---
    new Setting(containerEl).setName('Vault layout').setHeading();
    const layoutText = (name: string, desc: string, key: keyof VaultLayout) =>
      new Setting(containerEl).setName(name).setDesc(desc).addText(t => t.setPlaceholder(DEFAULT_LAYOUT[key]).setValue(s.layout[key]).onChange(async v => {
        s.layout[key] = v.trim().replace(/^\/+|\/+$/g, '');
        await save({ restartAgent: true, engine: true });
      }));
    layoutText('Kanban board', 'Path to your Kanban board note (Obsidian Kanban plugin format).', 'boardPath');
    layoutText('Agent folder', 'Where soul.md, identity.md, user.md, goals.md and memory.md live. Created on first run.', 'agentFolder');
    layoutText('Capture folder', 'Quick notes older than 48 hours get a triage nudge. Empty turns this off.', 'captureFolder');
    layoutText('Notes folder', 'Where people and literature notes are written.', 'notesFolder');
    layoutText('Daily notes folder', 'The agent never reads or writes here.', 'dailyFolder');
  }

  private text(el: HTMLElement, name: string, desc: string, key: StringSettingKey): void {
    new Setting(el).setName(name).setDesc(desc).addText(t => t.setValue(this.plugin.settings[key]).onChange(async v => {
      (this.plugin.settings as unknown as Record<string, unknown>)[key] = v.trim();
      await this.plugin.saveSettings({ voice: true });
    }));
  }

  private toggle(el: HTMLElement, name: string, desc: string, key: keyof VoiceAgentSettings, opts: { restartAgent?: boolean; voice?: boolean } = {}): void {
    new Setting(el).setName(name).setDesc(desc).addToggle(t => t.setValue(Boolean(this.plugin.settings[key])).onChange(async v => {
      (this.plugin.settings as unknown as Record<string, unknown>)[key] = v;
      await this.plugin.saveSettings(opts);
    }));
  }
}
