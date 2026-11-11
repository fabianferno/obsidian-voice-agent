/** Whisper marks silence and noise as [BLANK_AUDIO], (music) and so on. */
export function cleanWhisper(text: string): string {
  return text
    .replace(/\[[^\]]*\]|\([^)]*\)|\*[^*]*\*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
