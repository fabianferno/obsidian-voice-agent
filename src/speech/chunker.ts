/**
 * Cuts streaming agent text into sentence-sized pieces so speech can start
 * before the agent has finished. The first piece is allowed to be short, to
 * get audio playing quickly; later pieces are batched up to a comfortable size.
 */
export class SentenceChunker {
  private buf = '';
  private emitted = 0;

  constructor(
    private readonly minChars = 40,
    private readonly maxChars = 280,
  ) {}

  push(delta: string): string[] {
    this.buf += delta;
    const out: string[] = [];
    for (;;) {
      const cut = this.findCut();
      if (cut < 0) break;
      const piece = this.buf.slice(0, cut).trim();
      this.buf = this.buf.slice(cut);
      if (piece) {
        out.push(piece);
        this.emitted++;
      }
    }
    return out;
  }

  /** Whatever is left once the agent is done. */
  flush(): string | null {
    const rest = this.buf.trim();
    this.buf = '';
    if (!rest) return null;
    this.emitted++;
    return rest;
  }

  private findCut(): number {
    const min = this.emitted === 0 ? 6 : this.minChars;
    // Sentence end: . ! ? (optionally followed by quotes/brackets) then whitespace, or a line break.
    const re = /([.!?…]["')\]]*)\s+|\n+/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(this.buf))) {
      const end = m.index + m[0].length;
      const sentence = this.buf.slice(0, m.index + (m[1]?.length ?? 0));
      if (m[1] && /\b(e\.g|i\.e|etc|vs|mr|mrs|ms|dr|st|no)\.$/i.test(sentence)) continue;
      if (sentence.trim().length >= min) return end;
    }
    if (this.buf.length > this.maxChars) {
      // Long run with no sentence end: break at the last comma or space.
      const window = this.buf.slice(0, this.maxChars);
      const at = Math.max(window.lastIndexOf(', '), window.lastIndexOf('; '));
      if (at > min) return at + 2;
      const space = window.lastIndexOf(' ');
      if (space > min) return space + 1;
    }
    return -1;
  }
}
