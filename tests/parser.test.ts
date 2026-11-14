import { describe, it, expect } from 'vitest';
import { parseInboxKanban, parseFrontmatter } from '../src/vault/parser.js';
import { parseAgentReply, describeActions, isValidAction, ActionStreamFilter } from '../src/brain/actions.js';

describe('parseInboxKanban', () => {
  const sampleKanban = `---
kanban-plugin: board
---

## Backlog

- [ ] Research ZK proofs
- [ ] Write blog about AI agents

## To Do

- [ ] Fix Cortana model provider @{2026-03-27}
- [ ] Call Silas [[Silas]]

## Doing

- [ ] PL Genesis hackathon @{2026-03-30} @@{18:00}
- [ ] Ship Acme v2 https://acme.example

## Done

- [x] Deploy edge pipeline

## Archive

- [x] Old completed task

%% kanban:settings
{"kanban-plugin":"board","list-collapse":[false,false,false,false,true]}
%%`;

  it('extracts all columns', () => {
    const board = parseInboxKanban(sampleKanban);
    expect(board.columnOrder).toEqual(['Backlog', 'To Do', 'Doing', 'Done', 'Archive']);
  });

  it('parses task text', () => {
    const board = parseInboxKanban(sampleKanban);
    expect(board.columns['Backlog']).toHaveLength(2);
    expect(board.columns['Backlog'][0].text).toBe('Research ZK proofs');
  });

  it('parses due dates', () => {
    const board = parseInboxKanban(sampleKanban);
    const task = board.columns['To Do'][0];
    expect(task.dueDate).toBe('2026-03-27');
  });

  it('parses due dates with times', () => {
    const board = parseInboxKanban(sampleKanban);
    const task = board.columns['Doing'][0];
    expect(task.dueDate).toBe('2026-03-30');
    expect(task.dueTime).toBe('18:00');
  });

  it('extracts trailing block-ref id into Task.id and strips it from text', () => {
    const md = [
      '## Doing',
      '- [ ] Ship calendar sync @{2026-07-20} @@{15:00} ^a1b2c3',
      '- [ ] No id task',
    ].join('\n');
    const board = parseInboxKanban(md);
    const [withId, withoutId] = board.columns['Doing'];
    expect(withId.id).toBe('a1b2c3');
    expect(withId.text).toBe('Ship calendar sync');
    expect(withId.dueDate).toBe('2026-07-20');
    expect(withId.dueTime).toBe('15:00');
    expect(withoutId.id).toBeUndefined();
    expect(withoutId.text).toBe('No id task');
  });

  it('parses wikilinks', () => {
    const board = parseInboxKanban(sampleKanban);
    const task = board.columns['To Do'][1];
    expect(task.wikilinks).toContain('Silas');
  });

  it('parses URLs', () => {
    const board = parseInboxKanban(sampleKanban);
    const task = board.columns['Doing'][1];
    expect(task.urls).toContain('https://acme.example');
  });

  it('parses completed status', () => {
    const board = parseInboxKanban(sampleKanban);
    expect(board.columns['Done'][0].completed).toBe(true);
    expect(board.columns['To Do'][0].completed).toBe(false);
  });

  it('ignores kanban settings block', () => {
    const board = parseInboxKanban(sampleKanban);
    expect(board.columnOrder).not.toContain('kanban:settings');
  });

  it('ignores frontmatter', () => {
    const board = parseInboxKanban(sampleKanban);
    // Should not have any column called "kanban-plugin"
    expect(board.columns['kanban-plugin']).toBeUndefined();
  });

  it('stores rawLine for each task', () => {
    const md = `## Doing\n- [ ] Build landing page @{2026-03-26}\n`;
    const board = parseInboxKanban(md);
    const task = board.columns['Doing'][0];
    expect(task.rawLine).toBe('Build landing page @{2026-03-26}');
  });

  it('extracts pausedNote from task text', () => {
    const md = `## Doing\n- [ ] Build landing page @{2026-03-26} — paused: header done, need CTA\n`;
    const board = parseInboxKanban(md);
    const task = board.columns['Doing'][0];
    expect(task.pausedNote).toBe('header done, need CTA');
    expect(task.text).not.toContain('paused');
    expect(task.text).not.toContain('—');
    expect(task.rawLine).toContain('paused');
  });

  it('returns undefined pausedNote when not present', () => {
    const md = `## Doing\n- [ ] Normal task @{2026-03-26}\n`;
    const board = parseInboxKanban(md);
    expect(board.columns['Doing'][0].pausedNote).toBeUndefined();
  });

  it('keeps the card id out of the pause note', () => {
    // The pause note is written before the trailing id, so the note must not run
    // to end of line and swallow it -- an id-less card breaks every id lookup.
    const md = `## Doing\n- [ ] Build landing page — paused: need CTA ^ab12cd\n`;
    const task = parseInboxKanban(md).columns['Doing'][0];
    expect(task.id).toBe('ab12cd');
    expect(task.pausedNote).toBe('need CTA');
  });
});

