import type { PageSession } from '../cdp/session.js';
import { BlinkwireError } from './errors.js';
import { ensureInjected, REF_EXPR } from './inject.js';

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
  cx: number;
  cy: number;
  visible: boolean;
  inViewport: boolean;
  scrolled: boolean;
}

export interface RefEntryLite {
  id: string;
  tag?: string;
}

/** Accepts `e4`, `ref=e4`, `@e4`, or any CSS selector. */
export function parseRef(target: string): string | undefined {
  const m = /^(?:ref=|@)?(e\d+)$/i.exec(target.trim());
  return m ? m[1]!.toLowerCase() : undefined;
}

export class RefStore {
  private tags = new Map<string, string>();
  private navSeqAtReset = -1;

  constructor(private readonly session: PageSession) {}

  reset(entries: RefEntryLite[]): void {
    this.tags.clear();
    for (const e of entries) this.tags.set(e.id, e.tag ?? '');
    this.navSeqAtReset = this.session.buffers.navSeq;
  }

  ids(): string[] {
    return [...this.tags.keys()];
  }

  get size(): number {
    return this.tags.size;
  }

  has(id: string): boolean {
    return this.tags.has(id);
  }

  private assertFresh(): void {
    if (this.tags.size === 0) {
      throw new BlinkwireError(
        'No element refs yet — call browser_snapshot first.',
        'no_refs',
        'Refs come from the latest snapshot. Call browser_snapshot, then use e.g. "e4".',
      );
    }
    if (this.navSeqAtReset !== this.session.buffers.navSeq) {
      throw new BlinkwireError(
        'Element refs are stale (the page navigated).',
        'stale_refs',
        'Call browser_snapshot again to get fresh refs.',
      );
    }
  }

  /** Validates a ref id against the current snapshot. */
  check(target: string): string | undefined {
    const id = parseRef(target);
    if (!id) return undefined;
    this.assertFresh();
    if (!this.tags.has(id)) {
      throw new BlinkwireError(
        `Ref "${id}" is not in the current snapshot.`,
        'stale_refs',
        `Known refs: ${this.ids().slice(0, 40).join(', ') || '(none)'}. Call browser_snapshot again.`,
      );
    }
    return id;
  }

  /** Live objectId for Runtime.callFunctionOn. One call for refs. */
  async objectId(target: string): Promise<string> {
    await ensureInjected(this.session);
    const id = this.check(target);
    if (id) {
      const r = await this.session.cdp.send<{ result: { objectId?: string; value?: unknown } }>('Runtime.evaluate', {
        expression: REF_EXPR(id),
        returnByValue: false,
      });
      if (!r.result?.objectId) {
        throw new BlinkwireError(`Ref ${id} no longer exists in the page.`, 'stale_refs', 'Call browser_snapshot again.');
      }
      return r.result.objectId;
    }
    return this.session.queryObjectId(target);
  }

  /**
   * Geometry in ONE round-trip for refs (no DOM domain, no objectId round-trip).
   * Scrolls into view and returns viewport-relative CSS pixels.
   */
  async box(target: string, opts?: { scroll?: boolean; requireVisible?: boolean }): Promise<Box> {
    await ensureInjected(this.session);
    const id = this.check(target);
    const scroll = opts?.scroll !== false;
    let b: Box | null;
    if (id) {
      b = await this.session.eval<Box | null>(
        `(function(a){ var el = window.__bw.els[${JSON.stringify(id)}]; return window.__bw.box(el, ${scroll}); })`,
        undefined,
        { awaitPromise: false },
      );
      if (!b) throw new BlinkwireError(`Ref ${id} no longer exists in the page.`, 'stale_refs', 'Call browser_snapshot again.');
    } else {
      const objectId = await this.session.queryObjectId(target);
      b = await this.session.evalOn<Box | null>(objectId, function (el: any, arg: any) {
        return (window as any).__bw.box(el, arg.scroll);
      }, { scroll }, { awaitPromise: false });
      if (!b) throw new BlinkwireError(`Could not measure ${target}.`, 'no_element');
    }
    if (opts?.requireVisible !== false && !b.visible) {
      throw new BlinkwireError(
        `Element ${target} is not visible.`,
        'not_visible',
        'Scroll to it first, or pick a different element from browser_snapshot.',
      );
    }
    return b;
  }
}
