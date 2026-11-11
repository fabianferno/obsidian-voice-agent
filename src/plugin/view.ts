// plugin/view.ts - the side panel: transcript, mic button, text box.

import { ItemView, setIcon, type WorkspaceLeaf } from 'obsidian';
import type VoiceAgentPlugin from './main.js';
import { describeSource, type Entry } from './transcript.js';
import type { VoiceState } from '../voice/session.js';

export const VIEW_TYPE = 'voice-agent-panel';

const STATE_LABEL: Record<VoiceState, string> = {
  idle: 'Ready',
  listening: 'Listening',
  hearing: 'Hearing you',
  transcribing: 'Transcribing',
  thinking: 'Thinking',
  speaking: 'Speaking',
};

export class VoiceAgentView extends ItemView {
  private listEl!: HTMLElement;
  private stateEl!: HTMLElement;
  private micBtn!: HTMLButtonElement;
  private stopBtn!: HTMLButtonElement;
  private input!: HTMLTextAreaElement;
  private noticeEl!: HTMLElement;
  private rendered = new Map<number, HTMLElement>();
  private unsubscribe?: () => void;

  constructor(leaf: WorkspaceLeaf, private readonly plugin: VoiceAgentPlugin) {
    super(leaf);
  }

  getViewType(): string {
    return VIEW_TYPE;
  }

  getDisplayText(): string {
    return this.plugin.settings.agentName || 'Voice agent';
  }

  getIcon(): string {
    return 'audio-lines';
  }

  async onOpen(): Promise<void> {
    const root = this.contentEl;
    root.empty();
    root.addClass('va-root');

    const header = root.createDiv('va-header');
    header.createDiv({ cls: 'va-title', text: this.getDisplayText() });
    this.stateEl = header.createDiv('va-state');
    const menu = header.createEl('button', { cls: 'clickable-icon va-icon-btn', attr: { 'aria-label': 'New conversation' } });
    setIcon(menu, 'rotate-ccw');
    menu.onclick = () => void this.plugin.newConversation();

    this.noticeEl = root.createDiv('va-notice');
    this.listEl = root.createDiv('va-list');

    const footer = root.createDiv('va-footer');
    this.micBtn = footer.createEl('button', { cls: 'va-mic', attr: { 'aria-label': 'Talk (toggle listening)' } });
    this.micBtn.onclick = () => void this.plugin.toggleListening();
    this.stopBtn = footer.createEl('button', { cls: 'clickable-icon va-icon-btn va-stop', attr: { 'aria-label': 'Stop' } });
    setIcon(this.stopBtn, 'square');
    this.stopBtn.onclick = () => this.plugin.interrupt();
    this.input = footer.createEl('textarea', { cls: 'va-input', attr: { rows: '1', placeholder: 'Type, or press the mic and talk' } });
    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        const text = this.input.value;
        this.input.value = '';
        void this.plugin.sendText(text);
      }
    });

    this.unsubscribe = this.plugin.transcript.subscribe((changed) => this.render(changed));
    this.render();
    if (this.plugin.settings.listenOnOpen && !this.plugin.isListening) void this.plugin.toggleListening();
  }

  async onClose(): Promise<void> {
    this.unsubscribe?.();
    this.rendered.clear();
  }

  setNotice(text: string): void {
    if (!this.noticeEl) return;
    this.noticeEl.setText(text);
    this.noticeEl.toggleClass('is-visible', !!text);
  }

  private render(changed?: Entry): void {
    const t = this.plugin.transcript;
    const state = t.voiceState;
    this.stateEl.setText(STATE_LABEL[state]);
    this.stateEl.dataset.state = state;
    const listening = this.plugin.isListening;
    this.micBtn.empty();
    setIcon(this.micBtn, listening ? 'mic' : 'mic-off');
    this.micBtn.toggleClass('is-on', listening);
    this.micBtn.dataset.state = state;
    this.stopBtn.toggleClass('is-visible', state === 'thinking' || state === 'speaking' || state === 'transcribing');

    if (changed && this.rendered.has(changed.id)) {
      this.fill(this.rendered.get(changed.id)!, changed);
    } else {
      // Structural change: sync the list.
      const ids = new Set(t.entries.map(e => e.id));
      for (const [id, el] of this.rendered) {
        if (!ids.has(id)) {
          el.remove();
          this.rendered.delete(id);
        }
      }
      for (const e of t.entries) {
        let el = this.rendered.get(e.id);
        if (!el) {
          el = this.listEl.createDiv();
          this.rendered.set(e.id, el);
        }
        this.fill(el, e);
      }
      if (t.entries.length === 0) this.renderEmpty();
      else this.listEl.querySelector('.va-empty')?.remove();
    }
    this.listEl.scrollTop = this.listEl.scrollHeight;
  }

  private renderEmpty(): void {
    if (this.listEl.querySelector('.va-empty')) return;
    const empty = this.listEl.createDiv('va-empty');
    empty.createDiv({ text: 'Press the mic and talk, or type below.' });
    empty.createDiv({ cls: 'va-empty-hint', text: 'Try: "What should I work on?", "Add call the bank to To Do", "Summarize my notes on the garden project".' });
  }

  private fill(el: HTMLElement, e: Entry): void {
    el.className = `va-msg va-${e.role}${e.source ? ' va-proactive' : ''}${e.done ? '' : ' is-live'}`;
    el.empty();
    const label = describeSource(e.source);
    if (label) el.createDiv({ cls: 'va-label', text: label });
    if (e.text) el.createDiv({ cls: 'va-text', text: e.text });
    if (!e.done && !e.text) el.createDiv({ cls: 'va-typing', text: e.status ?? 'Thinking...' });
    else if (!e.done && e.status) el.createDiv({ cls: 'va-status', text: e.status });
    if (e.error) el.createDiv({ cls: 'va-error-text', text: e.error });
    if (e.interrupted) el.createDiv({ cls: 'va-status', text: 'Stopped' });
  }
}
