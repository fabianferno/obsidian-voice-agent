// plugin/settings.ts - everything the user can set, and the settings tab.

import { App, Notice, Platform, PluginSettingTab, SecretComponent, Setting } from 'obsidian';
import type VoiceAgentPlugin from './main.js';
import { ENGINES, ENGINE_INFO, type EngineName } from '../engines/index.js';
import { DEFAULT_LAYOUT, type VaultLayout } from '../config/paths.js';
import { parseTime } from '../checkins/scheduler.js';
import { pickBestVoice, systemVoices, voiceQuality, type VoiceInfo } from '../voice/system.js';

export * from './settings-data.js';
import { type SttChoice, type StringSettingKey, type TtsChoice, type VoiceAgentSettings } from './settings-data.js';

const VOICE_TIP = Platform.isMacOS
  ? 'Automatic uses your best installed voice for your language. For a much more natural one, download a Premium or Enhanced voice in System Settings, Accessibility, Spoken Content, System voice, Manage voices, then restart Obsidian. (Personal Voice is not available to Obsidian.)'
  : Platform.isWin
    ? 'More voices: Windows Settings, Time & language, Speech, Add voices. Then restart Obsidian.'
    : 'Voices come from speech-dispatcher (for example espeak-ng or piper).';

/** Voices in the system language first, best quality first, then alphabetical. */
function sortVoices(voices: VoiceInfo[]): VoiceInfo[] {
  const lang = (navigator.language || 'en').slice(0, 2).toLowerCase();
  const rank = (v: VoiceInfo) => (v.lang.toLowerCase().startsWith(lang) ? 0 : 1);
  return [...voices].sort((a, b) => rank(a) - rank(b) || voiceQuality(b.name) - voiceQuality(a.name) || a.name.localeCompare(b.name));
}

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
      .setDesc('System voice is built into your computer: instant, private, no download, no key. ElevenLabs, Sarvam and Soniox are cloud voices that need a key.')
      .addDropdown(d => d.addOption('system', 'System voice').addOption('elevenlabs', 'ElevenLabs').addOption('sarvam', 'Sarvam').addOption('soniox', 'Soniox').addOption('off', 'Off (text only)')
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
    if (s.tts === 'system') {
      new Setting(containerEl)
        .setName('System voice')
        .setDesc(VOICE_TIP)
        .addDropdown(d => {
          d.addOption('', 'Automatic (best voice installed)');
          if (s.systemVoice) d.addOption(s.systemVoice, s.systemVoice);
          d.setValue(s.systemVoice).onChange(async v => {
            s.systemVoice = v;
            await save({ voice: true });
          });
          void (async () => {
            const voices = await systemVoices();
            for (const v of sortVoices(voices)) if (v.name !== s.systemVoice) d.addOption(v.name, `${v.name} (${v.lang})`);
            d.setValue(s.systemVoice);
            const auto = pickBestVoice(voices, navigator.language || 'en-US');
            if (auto) d.selectEl.options[0].text = `Automatic (now: ${auto.name})`;
          })().catch(() => undefined);
        });
      new Setting(containerEl).setName('Speaking speed').addSlider(sl => sl.setLimits(0.7, 1.5, 0.05).setValue(s.speechRate).onChange(async v => {
        s.speechRate = v;
        await save({ voice: true });
      }));
    }
    if (s.tts === 'elevenlabs') {
      new Setting(containerEl)
        .setName('ElevenLabs API key')
        .setDesc('Stored in Obsidian\'s secret storage, not in the plugin settings file.')
        .addComponent(el => new SecretComponent(this.app, el).setValue(s.elevenlabsSecret).onChange(async v => {
          s.elevenlabsSecret = v ?? '';
          await save({ voice: true });
        }));
      this.text(containerEl, 'ElevenLabs voice ID', 'From the voice library (Voices, then the ID button). The default is a premade voice that works on the free plan.', 'elevenlabsVoice');
      this.text(containerEl, 'ElevenLabs model', 'eleven_flash_v2_5 is the fastest. eleven_multilingual_v2 sounds richer but is slower.', 'elevenlabsModel');
    }
    if (s.tts !== 'off') {
      new Setting(containerEl)
        .setName('Test voice')
        .setDesc('Say a short sentence with the current voice.')
        .addButton(b => b.setButtonText('Play').onClick(() => void this.plugin.previewVoice()));
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

    // --- second brain ---
    new Setting(containerEl).setName('Second brain').setHeading();
    this.toggle(containerEl, 'File things from conversations', 'People, projects, your own ideas and decisions you mention get a dated line in their note, or a new note in the capture folder.', 'capture', { restartAgent: true });
    this.toggle(containerEl, 'Tend capture notes daily', 'Once a day the agent tidies ready notes in the capture folder and moves them to the notes folder, or leaves a question inside the note. Your words are never rewritten.', 'graduate', { restartAgent: true });
    new Setting(containerEl)
      .setName('Notes per day')
      .setDesc('How many capture notes the daily pass works on. Each one is a turn of your engine. The /graduate command runs a pass now.')
      .addText(t => t.setPlaceholder('5').setValue(String(s.graduatePerDay)).onChange(async v => {
        const n = Number.parseInt(v, 10);
        if (!Number.isFinite(n) || n < 1 || n > 50) return;
        s.graduatePerDay = n;
        await save({ restartAgent: true });
      }));

    // --- vault layout ---
    new Setting(containerEl).setName('Vault layout').setHeading();
    const layoutText = (name: string, desc: string, key: keyof VaultLayout) =>
      new Setting(containerEl).setName(name).setDesc(desc).addText(t => t.setPlaceholder(DEFAULT_LAYOUT[key]).setValue(s.layout[key]).onChange(async v => {
        s.layout[key] = v.trim().replace(/^\/+|\/+$/g, '');
        await save({ restartAgent: true, engine: true });
      }));
    layoutText('Kanban board', 'Path to your Kanban board note (Obsidian Kanban plugin format).', 'boardPath');
    layoutText('Agent folder', 'Where soul.md, identity.md, user.md, goals.md and memory.md live. Created on first run.', 'agentFolder');
    layoutText('Capture folder', 'Quick capture. New notes start here; the daily pass moves them to the notes folder when they are ready. Empty turns the pass off.', 'captureFolder');
    layoutText('Notes folder', 'Where finished notes go.', 'notesFolder');
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
