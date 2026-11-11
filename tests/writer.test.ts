import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { mutateKanban, ensureCardIds, updateCardDeadlineById, updateCardDeadlineByTitle, deleteCardById, autoMoveCompletedToDone, clearColumns, countColumnCards } from '../src/vault/writer.js';
import { parseInboxKanban } from '../src/vault/parser.js';

function inboxPath(vaultPath: string) {
  return join(vaultPath, 'Kanban.md');
}

function makeVault(boardBody: string): string {
  const dir = join(tmpdir(), `test-vault-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(inboxPath(dir), boardBody, 'utf-8');
  return dir;
}

describe('card ids', () => {
  it('ensureCardIds appends ^id to lines without one and is idempotent', () => {
    const vault = makeVault(['## Doing', '- [ ] Task A', '- [ ] Task B ^keep01'].join('\n'));
    const minted = ensureCardIds(vault);
    expect(minted.length).toBe(1);

    const board = parseInboxKanban(readFileSync(inboxPath(vault), 'utf-8'));
    const doing = board.columns['Doing'];
    expect(doing[0].id).toMatch(/^[a-z0-9]{6}$/);
    expect(doing[1].id).toBe('keep01');

    expect(ensureCardIds(vault).length).toBe(0);
  });

  it('mutateKanban add mints an id for the new card', () => {
    const vault = makeVault(['## Backlog', '', '## Doing', '', '## Done', ''].join('\n'));
    mutateKanban(vault, [{ type: 'add', task: 'Fresh task', toColumn: 'Backlog' }]);
    const board = parseInboxKanban(readFileSync(inboxPath(vault), 'utf-8'));
    expect(board.columns['Backlog'][0].text).toBe('Fresh task');
    expect(board.columns['Backlog'][0].id).toMatch(/^[a-z0-9]{6}$/);
  });

  it('mutateKanban move matches a card by plain title when the card carries a due date', () => {
    // A card with an Obsidian Kanban date annotation must still be movable by
    // its human title. Voice/text callers say "move Meet with mountroof to
    // Done", never "... @{2026-07-16}". Regression: the due-date stamp made the
    // title unmatchable so the move silently no-op'd.
    const vault = makeVault([
      '## To Do', '- [ ] Meet with mountroof @{2026-07-16} ^f009ad', '', '## Done', '',
    ].join('\n'));
    mutateKanban(vault, [{ type: 'move', task: 'Meet with mountroof', fromColumn: 'To Do', toColumn: 'Done' }]);
    const board = parseInboxKanban(readFileSync(inboxPath(vault), 'utf-8'));
    expect(board.columns['To Do'].some(t => t.text.includes('Meet with mountroof'))).toBe(false);
    expect(board.columns['Done'].some(t => t.text.includes('Meet with mountroof'))).toBe(true);
  });

  it('updateCardDeadlineById rewrites @{date} for the matching id only', () => {
    const vault = makeVault(['## To Do', '- [ ] A @{2026-07-20} ^aaa111', '- [ ] B @{2026-07-20} ^bbb222'].join('\n'));
    updateCardDeadlineById(vault, 'aaa111', '2026-07-25', null);
    const md = readFileSync(inboxPath(vault), 'utf-8');
    expect(md).toContain('A @{2026-07-25} ^aaa111');
    expect(md).toContain('B @{2026-07-20} ^bbb222');
  });

  it('updateCardDeadlineById adds a deadline to a card that had none', () => {
    const vault = makeVault(['## To Do', '- [ ] A ^aaa111'].join('\n'));
    updateCardDeadlineById(vault, 'aaa111', '2026-07-25', '09:00');
    const md = readFileSync(inboxPath(vault), 'utf-8');
    expect(md).toContain('A @{2026-07-25} @@{09:00} ^aaa111');
  });

  it('updateCardDeadlineByTitle rewrites the @{date} of the card matching a title', () => {
    // The exact incident: a reschedule must move the board card, not just the calendar.
    const vault = makeVault(['## To Do', '- [ ] Collect cash from Syed Bawkher @{2026-07-13} ^895836'].join('\n'));
    const moved = updateCardDeadlineByTitle(vault, 'Collect cash from Syed Bawkher', '2026-07-16');
    expect(moved).toBe(true);
    const md = readFileSync(inboxPath(vault), 'utf-8');
    expect(md).toContain('Collect cash from Syed Bawkher @{2026-07-16} ^895836');
    expect(md).not.toContain('2026-07-13');
  });

  it('updateCardDeadlineByTitle prefers a same-titled card that already has a date over a dateless twin', () => {
    const vault = makeVault([
      '## To Do',
      '- [ ] Collect cash from Syed Bawkher @{2026-07-13} ^895836',
      '- [ ] Collect cash from Syed Bawkher ^a03f30',
    ].join('\n'));
    updateCardDeadlineByTitle(vault, 'Collect cash from Syed Bawkher', '2026-07-16');
    const md = readFileSync(inboxPath(vault), 'utf-8');
    // The dated twin moves; the dateless one is left untouched (no phantom date stamped).
    expect(md).toContain('Collect cash from Syed Bawkher @{2026-07-16} ^895836');
    expect(md).toContain('- [ ] Collect cash from Syed Bawkher ^a03f30');
  });

  it('updateCardDeadlineByTitle adds a date to a card that had none when no dated twin exists', () => {
    const vault = makeVault(['## To Do', '- [ ] Ship the invoice ^abc123'].join('\n'));
    const moved = updateCardDeadlineByTitle(vault, 'Ship the invoice', '2026-07-16');
    expect(moved).toBe(true);
    const md = readFileSync(inboxPath(vault), 'utf-8');
    expect(md).toContain('Ship the invoice @{2026-07-16} ^abc123');
  });

  it('updateCardDeadlineByTitle returns false when no card matches (caller must not claim a move)', () => {
    const vault = makeVault(['## To Do', '- [ ] Something else ^zzz999'].join('\n'));
    const moved = updateCardDeadlineByTitle(vault, 'Collect cash from Syed Bawkher', '2026-07-16');
    expect(moved).toBe(false);
    expect(readFileSync(inboxPath(vault), 'utf-8')).not.toContain('2026-07-16');
  });

  it('deleteCardById removes only the matching line', () => {
    const vault = makeVault(['## To Do', '- [ ] A ^aaa111', '- [ ] B ^bbb222'].join('\n'));
    deleteCardById(vault, 'aaa111');
    const md = readFileSync(inboxPath(vault), 'utf-8');
    expect(md).not.toContain('^aaa111');
    expect(md).toContain('B ^bbb222');
  });
});

describe('mutateKanban', () => {
  let vaultPath: string;

  beforeEach(() => {
    vaultPath = join(tmpdir(), `test-vault-${Date.now()}`);
    mkdirSync(vaultPath, { recursive: true });
    writeFileSync(inboxPath(vaultPath), [
      '## To Do',
      '- [ ] Other task',
      '',
      '## Doing',
      '- [ ] Build landing page @{2026-03-26}',
      '',
      '## Done',
      '',
    ].join('\n'));
  });

  it('does not add the same task twice to a column', () => {
    mutateKanban(vaultPath, [
      { type: 'add', task: 'Rework DrawFi front end for demo', toColumn: 'Doing' },
      { type: 'add', task: 'Rework DrawFi front end for demo', toColumn: 'Doing' },
    ]);
    const content = readFileSync(inboxPath(vaultPath), 'utf-8');
    const matches = content.match(/- \[ \] Rework DrawFi front end for demo/g);
    expect(matches?.length).toBe(1);
  });

  it('moves the task even when the model supplies the wrong `from` column', () => {
    // "Meet Lokesh" is really in To Do; the model claims it is in Doing.
    writeFileSync(inboxPath(vaultPath), [
      '## To Do',
      '- [ ] Meet Lokesh ^73d2de',
      '',
      '## Doing',
      '',
      '## Backlog',
      '',
    ].join('\n'));

    const changed = mutateKanban(vaultPath, [
      { type: 'move', task: 'Meet Lokesh', fromColumn: 'Doing', toColumn: 'Backlog' },
    ]);

    expect(changed).toBe(true);
    const content = readFileSync(inboxPath(vaultPath), 'utf-8');
    // Gone from To Do, present in Backlog, not duplicated.
    expect(content.match(/Meet Lokesh/g)?.length).toBe(1);
    expect(content).toMatch(/## Backlog[\s\S]*Meet Lokesh/);
  });

  it('returns false when the task is nowhere on the board (no phantom write)', () => {
    const changed = mutateKanban(vaultPath, [
      { type: 'move', task: 'Task that does not exist', fromColumn: 'To Do', toColumn: 'Done' },
    ]);
    expect(changed).toBe(false);
  });

  it('completes a task by moving it to Done regardless of claimed source', () => {
    writeFileSync(inboxPath(vaultPath), [
      '## To Do',
      '- [ ] Submit Finvoice ^c6c206',
      '',
      '## Done',
      '',
    ].join('\n'));

    const changed = mutateKanban(vaultPath, [
      { type: 'move', task: 'Submit Finvoice', fromColumn: 'To Do', toColumn: 'Done' },
    ]);
    expect(changed).toBe(true);
    const content = readFileSync(inboxPath(vaultPath), 'utf-8');
    expect(content).toMatch(/## Done[\s\S]*Submit Finvoice/);
  });

  it('moves a task whose raw line contains wikilink brackets when given the cleaned text', () => {
    writeFileSync(inboxPath(vaultPath), [
      '## Backlog',
      '',
      '## Doing',
      '- [ ] Create plans for [[Stateless]]',
      '',
      '## Done',
      '',
    ].join('\n'));

    mutateKanban(vaultPath, [
      { type: 'move', task: 'Create plans for Stateless', fromColumn: 'Doing', toColumn: 'Backlog' },
    ]);

    const content = readFileSync(inboxPath(vaultPath), 'utf-8');
    expect(content).not.toMatch(/## Doing[\s\S]*Stateless[\s\S]*## Done/);
    expect(content).toMatch(/## Backlog[\s\S]*Stateless/);
  });
});

describe('autoMoveCompletedToDone', () => {
  it('moves a checked card out of To Do into Done, keeping its id and annotations verbatim', () => {
    const vault = makeVault([
      '## To Do',
      '- [x] Submit Stablecoin hackathon @{2026-07-10} ^abc123',
      '- [ ] Call Sham ^def456',
      '',
      '## Done',
      '- [x] Old done thing ^old001',
      '',
      '## Archive',
      '',
    ].join('\n'));

    const moved = autoMoveCompletedToDone(vault);
    expect(moved).toEqual(['Submit Stablecoin hackathon @{2026-07-10}']);

    const board = parseInboxKanban(readFileSync(inboxPath(vault), 'utf-8'));
    expect(board.columns['To Do'].map(t => t.text)).toEqual(['Call Sham']);
    const done = board.columns['Done'];
    expect(done.map(t => t.text)).toEqual(['Old done thing', 'Submit Stablecoin hackathon']);
    // Id and date survive the move (not re-minted).
    const submitted = done.find(t => t.text === 'Submit Stablecoin hackathon')!;
    expect(submitted.id).toBe('abc123');
    expect(submitted.dueDate).toBe('2026-07-10');
  });

  it('lifts completed cards from every non-terminal column, leaving Done/Archive untouched', () => {
    const vault = makeVault([
      '## Backlog',
      '- [x] Backlog done ^b1',
      '## To Do',
      '- [x] Todo done ^t1',
      '- [ ] Todo open ^t2',
      '## Doing',
      '- [x] Doing done ^d1',
      '## Done',
      '',
      '## Archive',
      '- [x] Already archived ^a1',
    ].join('\n'));

    const moved = autoMoveCompletedToDone(vault);
    expect(moved.sort()).toEqual(['Backlog done', 'Doing done', 'Todo done']);

    const board = parseInboxKanban(readFileSync(inboxPath(vault), 'utf-8'));
    expect(board.columns['Backlog']).toEqual([]);
    expect(board.columns['To Do'].map(t => t.text)).toEqual(['Todo open']);
    expect(board.columns['Doing']).toEqual([]);
    expect(board.columns['Done'].map(t => t.text).sort()).toEqual(['Backlog done', 'Doing done', 'Todo done']);
    // Archive's own completed card stays put.
    expect(board.columns['Archive'].map(t => t.text)).toEqual(['Already archived']);
  });

  it('is a no-op when nothing is checked outside terminal columns', () => {
    const body = [
      '## To Do',
      '- [ ] Open task ^o1',
      '## Done',
      '- [x] Done task ^x1',
      '## Archive',
      '',
    ].join('\n');
    const vault = makeVault(body);
    const moved = autoMoveCompletedToDone(vault);
    expect(moved).toEqual([]);
    expect(readFileSync(inboxPath(vault), 'utf-8')).toBe(body);
  });

  it('flushes to the end of Done when Done is the last column', () => {
    const vault = makeVault([
      '## To Do',
      '- [x] Finished ^f1',
      '## Done',
      '- [ ] Existing ^e1',
    ].join('\n'));
    autoMoveCompletedToDone(vault);
    const board = parseInboxKanban(readFileSync(inboxPath(vault), 'utf-8'));
    expect(board.columns['Done'].map(t => t.text)).toEqual(['Existing', 'Finished']);
    expect(board.columns['To Do']).toEqual([]);
  });
});

describe('clearColumns / countColumnCards', () => {
  const board = [
    '## To Do',
    '- [ ] Keep me ^k1',
    '',
    '## Done',
    '- [x] Done one ^d1',
    '- [x] Done two @{2026-07-10} ^d2',
    '',
    '## Archive',
    '- [x] Archived one ^a1',
    '- [ ] Archived open ^a2',
  ].join('\n');

  it('countColumnCards counts cards in the named columns only', () => {
    const vault = makeVault(board);
    expect(countColumnCards(vault, ['Done', 'Archive'])).toBe(4);
    expect(countColumnCards(vault, ['Done'])).toBe(2);
    expect(countColumnCards(vault, ['To Do'])).toBe(1);
  });

  it('clearColumns deletes every card under the named columns, keeping headers and other columns', () => {
    const vault = makeVault(board);
    const removed = clearColumns(vault, ['Done', 'Archive']);
    expect(removed).toBe(4);

    const parsed = parseInboxKanban(readFileSync(inboxPath(vault), 'utf-8'));
    expect(parsed.columns['To Do'].map(t => t.text)).toEqual(['Keep me']);
    expect(parsed.columns['Done']).toEqual([]);
    expect(parsed.columns['Archive']).toEqual([]);

    // Headers survive so the board structure stays intact.
    const md = readFileSync(inboxPath(vault), 'utf-8');
    expect(md).toContain('## Done');
    expect(md).toContain('## Archive');
    expect(md).not.toContain('^d1');
    expect(md).not.toContain('^a2');
  });

  it('clearColumns is a no-op returning 0 when the columns are already empty', () => {
    const body = ['## To Do', '- [ ] Keep me ^k1', '', '## Done', '', '## Archive', ''].join('\n');
    const vault = makeVault(body);
    expect(clearColumns(vault, ['Done', 'Archive'])).toBe(0);
    expect(readFileSync(inboxPath(vault), 'utf-8')).toBe(body);
  });
});
