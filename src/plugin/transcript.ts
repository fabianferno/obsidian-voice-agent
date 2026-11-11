// plugin/transcript.ts - the conversation shown in the panel.
//
// Lives in the plugin (not the view) so briefings that arrive while the panel
// is closed are still there when it opens, and implements VoiceUi so the voice
// session can write to it directly.

import type { AgentMessageHandle, VoiceState, VoiceUi } from '../voice/session.js';

export interface Entry {
  id: number;
  role: 'user' | 'agent' | 'error';
  text: string;
  at: number;
  spoken?: boolean;
  /** For proactive agent messages: what produced it. */
  source?: string;
  /** What the engine is doing right now (while the reply is in progress). */
  status?: string;
  done?: boolean;
  error?: string;
  interrupted?: boolean;
}

const MAX = 150;

export function describeSource(source?: string): string {
  if (!source) return '';
  if (source.startsWith('checkpoint:')) {
    const k = source.split(':')[1];
    return k === 'morning' ? 'Morning briefing' : k === 'midday' ? 'Midday check' : k === 'evening' ? 'Evening wind-down' : 'Check-in';
  }
  switch (source) {
    case 'startup-briefing': return 'Hello';
    case 'pulse': return 'Nudge';
    case 'synapse-scan': return 'Triage';
    case 'focus-nudge': case 'task-start': case 'idle-pulse': return 'Focus';
    case 'wip-guard': return 'WIP limit';
    case 'stuck-task': return 'Stuck card';
    default: return '';
  }
}

export class Transcript implements VoiceUi {
  entries: Entry[] = [];
  voiceState: VoiceState = 'idle';
  private seq = 0;
  private listeners = new Set<(changed?: Entry) => void>();
  /** Called for each proactive message (the plugin shows a Notice when the panel is closed). */
  onProactive?: (text: string, source?: string) => void;

  subscribe(cb: (changed?: Entry) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private emit(changed?: Entry): void {
    for (const cb of this.listeners) cb(changed);
  }

  private add(e: Omit<Entry, 'id' | 'at'>): Entry {
    const entry: Entry = { ...e, id: ++this.seq, at: Date.now() };
    this.entries.push(entry);
    if (this.entries.length > MAX) this.entries.splice(0, this.entries.length - MAX);
    this.emit();
    return entry;
  }

  clear(): void {
    this.entries = [];
    this.emit();
  }

  // --- VoiceUi ---

  state(s: VoiceState): void {
    this.voiceState = s;
    this.emit();
  }

  user(text: string, spoken: boolean): void {
    this.add({ role: 'user', text, spoken, done: true });
  }

  agentStart(kind: 'reply' | 'proactive', source?: string): AgentMessageHandle {
    const entry = this.add({ role: 'agent', text: '', source: kind === 'proactive' ? source : undefined });
    return {
      append: (t) => {
        entry.text += t;
        entry.status = undefined;
        this.emit(entry);
      },
      status: (t) => {
        entry.status = t;
        this.emit(entry);
      },
      end: (o) => {
        entry.done = true;
        entry.status = undefined;
        entry.error = o?.error;
        entry.interrupted = o?.interrupted;
        entry.text = entry.text.trim();
        this.emit(entry);
        if (kind === 'proactive') this.onProactive?.(entry.text, source);
      },
    };
  }

  error(message: string): void {
    this.add({ role: 'error', text: message, done: true });
  }
}
