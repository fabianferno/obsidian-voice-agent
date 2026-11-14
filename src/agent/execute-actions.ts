// agent/execute-actions.ts - runs the actions an engine asked for.
//
// Every write goes through the tested writers so the board and config files
// keep their format. Returns one result line per action that has something to
// report: `ok: false` when it did not do what was asked (card not found, edit
// rejected), `ok: true` for results worth saying when the engine said nothing.

import type { PendingConfigEdit, VaultAction } from '../config/types.js';
import type { Store } from '../store/store.js';
import { mutateKanban, appendMemoryEntry, updateCardDeadlineByTitle } from '../vault/writer.js';
import { handlePersonMention } from '../journal/people.js';
import { handleLiteratureMention } from '../journal/literature.js';
import { captureToNote } from '../journal/capture.js';
import { applyConfigEdit, describeEdit, GATED_FILES } from '../config/editor.js';
import path from 'path';
import { agentDir, getLayout } from '../config/paths.js';
import type { NoteChange } from './changes.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('actions');

export const PENDING_EDIT_KEY = 'pending_config_edit';
const PENDING_EDIT_TTL_MS = 30 * 60 * 1000;

/**
 * The config edit proposed but not yet answered. It expires, so a proposal
 * ignored yesterday cannot be applied by an unrelated "yes" today.
 */
export async function getPendingConfigEdit(store: Store, now = Date.now()): Promise<PendingConfigEdit | null> {
  const raw = await store.getSessionState(PENDING_EDIT_KEY);
  if (!raw) return null;
  try {
    const pending = JSON.parse(raw) as PendingConfigEdit;
    if (now - new Date(pending.proposedAt).getTime() > PENDING_EDIT_TTL_MS) {
      await store.setSessionState(PENDING_EDIT_KEY, '');
      return null;
    }
    return pending;
  } catch {
    return null;
  }
}

export interface ActionResult {
  text: string;
  ok: boolean;
}

export async function executeVaultActions(
  vaultPath: string,
  store: Store,
  actions: VaultAction[],
  onChange: (change: NoteChange) => void = () => undefined,
): Promise<ActionResult[]> {
  const results: ActionResult[] = [];
  const fail = (text: string) => results.push({ text, ok: false });
  const done = (text: string) => results.push({ text, ok: true });
  const rel = (file: string) => path.relative(vaultPath, file).split(path.sep).join('/');
  const board = () => onChange({ kind: 'updated', path: getLayout().boardPath });
  const captured = (r: { action: 'appended' | 'created'; filePath: string }) =>
    onChange({ kind: r.action === 'created' ? 'created' : 'updated', path: rel(r.filePath) });

  for (const action of actions) {
    try {
      switch (action.type) {
        case 'move_task': {
          const changed = mutateKanban(vaultPath, [{ type: 'move', task: action.task, fromColumn: action.from, toColumn: action.to }]);
          if (!changed) fail(`I couldn't find "${action.task}" on the board, so nothing moved.`);
          else board();
          break;
        }
        case 'complete_task': {
          const changed = mutateKanban(vaultPath, [{ type: 'move', task: action.task, fromColumn: action.from, toColumn: 'Done' }]);
          if (!changed) fail(`I couldn't find "${action.task}" on the board, so nothing was marked done.`);
          else board();
          break;
        }
        case 'add_task':
          if (mutateKanban(vaultPath, [{ type: 'add', task: action.text, toColumn: action.column }])) board();
          break;
        case 'reschedule_task': {
          const moved = updateCardDeadlineByTitle(vaultPath, action.task, action.newDate);
          if (moved) {
            done(`Moved "${action.task}" to ${action.newDate}.`);
            board();
          }
          else fail(`I couldn't find "${action.task}" on the board, so nothing moved.`);
          break;
        }
        case 'note': {
          const res = captureToNote(vaultPath, { title: action.title, noteType: action.noteType, text: action.text });
          logger.info(`Captured to ${res.filePath} (${res.action})`);
          captured(res);
          break;
        }
        case 'people_note':
          captured(handlePersonMention(action.name, action.note, vaultPath));
          break;
        case 'literature_note':
          captured(handleLiteratureMention(action.title, action.noteType, action.source, action.note, vaultPath));
          break;
        case 'update_memory':
          appendMemoryEntry(vaultPath, action.observation);
          onChange({ kind: 'updated', path: `${getLayout().agentFolder}/memory.md` });
          break;
        case 'propose_config_edit': {
          // Writes nothing: stash it. The next turn's context carries the
          // proposal so the engine can read the user's yes or no.
          if (!GATED_FILES.includes(action.file)) {
            logger.warn(`propose_config_edit rejected for ungated file ${action.file}`);
            break;
          }
          const pending: PendingConfigEdit = {
            edit: {
              file: action.file,
              section: action.section,
              operation: action.operation,
              content: action.content,
              ...(action.match ? { match: action.match } : {}),
              ...(action.field ? { field: action.field } : {}),
            } as PendingConfigEdit['edit'],
            rationale: action.rationale,
            proposedAt: new Date().toISOString(),
          };
          await store.setSessionState(PENDING_EDIT_KEY, JSON.stringify(pending));
          logger.info(`Config edit proposed: ${describeEdit(pending.edit)}`);
          break;
        }
        case 'apply_config_edit': {
          const pending = await getPendingConfigEdit(store);
          if (!pending) {
            fail("There's no pending change to apply any more, so nothing changed.");
            break;
          }
          const result = applyConfigEdit(agentDir(vaultPath), pending.edit);
          await store.setSessionState(PENDING_EDIT_KEY, '');
          if (result.ok) {
            done(`Done. ${pending.edit.file} updated.`);
            onChange({ kind: 'updated', path: `${getLayout().agentFolder}/${pending.edit.file}` });
          }
          else fail(`I couldn't make that change: ${result.reason}`);
          break;
        }
        case 'discard_config_edit':
          await store.setSessionState(PENDING_EDIT_KEY, '');
          break;
      }
    } catch (err) {
      logger.error(`Action ${action.type} failed`, err);
      fail(`Something went wrong with ${action.type.replace(/_/g, ' ')}.`);
    }
  }
  return results;
}
