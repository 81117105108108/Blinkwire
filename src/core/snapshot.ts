import type { PageSession } from '../cdp/session.js';
import { ensureInjected } from './inject.js';
import { SNAPSHOT_FN_SRC } from './inpage-snapshot.js';
import type { SnapshotMode } from '../config.js';

export interface SnapshotOpts {
  mode?: SnapshotMode;
  depth?: number;
  boxes?: boolean;
  maxNodes?: number;
  selector?: string;
}

export interface SnapshotStats {
  nodes: number;
  refs: number;
  truncated: boolean;
  ms: number;
}

export interface RefEntryLite {
  id: string;
  tag?: string;
}

export interface SnapshotResult {
  text: string;
  hash: string;
  stats: SnapshotStats;
  entries: RefEntryLite[];
  url: string;
  title: string;
}

interface InpageResult {
  lines: string[];
  refs: RefEntryLite[];
  url: string;
  title: string;
  truncated: boolean;
  total: number;
}

export function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/**
 * One Runtime.evaluate. Returns a rendered, depth-limited, ref-tagged tree.
 * `interactive` (default) keeps landmarks, headings and interactive nodes —
 * typically 60-80% fewer tokens than a full accessibility dump.
 */
export async function takeSnapshot(session: PageSession, opts: SnapshotOpts = {}): Promise<SnapshotResult> {
  await ensureInjected(session);
  const t0 = Date.now();
  const r = await session.eval<InpageResult>(
    SNAPSHOT_FN_SRC,
    {
      mode: opts.mode ?? 'interactive',
      depth: opts.depth ?? 0,
      boxes: opts.boxes ?? false,
      maxNodes: opts.maxNodes ?? 1200,
      selector: opts.selector ?? null,
    },
    { awaitPromise: false },
  );
  const ms = Date.now() - t0;
  const lines = r?.lines ?? [];
  const url = r?.url ?? '';
  const title = r?.title ?? '';
  const header = `# ${url}${title ? ` — ${JSON.stringify(title)}` : ''}`;
  const body = lines.join('\n');
  const text = body ? `${header}\n${body}` : `${header}\n(empty)`;
  return {
    text,
    hash: fnv1a(text),
    stats: { nodes: lines.length, refs: r?.refs?.length ?? 0, truncated: !!r?.truncated, ms },
    entries: r?.refs ?? [],
    url,
    title,
  };
}
