// config/paths.ts - where things live inside the vault.
//
// The plugin sets the vault root and the layout from its settings at load time.
// Defaults match the original vault this agent was built for; other people set
// their own board path and folders in the plugin settings.

import path from 'path';

export interface VaultLayout {
  /** Kanban board file, relative to the vault root. */
  boardPath: string;
  /** Folder holding soul.md, identity.md, user.md, goals.md, memory.md. */
  agentFolder: string;
  /** Quick-capture folder whose notes get a 48h triage nudge. Empty disables it. */
  captureFolder: string;
  /** Folder where people and literature notes are written. */
  notesFolder: string;
  /** Daily notes folder. The agent never reads or writes it. */
  dailyFolder: string;
}

export const DEFAULT_LAYOUT: VaultLayout = {
  boardPath: 'Kanban.md',
  agentFolder: 'agent',
  captureFolder: 'Inbox',
  notesFolder: 'Notes',
  dailyFolder: 'Daily',
};

let vaultRoot = '';
let layout: VaultLayout = { ...DEFAULT_LAYOUT };

export function setVaultPath(p: string): void {
  vaultRoot = p;
}

export function resolveVaultPath(): string {
  if (!vaultRoot) throw new Error('Vault path not set');
  return vaultRoot;
}

export function setLayout(next: Partial<VaultLayout>): void {
  const clean = Object.fromEntries(
    Object.entries(next).filter(([, v]) => typeof v === 'string'),
  ) as Partial<VaultLayout>;
  layout = { ...DEFAULT_LAYOUT, ...clean };
}

export function getLayout(): VaultLayout {
  return layout;
}

export function boardFile(vaultPath: string): string {
  return path.join(vaultPath, layout.boardPath);
}

export function agentDir(vaultPath: string): string {
  return path.join(vaultPath, layout.agentFolder);
}

export function notesDir(vaultPath: string): string {
  return path.join(vaultPath, layout.notesFolder);
}

export function captureDir(vaultPath: string): string | null {
  return layout.captureFolder ? path.join(vaultPath, layout.captureFolder) : null;
}
