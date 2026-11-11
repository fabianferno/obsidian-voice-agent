// utils/logger.ts — Structured logger with levels, timestamps, and module context

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };
const LEVEL_LABELS: Record<LogLevel, string> = { debug: 'DBG', info: 'INF', warn: 'WRN', error: 'ERR' };

const currentLevel: LogLevel = (process.env.LOG_LEVEL as LogLevel) || 'info';

function timestamp(): string {
  return new Date().toISOString();
}

function shouldLog(level: LogLevel): boolean {
  return LEVEL_ORDER[level] >= LEVEL_ORDER[currentLevel];
}

function formatMessage(level: LogLevel, module: string, msg: string, meta?: unknown): string {
  const base = `${timestamp()} ${LEVEL_LABELS[level]} [${module}] ${msg}`;
  if (meta === undefined) return base;
  if (meta instanceof Error) return `${base} | ${meta.message}\n${meta.stack}`;
  if (typeof meta === 'string') return `${base} | ${meta}`;
  return `${base} | ${JSON.stringify(meta)}`;
}

function createModuleLogger(module: string) {
  return {
    debug(msg: string, meta?: unknown) {
      if (shouldLog('debug')) console.debug(formatMessage('debug', module, msg, meta));
    },
    info(msg: string, meta?: unknown) {
      if (shouldLog('info')) console.debug(formatMessage('info', module, msg, meta));
    },
    warn(msg: string, meta?: unknown) {
      if (shouldLog('warn')) console.warn(formatMessage('warn', module, msg, meta));
    },
    error(msg: string, meta?: unknown) {
      if (shouldLog('error')) console.error(formatMessage('error', module, msg, meta));
    },
  };
}

export const log = createModuleLogger('agent');

export function createLogger(module: string) {
  return createModuleLogger(module);
}