describe('parseFrontmatter', () => {
  it('extracts tags array', () => {
    const content = `---\ntags: [people, friend]\n---\n\n# Person`;
    const fm = parseFrontmatter(content);
    expect(fm.tags).toEqual(['people', 'friend']);
  });

  it('returns empty for no frontmatter', () => {
    const fm = parseFrontmatter('# Just a heading');
    expect(fm.tags).toEqual([]);
  });

  it('reads YAML block lists and aliases', () => {
    const content = `---\ntags:\n  - people\n  - "on/art"\naliases:\n  - Caleb\nlocation:\n  - chennai\n---\n# Caleb`;
    const fm = parseFrontmatter(content);
    expect(fm.tags).toEqual(['people', 'on/art']);
    expect(fm.aliases).toEqual(['Caleb']);
  });

  it('reads a comma list and an empty key', () => {
    expect(parseFrontmatter(`---\ntags: people, #friend\naliases:\n---\n`)).toMatchObject({ tags: ['people', 'friend'], aliases: [] });
  });
});

describe('isValidAction', () => {
  // Every action an engine sends passes through isValidAction before any
  // writer runs, so malformed actions never reach the vault.

  it('drops an update_memory action with the wrong field name', () => {
    // The exact shape that wrote 32 "undefined" lines into memory.md.
    expect(isValidAction({ type: 'update_memory', memory: 'User dislikes emojis' })).toBe(false);
  });

  it('keeps a well-formed update_memory action', () => {
    expect(isValidAction({ type: 'update_memory', observation: 'User dislikes emojis' })).toBe(true);
  });

  it('drops update_patterns, a retired action', () => {
    // patterns.md is gone. A model working from a stale prompt may still emit this;
    // it must not reach the executor, where the action type no longer exists.
    expect(isValidAction({
      type: 'update_patterns', section: 'Response patterns', field: 'Most responsive hour', value: '22:00',
    })).toBe(false);
  });

  it('drops a people_note action missing its note', () => {
    expect(isValidAction({ type: 'people_note', name: 'Silas' })).toBe(false);
  });

  it('drops an unknown action type', () => {
    expect(isValidAction({ type: 'delete_everything', target: '*' })).toBe(false);
  });

  it('drops a propose_config_edit using replace_line without a match', () => {
    expect(isValidAction({
      type: 'propose_config_edit', file: 'identity.md', section: 'What I never do',
      operation: 'replace_line', content: 'x', rationale: 'because',
    })).toBe(false);
  });

  it('drops a propose_config_edit using set_field without a field', () => {
    expect(isValidAction({
      type: 'propose_config_edit', file: 'user.md', section: 'About',
      operation: 'set_field', content: 'Bangalore', rationale: 'User moved.',
    })).toBe(false);
  });

  it('keeps a well-formed propose_config_edit', () => {
    expect(isValidAction({
      type: 'propose_config_edit', file: 'identity.md', section: 'What I never do',
      operation: 'append_bullet', content: 'Never use emojis.',
      rationale: 'User stated a durable style preference.',
    })).toBe(true);
  });

  it('keeps zero-field actions like apply_config_edit', () => {
    expect(isValidAction({ type: 'apply_config_edit' })).toBe(true);
  });
});

