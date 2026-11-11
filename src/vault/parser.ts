// vault/parser.ts

import type { KanbanBoard, Task } from '../config/types.js';

export function parseInboxKanban(content: string): KanbanBoard {
  // Strip frontmatter
  const withoutFrontmatter = content.replace(/^---[\s\S]*?---\n*/, '');

  // Strip kanban settings block
  const withoutSettings = withoutFrontmatter.replace(/%% kanban:settings[\s\S]*?%%/, '');

  const columns: Record<string, Task[]> = {};
  const columnOrder: string[] = [];
  let currentColumn = '';

  for (const line of withoutSettings.split('\n')) {
    const trimmed = line.trim();

    // Column header
    const columnMatch = trimmed.match(/^## (.+)$/);
    if (columnMatch) {
      currentColumn = columnMatch[1].trim();
      columns[currentColumn] = [];
      columnOrder.push(currentColumn);
      continue;
    }

    // Task line
    const taskMatch = trimmed.match(/^- \[([ xX])\] (.+)$/);
    if (taskMatch && currentColumn) {
      const completed = taskMatch[1] !== ' ';

      // Store raw line for Kanban matching
      const rawLine = taskMatch[2];

      // Extract trailing block-ref id: " ^a1b2c3". Must come before the pause
      // annotation: the id is always the last token, and the pause note runs to
      // end of line, so parsing the note first would swallow the id into it.
      let textToParse = rawLine;
      let id: string | undefined;
      const idMatch = textToParse.match(/\s+\^([a-z0-9]+)\s*$/);
      if (idMatch) {
        id = idMatch[1];
        textToParse = textToParse.replace(idMatch[0], '');
      }

      // Extract pause annotation (before text cleaning)
      let pausedNote: string | undefined;
      const pauseMatch = textToParse.match(/\s*—\s*paused:\s*(.+)$/);
      if (pauseMatch) {
        pausedNote = pauseMatch[1].trim();
        textToParse = textToParse.replace(pauseMatch[0], '');
      }

      let text = textToParse;

      // Extract @{date}
      let dueDate: string | undefined;
      const dateMatch = text.match(/@\{(\d{4}-\d{2}-\d{2})\}/);
      if (dateMatch) {
        dueDate = dateMatch[1];
        text = text.replace(dateMatch[0], '').trim();
      }

      // Extract @@{time}
      let dueTime: string | undefined;
      const timeMatch = text.match(/@@\{(\d{2}:\d{2})\}/);
      if (timeMatch) {
        dueTime = timeMatch[1];
        text = text.replace(timeMatch[0], '').trim();
      }

      // Extract [[wikilinks]]
      const wikilinks: string[] = [];
      const wikiRegex = /\[\[([^\]]+)\]\]/g;
      let wikiMatch;
      while ((wikiMatch = wikiRegex.exec(text)) !== null) {
        wikilinks.push(wikiMatch[1]);
      }

      // Extract URLs
      const urls: string[] = [];
      const urlRegex = /https?:\/\/[^\s)]+/g;
      let urlMatch;
      while ((urlMatch = urlRegex.exec(text)) !== null) {
        urls.push(urlMatch[0]);
      }

      // Clean text: remove wikilink brackets but keep text, keep URLs in text
      const cleanText = text
        .replace(/\[\[([^\]]+)\]\]/g, '$1')
        .replace(/\s+/g, ' ')
        .trim();

      columns[currentColumn].push({
        text: cleanText,
        completed,
        id,
        dueDate,
        dueTime,
        wikilinks,
        urls,
        column: currentColumn,
        rawLine,
        pausedNote,
      });
    }
  }

  return { columns, columnOrder };
}

export function parseFrontmatter(content: string): { tags: string[]; [key: string]: unknown } {
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (!fmMatch) return { tags: [] };

  const fm = fmMatch[1];
  const result: { tags: string[]; [key: string]: unknown } = { tags: [] };

  // Parse tags: [tag1, tag2] or tags:\n  - tag1
  const tagsMatch = fm.match(/tags:\s*\[([^\]]*)\]/);
  if (tagsMatch) {
    result.tags = tagsMatch[1].split(',').map(t => t.trim()).filter(Boolean);
  }

  return result;
}
