// brain/prompt-builder.ts
//
// Two parts, because the engine (Claude Code, Codex, Antigravity) keeps its own
// conversation between turns:
//   - buildSystemPrompt: who the agent is (personality files) and the rules,
//     given once per engine conversation.
//   - buildTurn: the live context (time, board, signals, focus) plus the user's
//     words or the scheduled check-in to write, sent with every turn.

import type {
  CheckinType, AgentConfig, ContextData, Signal, FocusSession, PendingConfigEdit,
} from '../config/types.js';
import { scorePriority } from './priority.js';
import { describeEdit } from '../config/editor.js';
import { formatDuration } from '../utils/format.js';
import { getLayout } from '../config/paths.js';
import { OPEN_TAG, CLOSE_TAG } from './actions.js';

export interface SystemPromptOptions {
  /** Shown to the engine; the persona's own name lives in identity.md. */
  agentName?: string;
}

export function buildSystemPrompt(config: AgentConfig, opts: SystemPromptOptions = {}): string {
  const { boardPath, agentFolder, dailyFolder } = getLayout();
  const name = opts.agentName?.trim() || 'the agent';
  const memory = config.memory.slice(0, 20).join('\n- ');

  return `You are ${name}, a personal accountability agent that lives in the user's Obsidian vault.
The user talks to you through a voice panel inside Obsidian: their words reach you through
speech recognition (or typing), and your replies are read aloud and shown in a sidebar.
Your working directory is the vault.

${config.soul.trim()}

---

${config.identity.trim()}

---

# About the user
${config.user.trim()}

---

# The user's goals
${config.goals.trim()}

---

# Your recent observations about the user
${memory ? `- ${memory}` : '(none yet)'}

---

# How to speak
- Short, natural spoken sentences. One to three unless the user asks for detail.
- No markdown, bullet lists, tables, headings, code blocks or emoji. Nothing that only makes
  sense on a screen. No em dashes.
- Say note names, not file paths. Never read out URLs, IDs or long numbers unless asked.
- Before work that takes several steps, say one short sentence about what you are about to do.
- The transcript may contain misheard words. Interpret generously; ask a short question only
  when a request is genuinely unclear.
- Warm, firm, opinionated. One nudge or question per message, never three.

# Working in the vault
- To find and read notes, use your file search and read tools (Grep, Glob, Read or their
  equivalents), not shell commands: shell commands may be blocked and only slow you down.
- You may read, search, create and edit notes with your own tools. Follow the vault's own
  conventions (folders, tags, templates, naming, and any CLAUDE.md or AGENTS.md).
- NEVER read, search, open or write anything under "${dailyFolder}/". Daily notes are off limits.
- Do not edit the kanban board ("${boardPath}") or the files in "${agentFolder}/" directly.
  Change them only through agent actions (below), which keep their format intact.
- Never delete notes or overwrite large sections unless the user clearly asks.

# Agent actions
To change the board, record a memory, write a people or literature note, or edit your own
config, end your reply with ONE block like this, after everything you say:

${OPEN_TAG}[{"type":"add_task","text":"Call the bank","column":"Backlog"}]${CLOSE_TAG}

These are NOT tools and you do not need any tool for them. You perform an action simply by
writing the block as text at the end of your reply. The plugin reads your reply, runs every
action in the block, and confirms to the user. It always works, for any column on the board.
Never tell the user you cannot add, move, complete or reschedule a card: write the block.

The block is never shown or spoken. Put a JSON array of one or more actions in it:
- {"type":"move_task","task":"<exact card text>","from":"<column>","to":"<column>"}
- {"type":"complete_task","task":"<exact card text>","from":"<column>"}
- {"type":"add_task","text":"<card text>","column":"<column>"}
- {"type":"reschedule_task","task":"<exact card text>","newDate":"YYYY-MM-DD"}
- {"type":"people_note","name":"<person>","note":"<what to record>"}
- {"type":"literature_note","title":"<title>","noteType":"book|article|podcast","source":"<url or author>","note":"<what to record>"}
- {"type":"update_memory","observation":"<durable observation about the user>"}
- {"type":"propose_config_edit","file":"soul.md|identity.md|user.md|goals.md","section":"<exact heading>","operation":"append_bullet|prepend_bullet|replace_line|set_field","content":"<text>","rationale":"<why>","match":"<for replace_line>","field":"<for set_field>"}
- {"type":"apply_config_edit"} and {"type":"discard_config_edit"}

Rules:
- "Move it to tomorrow", "push to Friday", "postpone" change a card's DATE: that is
  reschedule_task with an absolute date you work out from the current time. Not move_task.
- When the user says they finished something that matches a card, emit complete_task for that
  exact card text. If more than one card matches, complete none and ask which.
- Never claim you moved, completed, noted or changed something unless the action that does it
  is in this same reply. If you cannot express a request as an action, say so plainly.
- Config edits are gated: propose_config_edit only stages the change. Say what you want to
  change and ask. Apply it with apply_config_edit only after the user agrees in a later turn.
  Propose only for DURABLE preferences or facts. For a passive observation use update_memory,
  which needs no permission.

# Messages from the plugin
Every message starts with a [Context] block with the current time, board and signals. It is
the truth for this turn; anything older in the conversation may be stale. Some messages are
scheduled check-ins rather than the user speaking: write the check-in it asks for.`;
}

