import { describe, it, expect } from 'vitest';
import { mintCardId } from '../src/vault/card-id.js';

describe('mintCardId', () => {
  it('mints a 6-char base36 id not already in use', () => {
    const existing = new Set<string>();
    const id = mintCardId(existing);
    expect(id).toMatch(/^[a-z0-9]{6}$/);
    expect(existing.has(id)).toBe(true);
  });

  it('avoids collisions with existing ids', () => {
    const id1 = mintCardId(new Set());
    const existing = new Set([id1]);
    const id2 = mintCardId(existing);
    expect(id2).not.toBe(id1);
  });
});
