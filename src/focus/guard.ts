import type { FocusSession, GuardDecision } from '../config/types.js';
import { formatDuration } from '../utils/format.js';

export function checkGuard(activeSessions: FocusSession[]): GuardDecision {
  if (activeSessions.length === 0) {
    return { action: 'allow' };
  }

  if (activeSessions.length === 1) {
    const session = activeSessions[0];
    const minutesLeft = Math.max(0, Math.round((new Date(session.deadlineAt).getTime() - Date.now()) / 60000));
    return {
      action: 'warn',
      activeSessions,
      message: `You're on ${session.taskText} (~${formatDuration(minutesLeft)} left). Want to park it, or is this a quick side task?`,
    };
  }

  const names = activeSessions.map(s => s.taskText).join(' and ');
  return {
    action: 'block',
    activeSessions,
    message: `You're already on ${names}. Park or finish one first.`,
  };
}
