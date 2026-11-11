// config/editor.ts — the single validated write path for the six agent config files.
//
// The config files live in the VAULT repo under agent/, not in this code repo.
// Callers pass agentDir = path.join(resolveVaultPath(), 'agent').

import { readFileSync, writeFileSync } from 'fs';
import path from 'path';
import { parseUserMeta } from './loader.js';
import type { ConfigEdit, ConfigFile, EditResult, UserMeta } from './types.js';

export const CONFIG_FILES: readonly ConfigFile[] = [
  'soul.md', 'identity.md', 'user.md', 'goals.md', 'memory.md',
];

/** Files whose edits change how the agent behaves, so they need the user's approval. */
export const GATED_FILES: readonly ConfigFile[] = [
  'soul.md', 'identity.md', 'user.md', 'goals.md',
];

/**
 * Fields in user.md that parseUserMeta regex-parses. Reformatting one silently
 * breaks scheduling or location, and parseUserMeta falls back to defaults rather
 * than throwing, so the damage would surface hours later as a missed pulse. Any
 * edit that moves a field it did not explicitly target is rejected.
 */
const MACHINE_FIELDS: Record<string, (m: UserMeta) => string> = {
  'Coordinates': m => `${m.coordinates.lat},${m.coordinates.lng}`,
  'Active hours': m => `${m.activeHoursStart}-${m.activeHoursEnd}`,
  'Quiet hours': m => `${m.quietHoursStart}-${m.quietHoursEnd}`,
  'Preferred pulse interval': m => String(m.pulseIntervalMinutes),
};

/** Body line range [start, end) of a `## Section`, or null when absent. */
function findSection(lines: string[], section: string): { start: number; end: number } | null {
  const wanted = `## ${section}`.trim().toLowerCase();
  const headerIdx = lines.findIndex(l => l.trim().toLowerCase() === wanted);
  if (headerIdx === -1) return null;

  let end = lines.length;
  for (let i = headerIdx + 1; i < lines.length; i++) {
    if (/^##\s/.test(lines[i])) { end = i; break; }
  }
  return { start: headerIdx + 1, end };
}

/** Index just past the last non-blank line of [start, end), so appends land before trailing blanks. */
function lastContentIndex(lines: string[], start: number, end: number): number {
  let i = end;
  while (i > start && lines[i - 1].trim() === '') i--;
  return i;
}

function fieldRegex(field: string): RegExp {
  const escaped = field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^-\\s*\\*?\\*?${escaped}\\*?\\*?:`, 'i');
}

/** Apply an edit to file content. Pure: no fs, no side effects. */
export function applyEditToContent(content: string, edit: ConfigEdit): EditResult {
  const lines = content.split('\n');
  const range = findSection(lines, edit.section);
  if (!range) {
    return { ok: false, reason: `no section "## ${edit.section}" in ${edit.file}` };
  }
  const { start, end } = range;
  const next = [...lines];

  switch (edit.operation) {
    case 'append_bullet':
      next.splice(lastContentIndex(next, start, end), 0, `- ${edit.content}`);
      break;

    case 'prepend_bullet':
      next.splice(start, 0, `- ${edit.content}`);
      break;

    case 'replace_line': {
      const needle = edit.match.toLowerCase();
      let found = -1;
      for (let i = start; i < end; i++) {
        if (next[i].trim().startsWith('- ') && next[i].toLowerCase().includes(needle)) {
          found = i;
          break;
        }
      }
      if (found === -1) {
        return { ok: false, reason: `no line matching "${edit.match}" in "## ${edit.section}"` };
      }
      next[found] = `- ${edit.content}`;
      break;
    }

    case 'set_field': {
      const re = fieldRegex(edit.field);
      let found = -1;
      for (let i = start; i < end; i++) {
        if (re.test(next[i].trim())) { found = i; break; }
      }
      const line = `- ${edit.field}: ${edit.content}`;
      if (found === -1) {
        next.splice(lastContentIndex(next, start, end), 0, line);
      } else {
        next[found] = line;
      }
      break;
    }

    default: {
      // The ConfigEdit union is exhaustive today, so this is unreachable for
      // well-typed callers -- but callers that parse the operation from an
      // LLM tool call can still hand us a value outside the union at
      // runtime. Cast defensively so we report it instead of silently
      // falling through with `ok: true` and no-op content.
      const bad = edit as { operation: string };
      return { ok: false, reason: `unknown operation: ${bad.operation}` };
    }
  }

  const updated = next.join('\n');

  if (edit.file === 'user.md') {
    const reason = guardUserMeta(content, updated, edit);
    if (reason) return { ok: false, reason };
  }

  return { ok: true, content: updated };
}

/**
 * Reject an edit that changes a machine-read user.md field it did not target.
 * A set_field edit may change the exact field it names.
 */
function guardUserMeta(before: string, after: string, edit: ConfigEdit): string | null {
  const b = parseUserMeta(before);
  const a = parseUserMeta(after);
  const targeted = edit.operation === 'set_field' ? edit.field.toLowerCase() : null;

  for (const [label, read] of Object.entries(MACHINE_FIELDS)) {
    if (label.toLowerCase() === targeted) continue;
    if (read(b) !== read(a)) {
      return `edit would change machine-read field "${label}" ("${read(b)}" -> "${read(a)}")`;
    }
  }
  return null;
}

/** Read, edit, validate, write. The only function that writes a config file. */
export function applyConfigEdit(
  agentDir: string,
  edit: ConfigEdit,
): { ok: true } | { ok: false; reason: string } {
  if (!CONFIG_FILES.includes(edit.file)) {
    return { ok: false, reason: `"${edit.file}" is not an agent config file` };
  }

  let current: string;
  try {
    current = readFileSync(path.join(agentDir, edit.file), 'utf-8');
  } catch {
    return { ok: false, reason: `cannot read ${edit.file}` };
  }

  const result = applyEditToContent(current, edit);
  if (!result.ok) return { ok: false, reason: result.reason };

  writeFileSync(path.join(agentDir, edit.file), result.content, 'utf-8');
  return { ok: true };
}

/** Human-readable one-liner for the permission prompt and the confirmation reply. */
export function describeEdit(edit: ConfigEdit): string {
  switch (edit.operation) {
    case 'append_bullet':
    case 'prepend_bullet':
      return `add "${edit.content}" to "${edit.section}" in ${edit.file}`;
    case 'replace_line':
      return `change the "${edit.match}" line in "${edit.section}" to "${edit.content}" in ${edit.file}`;
    case 'set_field':
      return `set ${edit.field} to "${edit.content}" in ${edit.file}`;
  }
}