describe('parseAgentReply actions block', () => {
  it('splits the words from a trailing actions block', () => {
    const raw = 'Moving it now.\n<actions>[{"type":"move_task","task":"Write intro","from":"To Do","to":"Doing"}]</actions>';
    const reply = parseAgentReply(raw);
    expect(reply.message).toBe('Moving it now.');
    expect(reply.vaultActions).toEqual([{ type: 'move_task', task: 'Write intro', from: 'To Do', to: 'Doing' }]);
    expect(reply.rejected).toEqual([]);
  });

  it('accepts a single object and a fenced json body', () => {
    const raw = 'Noted.<actions>```json\n{"type":"update_memory","observation":"Likes mornings"}\n```</actions>';
    expect(parseAgentReply(raw).vaultActions).toEqual([{ type: 'update_memory', observation: 'Likes mornings' }]);
  });

  it('rejects malformed and unknown actions without running them', () => {
    const raw = 'Ok.<actions>[{"type":"update_memory","memory":"x"},{"type":"rm_rf"}]</actions>';
    const reply = parseAgentReply(raw);
    expect(reply.vaultActions).toEqual([]);
    expect(reply.rejected).toHaveLength(2);
  });

  it('survives invalid JSON and an unterminated block', () => {
    const reply = parseAgentReply('Sure.<actions>[{"type":');
    expect(reply.message).toBe('Sure.');
    expect(reply.vaultActions).toEqual([]);
    expect(reply.rejected).toHaveLength(1);
  });

  it('returns prose with no block unchanged and no actions', () => {
    const reply = parseAgentReply('Just talking.');
    expect(reply.message).toBe('Just talking.');
    expect(reply.vaultActions).toEqual([]);
  });

  it('validates reschedule dates', () => {
    expect(isValidAction({ type: 'reschedule_task', task: 'Gym', newDate: '2026-11-11' })).toBe(true);
    expect(isValidAction({ type: 'reschedule_task', task: 'Gym', newDate: 'tomorrow' })).toBe(false);
  });
});

describe('ActionStreamFilter', () => {
  const run = (chunks: string[]) => {
    const f = new ActionStreamFilter();
    return chunks.map(c => f.push(c)).join('') + f.flush();
  };

  it('passes plain text through', () => {
    expect(run(['Hello ', 'there.'])).toBe('Hello there.');
  });

  it('hides an actions block, even when the tag is split across chunks', () => {
    expect(run(['Done. <act', 'ions>[{"type":"apply_config_edit"}]</act', 'ions>'])).toBe('Done. ');
  });

  it('keeps text after the block closes', () => {
    expect(run(['A<actions>[]</actions>B'])).toBe('AB');
  });

  it('releases a held-back partial tag that never became one', () => {
    expect(run(['a < b, and <a'])).toBe('a < b, and <a');
  });
});

describe('parseAgentReply reasoning-block stripping', () => {
  it('strips Qwen-style <think> blocks', () => {
    const reply = parseAgentReply('<think>let me plan</think>Here is your update.');
    expect(reply.message).toBe('Here is your update.');
  });

  it('strips <thinking> blocks', () => {
    const raw =
      '<thinking>The agent has completed the task and should now summarize.</thinking>\n' +
      "It's 12:08 PM in Example City.";
    const reply = parseAgentReply(raw);
    expect(reply.message).toBe("It's 12:08 PM in Example City.");
  });

  it('strips multiple consecutive <thinking> blocks', () => {
    const raw =
      '<thinking>one</thinking>\n\n<thinking>two</thinking>\n\n<thinking>three</thinking>\nYour top priority is X.';
    const reply = parseAgentReply(raw);
    expect(reply.message).toBe('Your top priority is X.');
  });

  it('drops a dangling <thinking> opener left unterminated by token truncation', () => {
    const reply = parseAgentReply('Quick note.\n<thinking>The agent should now provide the');
    expect(reply.message).toBe('Quick note.');
  });
});

describe('describeActions', () => {
  // The model sometimes calls a tool (e.g. move_task) with no prose reply at all.
  // With nothing to say, the user gets total silence even though the board was
  // updated. describeActions is the fallback the reply path speaks in that case.
  it('describes a move_task with the task and destination column', () => {
    const text = describeActions([
      { type: 'move_task', task: 'Buy a Formal Shirt and Pant', from: 'Doing', to: 'To Do' },
    ]);
    expect(text).toContain('Buy a Formal Shirt and Pant');
    expect(text).toContain('To Do');
  });

  it('describes an add_task', () => {
    const text = describeActions([{ type: 'add_task', text: 'Ship it', column: 'To Do' }]);
    expect(text).toContain('Ship it');
    expect(text).toContain('To Do');
  });

  it('describes each action on its own line', () => {
    const text = describeActions([
      { type: 'move_task', task: 'A', from: 'Doing', to: 'To Do' },
      { type: 'add_task', text: 'B', column: 'Backlog' },
    ]);
    expect(text.split('\n')).toHaveLength(2);
  });

  it('stays silent for actions that already send their own confirmation', () => {
    // reschedule_task and apply_config_edit push confirmations from executeVaultActions.
    // Describing them here too would double-message the user.
    expect(describeActions([{ type: 'reschedule_task', task: 'Gym', newDate: '2026-11-11' }])).toBe('');
    expect(describeActions([{ type: 'apply_config_edit' }])).toBe('');
  });

  it('returns an empty string when there are no actions', () => {
    expect(describeActions([])).toBe('');
    expect(describeActions(undefined)).toBe('');
  });
});