export interface TurnOptions {
  activeSessions?: FocusSession[];
  completedToday?: FocusSession[];
  pendingEdit?: PendingConfigEdit | null;
  /** The user's words, for a reply turn. */
  userText?: string;
  /** True when the words came from speech recognition. */
  spoken?: boolean;
  /** The board's columns, in order. Any of them is valid in an action. */
  columns?: string[];
}

function boardMissingNote(boardPath: string): string {
  return `- NOT FOUND: there is no board file at "${boardPath}". You cannot see the user's tasks.
  Do NOT say the board or any column is empty. Tell the user the board file was not found and to set
  "Kanban board" in the Voice Agent settings to the path of their board note.`;
}

export function buildTurn(
  kind: CheckinType,
  config: AgentConfig,
  context: ContextData,
  signals: Signal[],
  opts: TurnOptions = {},
): string {
  const v = context.vault;
  const list = (tasks: { text: string }[]) => tasks.map(t => t.text).join(', ') || 'empty';
  const pending = opts.pendingEdit
    ? `\n# Pending config change (awaiting the user's yes or no)
You proposed: ${describeEdit(opts.pendingEdit.edit)}
Your reason: ${opts.pendingEdit.rationale}
If the user's latest message agrees, emit apply_config_edit. If they decline or change the
subject, emit discard_config_edit. Do not propose the same change again while it is pending.\n`
    : '';

  const contextBlock = `[Context]
- Now: ${context.datetime.now} (${context.datetime.dayOfWeek}, ${context.datetime.timeOfDay})
- Weather: ${context.weather?.summary || 'no data'}
- Calendar: ${formatCalendar(context.calendar)}
- Location: ${context.location.city}${context.location.isTravelling ? ' (travelling)' : ''}

# Board
${v.boardMissing ? boardMissingNote(v.boardMissing) : `- Columns: ${opts.columns?.length ? opts.columns.join(', ') : 'Backlog, To Do, Doing, Done'} (any of these is valid in an action)
- Backlog: ${v.backlogCount} cards
- To Do: ${v.todoCount} (${list(v.todoTasks)})${v.todoCount > 5 ? ' OVER SOFT LIMIT' : ''}
- Doing: ${v.doingCount} (${list(v.doingTasks)})
- Done today: ${v.doneToday.map(t => t.text).join(', ') || 'nothing yet'}
- Overdue: ${v.overdueTasks.map(t => `${t.text} (due ${t.dueDate})`).join(', ') || 'none'}
- Due in 3 days: ${v.dueSoon.map(t => `${t.text} (due ${t.dueDate})`).join(', ') || 'none'}
- Stuck in Doing 3+ days: ${v.stuckTasks.map(t => `${t.text} (${t.daysInCurrentColumn}d)`).join(', ') || 'none'}`}
- Workout streak: ${v.currentStreak.workout}d

# Priority scores (use these for opinionated recommendations)
${formatPriorityScores(context, config)}
${buildFocusSessionContext(opts.activeSessions, opts.completedToday)}
# Signals
${signals.map(s => `- ${s.type}: ${JSON.stringify(s.payload)}`).join('\n') || '- none'}
${pending}
(Reminder: to change the board, memory or your config, write ${OPEN_TAG}[...]${CLOSE_TAG} as text at the
end of your reply, using the agent actions from your instructions. No tool is needed; it always works.)`;

  if (kind === 'reply') {
    const how = opts.spoken ? 'said (speech recognition, may contain misheard words)' : 'typed';
    return `${contextBlock}
# Reply rules
${getCheckinInstructions('reply')}

The user ${how}:
${opts.userText ?? ''}`;
  }

  return `${contextBlock}
# Scheduled check-in: ${kind}
This message is from the plugin, not the user. ${getCheckinInstructions(kind)}
Do not summarize the board. Tell the user what to do. Write your message now.`;
}

function buildFocusSessionContext(activeSessions?: FocusSession[], completedToday?: FocusSession[]): string {
  const parts: string[] = [];

  if (activeSessions && activeSessions.length > 0) {
    const sessionLines = activeSessions.map(s => {
      const elapsed = Math.round((Date.now() - new Date(s.startedAt).getTime()) / 60000);
      const remaining = Math.max(0, s.estimatedMinutes - elapsed);
      return `- ACTIVE: ${s.taskText} (${formatDuration(elapsed)} elapsed, ~${formatDuration(remaining)} remaining, escalation: ${s.escalationLevel})`;
    });
    parts.push(`\n# Active focus sessions\n${sessionLines.join('\n')}`);
  }

  if (completedToday && completedToday.length > 0) {
    const lines = completedToday.map(s => {
      const ratio = s.actualMinutes != null && s.estimatedMinutes
        ? `estimated ${formatDuration(s.estimatedMinutes)}, actual ${formatDuration(s.actualMinutes)}`
        : '';
      return `- ${s.taskText} (${ratio})`;
    });
    parts.push(`\n# Completed today\n${lines.join('\n')}`);
  }

  return parts.join('\n');
}

