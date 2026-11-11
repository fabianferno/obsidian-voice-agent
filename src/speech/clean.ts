/**
 * Shapes agent text for text-to-speech. Agents are told not to use markdown,
 * but they slip, and everything here is read aloud.
 */
export function cleanForSpeech(text: string): string {
  if (!text) return '';
  return text
    .replace(/```[\s\S]*?(```|$)/g, ' ') // fenced code blocks, closed or dangling
    .replace(/`([^`]*)`/g, '$1') // inline code
    .replace(/!\[\[[^\]]*\]\]/g, ' ') // embedded files ![[image.png]]
    .replace(/\[\[([^\]|#]*)(?:#[^\]|]*)?\|([^\]]*)\]\]/g, '$2') // [[Note|alias]] -> alias
    .replace(/\[\[([^\]|#]*)(?:#[^\]]*)?\]\]/g, '$1') // [[Note]] or [[Note#Heading]] -> Note
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1') // [text](url) -> text
    .replace(/https?:\/\/\S+/g, 'a link')
    .replace(/\b([\w -]+)\.md\b/g, '$1') // "Garden Project.md" -> "Garden Project"
    .replace(/^\s*#{1,6}\s+/gm, '') // headings
    .replace(/^\s*>\s?/gm, '') // blockquotes
    .replace(/^\s*[-*+]\s+\[[ xX]\]\s+/gm, '') // task checkboxes
    .replace(/^\s*[-*+]\s+/gm, '') // bullets
    .replace(/^\s*\d+[.)]\s+/gm, '') // numbered list markers
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/(^|[^\w*])\*([^*\n]+)\*/g, '$1$2')
    .replace(/(^|\s)#(\d+)\b/g, '$1number $2') // #42 -> number 42
    .replace(/(^|\s)#([A-Za-z][\w/-]*)/g, '$1$2') // #tag -> tag
    .replace(/\|/g, ', ') // table pipes
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, '') // emoji
    .replace(/\u{FE0F}/gu, '') // emoji variation selector
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, ' ')
    .trim();
}

/** True if TTS has something to say (at least one letter or digit). */
export function hasSpeakableText(text: string): boolean {
  return /[\p{L}\p{N}]/u.test(text);
}
