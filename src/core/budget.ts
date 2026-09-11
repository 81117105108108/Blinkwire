/** Hard cap on tokens returned to the LLM. Blinkwire's context discipline lives here. */

export function estimateTokens(text: string): number {
  if (!text) return 0;

  const cjkMatches =
    text.match(/[\u3000-\u303f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g) ?? [];

  const cjkCount = cjkMatches.length;
  const restCount = text.length - cjkCount;

  return Math.ceil(cjkCount / 1.5 + restCount / 4);
}

export interface TokenEstimator {
  estimate(text: string): number;
}

export class HeuristicTokenEstimator implements TokenEstimator {
  estimate(text: string): number {
    return estimateTokens(text);
  }
}

export class Budget {
  constructor(private readonly max: number) {}

  get maxTokens(): number {
    return this.max;
  }

  /** CJK-aware heuristic. No tokenizer, no deps. Inject a TokenEstimator for exact counts. */
  static estimate(s: string): number {
    return estimateTokens(s);
  }

  fits(s: string): boolean {
    return Budget.estimate(s) <= this.max;
  }

  clamp(s: string, note?: string): string {
    if (this.fits(s)) return s;
    const maxChars = Math.max(200, Math.floor(this.max * 4));
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
