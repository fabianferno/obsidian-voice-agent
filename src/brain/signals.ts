// brain/signals.ts

import type { Signal, VaultStateContext, StoredMessage, HealthContext, CalendarContext, PersonNote } from '../config/types.js';

export function detectSignals(
  vaultState: VaultStateContext,
  messages: StoredMessage[],
  health: HealthContext,
  calendar: CalendarContext,
): Signal[] {
  const signals: Signal[] = [];

  // Task completed today
  for (const task of vaultState.doneToday) {
    signals.push({
      type: 'task_completed',
      payload: { task: task.text },
      priority: 8,
    });
  }

  // Hackathon completed
  for (const task of vaultState.doneToday) {
    if (isHackathonTask(task.text)) {
      signals.push({
        type: 'hackathon_completed',
        payload: { task: task.text },
        priority: 9,
      });
    }
  }

  // Person mentioned in today's messages
  const todayMessages = messages.filter(m => isToday(m.timestamp));
  for (const msg of todayMessages) {
    if (msg.direction !== 'incoming') continue;
    const people = extractPeopleMentions(msg.text, vaultState.peopleNotes);
    for (const person of people) {
      signals.push({
        type: 'person_mentioned',
        payload: { name: person.name, existingNote: person.hasNote },
        priority: 6,
      });
    }
  }

  // Travel detected
  if (vaultState.location?.isTravelling) {
    signals.push({
      type: 'travelling',
      payload: { city: vaultState.location.city },
      priority: 5,
    });
  }

  // Emotional share
  for (const msg of todayMessages) {
    if (msg.direction === 'incoming' && hasEmotionalIntensity(msg.text)) {
      signals.push({
        type: 'emotional_share',
        payload: { text: msg.text },
        priority: 7,
      });
    }
  }

  // Quiet day fallback
  if (signals.length === 0) {
    signals.push({ type: 'quiet_day', payload: {}, priority: 1 });
  }

  return signals.sort((a, b) => b.priority - a.priority);
}

function isHackathonTask(text: string): boolean {
  return /hackathon|submission|demo|pitch|bounty|devpost|dorahacks/i.test(text);
}

function isToday(timestamp: Date): boolean {
  const today = new Date().toISOString().split('T')[0];
  return timestamp.toISOString().split('T')[0] === today;
}

function extractPeopleMentions(
  text: string,
  peopleNotes: PersonNote[],
): { name: string; hasNote: boolean }[] {
  const mentions: { name: string; hasNote: boolean }[] = [];
  for (const person of peopleNotes) {
    if (text.toLowerCase().includes(person.name.toLowerCase())) {
      mentions.push({ name: person.name, hasNote: person.hasNote });
    }
  }
  return mentions;
}

function hasEmotionalIntensity(text: string): boolean {
  return /incredible|amazing|terrible|frustrated|excited|overwhelmed|blown away|can't believe|so happy|so sad|!!!/i.test(text);
}
