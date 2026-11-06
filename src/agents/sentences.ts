/**
 * Splits streaming LLM text into speakable chunks, so text-to-speech can start on the first
 * sentence while the rest is still being generated.
 */
export class SentenceChunker {
  private buf = "";
  constructor(private minChars = 12) {}

  push(delta: string): string[] {
    this.buf += delta;
    const out: string[] = [];
    // Sentence end: . ! ? (optionally followed by quotes/brackets) then whitespace.
    const re = /[.!?]+["')\]]*\s+/g;
    let last = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(this.buf))) {
      const end = m.index + m[0].length;
      const candidate = this.buf.slice(last, end).trim();
      // Avoid splitting on "Dr. " / "3.5" style short fragments.
      if (candidate.length >= this.minChars && !/\b(?:Mr|Mrs|Ms|Dr|St|Jr|Sr|vs|etc|e\.g|i\.e)\.$/i.test(candidate)) {
        out.push(candidate);
        last = end;
      }
    }
    this.buf = this.buf.slice(last);
    // Very long clause with no punctuation: break at a comma to keep latency low.
    if (this.buf.length > 160) {
      const i = this.buf.lastIndexOf(", ");
      if (i > 40) {
        out.push(this.buf.slice(0, i + 1).trim());
        this.buf = this.buf.slice(i + 2);
      }
    }
    return out;
  }

  flush(): string | null {
    const rest = this.buf.trim();
    this.buf = "";
    return rest || null;
  }
}
