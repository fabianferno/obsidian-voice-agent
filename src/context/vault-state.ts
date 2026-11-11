// context/vault-state.ts

import { readFileSync, existsSync } from 'fs';
import type { VaultStateContext, Task, PersonNote, LocationContext } from '../config/types.js';
import type { Store } from '../store/store.js';
import { parseInboxKanban } from '../vault/parser.js';
import { searchByTag } from '../vault/search.js';
import { boardFile } from '../config/paths.js';

export async function getVaultState(
  vaultPath: string,
  store: Store,
  location?: LocationContext,
): Promise<VaultStateContext> {
  // Parse Kanban
  const inboxPath = boardFile(vaultPath);
  const board = existsSync(inboxPath)
    ? parseInboxKanban(readFileSync(inboxPath, 'utf-8'))
    : { columns: {}, columnOrder: [] };

  const backlog = board.columns['Backlog'] || [];
  const todo = board.columns['To Do'] || [];
  const doing = board.columns['Doing'] || [];
  const done = board.columns['Done'] || [];

  const today = new Date().toISOString().split('T')[0];

  // Track first-seen for Doing tasks (keyed by stable card id)
  for (const task of doing) {
    if (task.id) await store.trackTaskFirstSeen(task.id, 'Doing', today);
  }

  // Track first-seen for Done tasks — used to determine which were completed today
  for (const task of done) {
    if (task.id) await store.trackTaskFirstSeen(task.id, 'Done', today);
  }

  // Compute stuck tasks
  const stuckTasks: Task[] = [];
  for (const task of doing) {
    if (!task.id) continue;
    const firstSeen = await store.getTaskFirstSeen(task.id, 'Doing');
    if (firstSeen) {
      const days = Math.floor((Date.now() - new Date(firstSeen).getTime()) / (1000 * 60 * 60 * 24));
      task.daysInCurrentColumn = days;
      if (days >= 3) stuckTasks.push(task);
    }
  }

  // Compute overdue and due-soon
  const overdueTasks = [...todo, ...doing].filter(t => t.dueDate && t.dueDate < today);
  const threeDaysFromNow = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
  const dueSoon = [...todo, ...doing].filter(
    t => t.dueDate && t.dueDate >= today && t.dueDate <= threeDaysFromNow,
  );

  // Done today = tasks in Done column whose first-seen date in Done is today
  const doneToday: Task[] = [];
  for (const task of done) {
    if (!task.id) continue;
    const firstSeen = await store.getTaskFirstSeen(task.id, 'Done');
    if (firstSeen === today) doneToday.push(task);
  }

  // People notes
  const peopleResults = searchByTag(vaultPath, 'people');
  const peopleNotes: PersonNote[] = peopleResults.map(r => ({
    name: r.fileName,
    filePath: r.filePath,
    hasNote: true,
  }));

  // WIP warnings
  const wipWarning = doing.length > 3 || todo.length > 5;

  const workoutStreak = await store.getWorkoutStreak();

  return {
    backlogCount: backlog.length,
    todoCount: todo.length,
    todoTasks: todo,
    doingCount: doing.length,
    doingTasks: doing,
    doneToday,
    overdueTasks,
    dueSoon,
    stuckTasks,
    currentStreak: { workout: workoutStreak },
    wipWarning,
    peopleNotes,
    location,
  };
}
