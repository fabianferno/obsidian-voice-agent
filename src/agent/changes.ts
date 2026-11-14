// agent/changes.ts - the notes and files a turn or a note pass touched, so the
// panel can show them (and link to them) under the message.

export type NoteChangeKind = 'created' | 'updated' | 'moved' | 'asked' | 'trashed' | 'deleted';

export interface NoteChange {
  kind: NoteChangeKind;
  /** Vault-relative path (where the file is now, for a move: where it came from). */
  path: string;
  /** For a move: the new vault-relative path. */
  to?: string;
}

const STRENGTH: Record<NoteChangeKind, number> = { updated: 0, asked: 1, created: 2, moved: 3, trashed: 4, deleted: 4 };

/** Adds a change, one entry per file: "created" wins over a later "updated", and so on. */
export function addChange(list: NoteChange[], change: NoteChange): NoteChange[] {
  const i = list.findIndex(c => c.path === change.path);
  if (i === -1) return [...list, change];
  if (STRENGTH[change.kind] < STRENGTH[list[i].kind]) return list;
  const next = [...list];
  next[i] = change;
  return next;
}

/** A note's name for display: the file name without folders and without `.md`. */
export function changeName(p: string): string {
  const base = p.split('/').pop() ?? p;
  return base.replace(/\.md$/i, '');
}

export function describeChange(c: NoteChange): string {
  const name = changeName(c.path);
  switch (c.kind) {
    case 'created': return `Created ${name}`;
    case 'updated': return `Updated ${name}`;
    case 'moved': return `Moved ${name} to ${c.to ? c.to.split('/').slice(0, -1).join('/') || 'the vault root' : 'notes'}`;
    case 'asked': return `Asked a question in ${name}`;
    case 'trashed': return `Trashed ${name}`;
    case 'deleted': return `Deleted ${name}`;
  }
}
