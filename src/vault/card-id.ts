// vault/card-id.ts

import { randomBytes } from 'crypto';

/** Mint a 6-char base36 (0-9a-f subset) card id not present in `existing`. */
export function mintCardId(existing: Set<string>): string {
  for (let attempt = 0; attempt < 50; attempt++) {
    const id = randomBytes(6).toString('hex').slice(0, 6);
    if (!existing.has(id)) {
      existing.add(id);
      return id;
    }
  }
  throw new Error('mintCardId: could not find a free id after 50 attempts');
}
