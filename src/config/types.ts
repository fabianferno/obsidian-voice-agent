// config/types.ts — All TypeScript interfaces for the agent

// === Agent Configuration ===

export interface AgentConfig {
  soul: string;
  identity: string;
  user: string;
  goals: string;
  memory: string[];
  userMeta: UserMeta;
}

export interface UserMeta {
  name: string;
  nickname: string;
  location: string;
  timezone: string;
  coordinates: { lat: number; lng: number };
  activeHoursStart: string;
  activeHoursEnd: string;
  quietHoursStart: string;
  quietHoursEnd: string;
  pulseIntervalMinutes: number;
}

// === Vault Types ===

export interface Task {
  text: string;
  completed: boolean;
  id?: string;                // Obsidian block-ref card id (e.g. "a1b2c3")
  dueDate?: string;
  dueTime?: string;
  wikilinks: string[];
  urls: string[];
  column: string;
  daysInCurrentColumn?: number;
  addedDate?: string;
  rawLine?: string;           // Original markdown line from Kanban (for matching)
  pausedNote?: string;
}

export interface KanbanBoard {
  columns: Record<string, Task[]>;
  columnOrder: string[];
}

export interface KanbanMutation {
  type: 'move' | 'add' | 'remove' | 'edit';
  task: string;
  fromColumn?: string;
  toColumn?: string;
  newText?: string;
}

// === Context Types ===

export interface ContextData {
  datetime: DateTimeContext;
  weather: WeatherContext | null;
  calendar: CalendarContext | null;
  health: HealthContext | null;
  location: LocationContext;
  vault: VaultStateContext;
}

export interface DateTimeContext {
  now: string;
  dayOfWeek: string;
  timeOfDay: 'morning' | 'afternoon' | 'evening' | 'night';
  isWeekend: boolean;
  daysUntilWeekend: number;
}

export interface WeatherContext {
  location: string;
  temperature: number;
  unit: string;
  condition: string;
  humidity: number;
  isGoodForOutdoor: boolean;
  summary: string;
}

export interface CalendarEvent {
  title: string;
  start: Date;
  end: Date;
  isAllDay: boolean;
  location?: string;
  meetLink?: string;
}

export interface TimeBlock {
  start: Date;
  end: Date;
  durationMinutes: number;
}

export interface CalendarContext {
  eventsToday: CalendarEvent[];
  eventsTomorrow: CalendarEvent[];
  nextEvent: CalendarEvent | null;
  minutesUntilNextEvent: number | null;
  freeBlocks: TimeBlock[];
}

export interface HealthContext {
  stepsToday: number | null;
  lastWorkout: string | null;
  sleepLastNight: number | null;
  activeCalories: number | null;
  heartRateAvg: number | null;
  dataFreshness: string;
}

export interface LocationContext {
  city: string;
  country: string;
  timezone: string;
  coordinates: { lat: number; lng: number };
  isTravelling: boolean;
}

export interface VaultStateContext {
  backlogCount: number;
  todoCount: number;
  todoTasks: Task[];
  doingCount: number;
  doingTasks: Task[];
  doneToday: Task[];
  overdueTasks: Task[];
  dueSoon: Task[];
  stuckTasks: Task[];
  currentStreak: { workout: number };
  wipWarning: boolean;
  peopleNotes: PersonNote[];
  location?: LocationContext;
}

export interface PersonNote {
  name: string;
  filePath: string;
  hasNote: boolean;
}

// === Signal Types ===

export interface Signal {
  type: string;
  payload: Record<string, unknown>;
  priority: number;
}

// === LLM Types ===

export type CheckinType =
  | 'pulse'
  | 'morning_checkpoint'
  | 'midday_checkpoint'
  | 'evening_checkpoint'
  | 'reply'
  | 'startup';

export interface AgentReply {
  message: string;
  vaultActions?: VaultAction[];
}

