// brain/priority.ts

import type { Task, PriorityScore, VaultStateContext } from '../config/types.js';

export function scorePriority(
  task: Task,
  goalsContent: string,
  vaultState: VaultStateContext,
): PriorityScore {
  let score = 0;
  const reasons: string[] = [];

  // Due date proximity (30%)
  if (task.dueDate) {
    const daysUntil = diffDays(new Date(task.dueDate), new Date());
    if (daysUntil < 0) {
      score += 30;
      reasons.push(`Overdue by ${Math.abs(daysUntil)} days`);
    } else if (daysUntil <= 1) {
      score += 28;
      reasons.push('Due today/tomorrow');
    } else if (daysUntil <= 3) {
      score += 22;
      reasons.push(`Due in ${daysUntil} days`);
    } else if (daysUntil <= 7) {
      score += 15;
      reasons.push('Due this week');
    }
  }

  // Goal alignment (25%)
  const matchedGoal = findGoalAlignment(task.text, goalsContent);
  if (matchedGoal) {
    score += 25;
    reasons.push(`Aligns with goal: "${matchedGoal}"`);
  }

  // Staleness (15%)
  const daysInColumn = task.daysInCurrentColumn || 0;
  if (daysInColumn > 14) {
    score += 15;
    reasons.push(`Sitting for ${daysInColumn} days, decide or kill`);
  } else if (daysInColumn > 7) {
    score += 10;
    reasons.push(`In column for ${daysInColumn} days`);
  }

  // Context grouping (15%)
  const currentProject = getCurrentProject(vaultState.doingTasks);
  if (currentProject && taskBelongsToProject(task.text, currentProject)) {
    score += 15;
    const projectLabel = currentProject.split(/\s+/).filter(w => w.length > 3)[0] || currentProject;
    reasons.push(`Related to current focus: ${projectLabel}`);
  }

  // Revenue signal (10%)
  if (isRevenueTask(task.text)) {
    score += 10;
    reasons.push('Revenue/income related');
  }

  // Recency (5%)
  if (task.addedDate) {
    const daysSinceAdded = diffDays(new Date(), new Date(task.addedDate));
    if (daysSinceAdded <= 3) {
      score += 5;
      reasons.push('Recently added');
    }
  }

  return { task, score, reasons };
}

function diffDays(a: Date, b: Date): number {
  const msPerDay = 1000 * 60 * 60 * 24;
  return Math.floor((a.getTime() - b.getTime()) / msPerDay);
}

function findGoalAlignment(taskText: string, goalsContent: string): string | null {
  const lines = goalsContent.split('\n').filter(l => l.trim().startsWith('- [ ]') || l.trim().startsWith('- [x]'));

  for (const line of lines) {
    const goalText = line.replace(/^- \[[ xX]\]\s*/, '').trim();
    // Check if task keywords overlap with goal keywords
    const goalWords = goalText.toLowerCase().split(/\s+/).filter(w => w.length > 3);
    const taskWords = taskText.toLowerCase().split(/\s+/).filter(w => w.length > 3);

    const overlap = goalWords.filter(gw => taskWords.some(tw => tw.includes(gw) || gw.includes(tw)));
    if (overlap.length >= 1) {
      return goalText;
    }
  }

  return null;
}

function getCurrentProject(doingTasks: Task[]): string | null {
  if (doingTasks.length === 0) return null;
  // Return the full text of the first doing task; matching done via word overlap
  return doingTasks[0].text;
}

function taskBelongsToProject(taskText: string, projectText: string): boolean {
  const projectWords = projectText.toLowerCase().split(/\s+/).filter(w => w.length > 3);
  const taskWords = taskText.toLowerCase().split(/\s+/).filter(w => w.length > 3);
  return projectWords.some(pw => taskWords.some(tw => tw.includes(pw) || pw.includes(tw)));
}

function isRevenueTask(text: string): boolean {
  return /revenue|invoice|client|contract|payment|consulting|freelance|bounty|prize/i.test(text);
}
