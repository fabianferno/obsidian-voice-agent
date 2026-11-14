// plugin/settings-data.ts - the settings shape, defaults and migration (no Obsidian imports, so tests can load it).

import { ENGINES, type EngineName } from '../engines/index.js';
import { DEFAULT_LAYOUT, type VaultLayout } from '../config/paths.js';
import { DEFAULT_CHECKPOINT_TIMES, type CheckpointTimes } from '../checkins/scheduler.js';

export const STT_CHOICES = ['local', 'sarvam', 'soniox'] as const;
export const TTS_CHOICES = ['system', 'elevenlabs', 'sarvam', 'soniox', 'off'] as const;
export type SttChoice = (typeof STT_CHOICES)[number];
export type TtsChoice = (typeof TTS_CHOICES)[number];

/** Settings holding plain text, edited with the generic text field. */
export type StringSettingKey = {
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
  capture: boolean;
  graduate: boolean;
  graduatePerDay: number;

  stt: SttChoice;
  tts: TtsChoice;
  speakProactive: boolean;
  bargeIn: boolean;
  /** Start listening as soon as the panel opens. */
  listenOnOpen: boolean;
  localSttModel: string;
  /** OS voice name; empty means the system default voice. */
  systemVoice: string;
  /** System voice rate, 1 = normal. */
  speechRate: number;
  /** Names of secrets in Obsidian's secret storage (not the keys themselves). */
  sarvamSecret: string;
  sonioxSecret: string;
  elevenlabsSecret: string;
  elevenlabsVoice: string;
  elevenlabsModel: string;
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
  capture: true,
  graduate: true,
  graduatePerDay: 5,

  stt: 'local',
  tts: 'system',
  speakProactive: true,
  bargeIn: false,
  listenOnOpen: false,
  localSttModel: 'Xenova/whisper-base.en',
  systemVoice: '',
  speechRate: 1,
  sarvamSecret: '',
  sonioxSecret: '',
  elevenlabsSecret: '',
  elevenlabsVoice: 'JBFqnCBsd6RMkjVDRZzb',
  elevenlabsModel: 'eleven_flash_v2_5',
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
  // Settings from 0.1.x: 'local' speech was Kokoro, now the system voice.
  const { localVoice: _voice, localSpeed: _speed, ...s } = (saved ?? {}) as Partial<VoiceAgentSettings> & { localVoice?: unknown; localSpeed?: unknown };
  return {
    ...DEFAULT_SETTINGS,
    ...s,
    engineBin: { ...DEFAULT_SETTINGS.engineBin, ...(s.engineBin ?? {}) },
    layout: { ...DEFAULT_SETTINGS.layout, ...(s.layout ?? {}) },
    checkpointTimes: { ...DEFAULT_SETTINGS.checkpointTimes, ...(s.checkpointTimes ?? {}) },
    engine: ENGINES.includes(s.engine as EngineName) ? (s.engine as EngineName) : DEFAULT_SETTINGS.engine,
    tts: TTS_CHOICES.includes(s.tts as TtsChoice) ? (s.tts as TtsChoice) : DEFAULT_SETTINGS.tts,
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