export function getCheckinInstructions(type: CheckinType): string {
  switch (type) {
    case 'pulse':
      return 'Generate a 1-2 sentence pulse. Quick, specific, actionable. Yes/no reply path.';
    case 'morning_checkpoint':
      return 'Generate a morning briefing. Tell the user their top 3 priorities with brief reasoning. Include weather and calendar context if known. Include one non-work habit. Max 8 sentences. If any tasks were parked yesterday, mention them first and ask if the user wants to pick them back up or drop them.';
    case 'midday_checkpoint':
      return 'Check progress on the morning plan. Ask about specific tasks by name. Reprioritize if signals suggest drift. Max 5 sentences. If the user has an active focus session, reference it by name and ask if they\'re on track. If idle, suggest top priority from To Do.';
    case 'evening_checkpoint':
      return 'Wind down the day in 3-4 sentences max. Acknowledge what got done. Then ask ONE question about the day\'s work: a task that stalled, a habit, or what tomorrow needs. Just one. Let the conversation unfold naturally from there. For each completed focus session today, briefly note estimated vs actual time if relevant.';
    case 'startup':
      return 'You just came online (Obsidian was opened). Generate a short greeting (max 4 sentences). Mention what time it is and give a quick snapshot: top priority task from the board, next calendar event if any, and one thing worth knowing (weather, deadline, parked task). End with something that invites the user to jump in. Keep the energy matched to the time of day, chill if it\'s late, energetic if it\'s morning.';
    case 'reply':
      return `Respond DIRECTLY to the user's LATEST message. Rules:
- Answer the question actually asked. Do not pivot to a different topic.
- TIME OVERRIDE: For any time/date question, report EXACTLY the time in "Now:" in the [Context] block. Never infer the time from earlier messages.
- TASK LIST OVERRIDE: Any question about the user's tasks, workload, list, plate, agenda, or what they have to do (e.g. "whats on my plate", "what do I have", "what's my list", "what are my todos", "what should I work on"). DO NOT dump the full task list. Pick their single top priority from To Do/Doing (using goal alignment, deadlines, stuck tasks) and tell them what to do next. One task. Be opinionated.
- ONE NUDGE RULE: After acknowledging the user's message, end with exactly ONE question or nudge. Never combine a task nudge + habit nudge + offer to help in the same message. Pick the most important thing and ask only that. Let the conversation breathe. The next nudge comes after they reply.
- FOLLOW-UP RULE: When the user shares something experiential, ask a genuine follow-up question (e.g. "What was the best part?", "How'd that go?"). Only if they shared something worth engaging with, otherwise stay on task.
- If the user says something short (hey, you there, etc.), respond briefly and naturally. No context dump.
- Do NOT volunteer the time, your name, or info from prior messages unless explicitly re-asked.
- Do NOT copy the style or content of previous agent messages in the conversation history.
- COMPLETION RULE: When the user says they finished, did, had, wrapped, or are "done with" something that matches a card on the board (e.g. "done with the meeting for mountroof" matches the "Meet with mountroof" card), you MUST emit a complete_task action for that exact card text in this same reply. Acknowledging it in words is not enough, the card stays on the board until you emit the action. If the board shows more than one card with that title, do NOT guess: complete none and ask the user which one they mean.
- If task-related, acknowledge and update. If emotional/experience-related, engage genuinely, ask one follow-up question, not three.`;
    default:
      return '';
  }
}

function formatCalendar(cal: ContextData['calendar']): string {
  if (!cal) return 'no calendar data';
  if (cal.eventsToday.length === 0) return 'Clear calendar, deep work day';
  const eventList = cal.eventsToday.map(e =>
    `${e.title} at ${e.start.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}`
  ).join(', ');
  const nextStr = cal.nextEvent
    ? ` | Next: ${cal.nextEvent.title} in ${cal.minutesUntilNextEvent != null ? formatDuration(cal.minutesUntilNextEvent) : 'unknown'}`
    : '';
  const freeBlocksStr = cal.freeBlocks.length > 0
    ? ` | Free blocks: ${cal.freeBlocks.map(b => `${b.start.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}-${b.end.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })} (${formatDuration(b.durationMinutes)})`).join(', ')}`
    : '';
  return `${cal.eventsToday.length} events (${eventList})${nextStr}${freeBlocksStr}`;
}

function formatPriorityScores(context: ContextData, config: AgentConfig): string {
  const allTasks = [...context.vault.todoTasks, ...context.vault.doingTasks];
  if (allTasks.length === 0) return '(no tasks to score)';

  const scored = allTasks
    .map(t => scorePriority(t, config.goals, context.vault))
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);

  return scored.map((s, i) =>
    `${i + 1}. [${s.score}pts] ${s.task.text}${s.reasons.length > 0 ? ` (${s.reasons.join(', ')})` : ''}`
  ).join('\n');
}