export type VaultAction =
  | { type: 'move_task'; task: string; from: string; to: string }
  | { type: 'complete_task'; task: string; from: string }
  | { type: 'add_task'; text: string; column: string }
  | { type: 'people_note'; name: string; note: string }
  | { type: 'literature_note'; title: string; noteType: string; source: string; note: string }
  | { type: 'update_memory'; observation: string }
  | { type: 'reschedule_task'; task: string; newDate: string }
  | { type: 'propose_config_edit'; file: ConfigFile; section: string;
      operation: ConfigEditOperation; content: string; rationale: string;
      match?: string; field?: string }
  | { type: 'apply_config_edit' }
  | { type: 'discard_config_edit' };

// === Config Self-Edit Types ===

/** The agent's own personality and state files. They live in the VAULT repo under agent/. */
export type ConfigFile =
  | 'soul.md' | 'identity.md' | 'user.md' | 'goals.md' | 'memory.md';

export type ConfigEditOperation =
  | 'append_bullet' | 'prepend_bullet' | 'replace_line' | 'set_field';

export type ConfigEdit =
  | { file: ConfigFile; section: string; operation: 'append_bullet'; content: string }
  | { file: ConfigFile; section: string; operation: 'prepend_bullet'; content: string }
  | { file: ConfigFile; section: string; operation: 'replace_line'; match: string; content: string }
  | { file: ConfigFile; section: string; operation: 'set_field'; field: string; content: string };

export type EditResult =
  | { ok: true; content: string }
  | { ok: false; reason: string };

/** A config edit awaiting the user's yes/no, persisted in session_state. */
export interface PendingConfigEdit {
  edit: ConfigEdit;
  rationale: string;
  proposedAt: string;   // ISO timestamp
}

// === Priority Types ===

export interface PriorityScore {
  task: Task;
  score: number;
  reasons: string[];
}

// === Messaging Types ===

export type SendMessageFn = (text: string, source?: string, opts?: { bypassThrottle?: boolean }) => Promise<void>;

export interface IncomingMessage {
  channel: 'voice' | 'text';
  text: string;
  timestamp: Date;
  isVoiceNote: boolean;
}

export interface StoredMessage {
  id: string;
  channel: 'voice' | 'text';
  direction: 'incoming' | 'outgoing';
  text: string;
  timestamp: Date;
  checkinType?: CheckinType;
  wasVoiceNote: boolean;
  replied: boolean;
  replyTimeMs?: number;
}

// === Health Payload ===

// === Synapse Types ===

export interface SynapseItem {
  filePath: string;
  fileName: string;
  createdDate: Date;
  modifiedDate: Date;
  ageHours: number;
  content: string;
  wordCount: number;
}

// === Adaptive Config ===

export interface AdaptiveConfig {
  baseIntervalMinutes: number;
  minIntervalMinutes: number;
  maxIntervalMinutes: number;
  backoffAfterIgnored: number;
}

export interface AgentState {
  lastReplyTimeMs: number;
  hoursSinceLastReply: number;
  tasksDueToday: number;
  inMeetingNow: boolean;
  consecutiveIgnoredPulses: number;
  inQuietHours: boolean;
  onboardingComplete: boolean;
  activeSessions: FocusSession[];
}

// === Focus Session ===

export interface FocusSession {
  id: number;
  taskText: string;
  rawTaskLine: string;
  cardId?: string;
  estimatedMinutes: number;
  estimateSource: 'user' | 'llm';
  startedAt: string;
  deadlineAt: string;
  escalationLevel: 0 | 1 | 2 | 3;
  status: 'active' | 'completed' | 'parked' | 'cancelled';
  actualMinutes?: number;
  pausedNote?: string;
  completedAt?: string;
}

export type GuardDecision =
  | { action: 'allow' }
  | { action: 'warn'; activeSessions: FocusSession[]; message: string }
  | { action: 'block'; activeSessions: FocusSession[]; message: string };
