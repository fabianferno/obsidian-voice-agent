// vault/synapse-migration.ts

import { readdirSync, readFileSync, statSync } from 'fs';
import path from 'path';
import type { SynapseItem } from '../config/types.js';
import { captureDir } from '../config/paths.js';

/**
 * Notes in the capture folder (and any subfolders), oldest first. The folder is
 * meant to be a short-lived inbox: anything older than 48h gets a triage nudge.
 */
export function scanSynapses(vaultPath: string): SynapseItem[] {
  const dir = captureDir(vaultPath);
  if (!dir) return [];
  const items: SynapseItem[] = [];
  const walk = (d: string) => {
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return; // folder does not exist yet
    }
    for (const entry of entries) {
      const filePath = path.join(d, entry.name);
      if (entry.isDirectory()) {
        walk(filePath);
        continue;
      }
      if (!entry.name.endsWith('.md')) continue;
      const stat = statSync(filePath);
      const content = readFileSync(filePath, 'utf-8');
      items.push({
        filePath,
        fileName: entry.name,
        createdDate: stat.birthtime,
        modifiedDate: stat.mtime,
        ageHours: (Date.now() - stat.birthtimeMs) / (1000 * 60 * 60),
        content,
        wordCount: content.split(/\s+/).filter(Boolean).length,
      });
    }
  };
  walk(dir);
  return items.sort((a, b) => b.ageHours - a.ageHours);
}

export function getStaleItems(items: SynapseItem[]): SynapseItem[] {
  return items.filter(item => item.ageHours > 48);
}
