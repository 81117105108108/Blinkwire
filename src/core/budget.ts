/** Hard cap on tokens returned to the LLM. Blinkwire's context discipline lives here. */
export class Budget {
  constructor(private readonly max: number) {}

  get maxTokens(): number {
    return this.max;
  }

  /** Cheap, good-enough token estimate. No tokenizer, no deps. */
  static estimate(s: string): number {
    return Math.ceil(s.length / 3.7);
  }

  fits(s: string): boolean {
    return Budget.estimate(s) <= this.max;
  }

  clamp(s: string, note?: string): string {
    if (this.fits(s)) return s;
    const maxChars = Math.max(200, Math.floor(this.max * 3.7));
    const cut = s.slice(0, maxChars);
    const nl = cut.lastIndexOf('\n');
    const body = nl > maxChars * 0.5 ? cut.slice(0, nl) : cut;
    const dropped = s.length - body.length;
    const tail =
      note ??
      `\n… [truncated ${dropped} chars — narrow with browser_find, or browser_snapshot target=<selector> depth=<n>]`;
    return body + tail;
  }
}
