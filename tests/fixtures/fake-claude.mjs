#!/usr/bin/env node
// Stands in for `claude -p --input-format stream-json ...` in tests.
// Echoes each user message back as streamed text. A message containing
// "SLOW" never finishes (so tests can interrupt it). Records its argv to
// FAKE_CLAUDE_LOG so tests can check --resume.
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const log = process.env.FAKE_CLAUDE_LOG;
if (log) appendFileSync(log, JSON.stringify(process.argv.slice(2)) + '\n');

const resumeAt = process.argv.indexOf('--resume');
const sessionId = resumeAt > 0 ? process.argv[resumeAt + 1] : 'session-1';
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');

out({ type: 'system', subtype: 'init', session_id: sessionId });

const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  const text = msg.message.content;
  if (text.includes('SLOW')) return;
  out({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'message_start' } });
  out({
    type: 'assistant',
    parent_tool_use_id: null,
    message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: '/vault/Daily/2026-11-10.md' } }] },
  });
  out({
    type: 'stream_event',
    parent_tool_use_id: null,
    event: { type: 'content_block_delta', delta: { type: 'text_delta', text: `You said: ${text}` } },
  });
  // Subagent output must be ignored.
  out({
    type: 'stream_event',
    parent_tool_use_id: 'tool-9',
    event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'SUBAGENT' } },
  });
  out({ type: 'result', subtype: 'success', is_error: false, result: 'ok', session_id: sessionId });
});
