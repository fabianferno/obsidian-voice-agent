// utils/json.ts - read untrusted JSON (CLI output, API responses) without `any`.

export type JsonObject = Record<string, unknown>;

export function asObject(v: unknown): JsonObject {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as JsonObject) : {};
}

export function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? (v as unknown[]) : [];
}

export function asString(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

export function asNumber(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/** Parses JSON, returning undefined instead of throwing. */
export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** A readable string for any JSON value: strings as they are, other values as JSON. */
export function toText(v: unknown, fallback = ''): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (v === null || v === undefined) return fallback;
  try {
    return JSON.stringify(v);
  } catch {
    return fallback;
  }
}
