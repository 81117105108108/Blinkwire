import type { ToolDef, CallResult } from '../core/types.js';
import type { PageSession } from '../cdp/session.js';
import type { SnapshotResult } from '../core/snapshot.js';
import { text } from '../core/types.js';
import { BlinkwireError } from '../core/errors.js';
import { takeSnapshot } from '../core/snapshot.js';
import { diffText } from '../core/diff.js';
import { writeOutput } from './navigation.js';

const last = new WeakMap<PageSession, SnapshotResult>();

function parseRegex(raw: string): RegExp {
  const m = /^\/(.*)\/([gimsuy]*)$/.exec(raw.trim());
  try {
    return m ? new RegExp(m[1]!, m[2] || 'i') : new RegExp(raw, 'i');
  } catch {
    throw new BlinkwireError(`Invalid regular expression: ${raw}`, 'bad_arguments');
  }
}

export const tools: ToolDef[] = [
  {
    name: 'snapshot',
    title: 'Page snapshot',
    description:
      'Capture a compact, ref-tagged snapshot of the page. This is the primary way to read a page — cheaper and more reliable than a screenshot. Refs ([ref=eN]) are what you pass to click/type/hover.',
    params: {
      target: { type: 'string', description: 'Limit the snapshot to this CSS selector (or a ref from a previous snapshot)' },
      depth: { type: 'integer', description: 'Limit the depth of the snapshot tree' },
      boxes: { type: 'boolean', description: 'Include each element\'s bounding box as [box=x,y,w,h] in CSS pixels' },
      mode: {
        type: 'string',
        enum: ['interactive', 'full', 'minimal'],
        description: 'interactive (default) = landmarks + headings + controls; full = everything; minimal = flat list of controls',
      },
      filename: { type: 'string', description: 'Save the snapshot to this file instead of returning it' },
    },
    readOnly: true,
    async handler(args, ctx): Promise<CallResult> {
      const result = await takeSnapshot(ctx.session, {
        mode: (args.mode as 'interactive' | 'full' | 'minimal' | undefined) ?? ctx.cfg.snapshotMode,
        depth: args.depth as number | undefined,
        boxes: (args.boxes as boolean | undefined) ?? ctx.cfg.snapshotBoxes,
        selector: args.target as string | undefined,
      });
      ctx.refs.reset(result.entries);
      last.set(ctx.session, result);

      if (args.filename) {
        const uri = await writeOutput(ctx.cfg, args.filename as string, result.text);
        return { kind: 'resource', uri, mime: 'text/plain', text: `Saved snapshot (${result.stats.nodes} nodes) to ${uri}` };
      }

      const clamped = ctx.budget.clamp(result.text);
      const stats = `\n— ${result.stats.refs} refs, ${result.stats.nodes} nodes, ${result.stats.ms}ms${result.stats.truncated ? ' (truncated)' : ''}`;
      return text(clamped + stats, {
        refs: result.stats.refs,
        nodes: result.stats.nodes,
        ms: result.stats.ms,
        truncated: result.stats.truncated,
        hash: result.hash,
      });
    },
  },
  {
    name: 'find',
    title: 'Find in page snapshot',
    description:
      'Search the current snapshot for text or a regex and return matching lines with their refs. Far cheaper than re-reading the whole snapshot when you only need to locate one element.',
    params: {
      text: { type: 'string', description: 'Plain text to search for (case-insensitive substring). Provide either text or regex.' },
      regex: { type: 'string', description: 'Regular expression, e.g. "error" or "/log(in|out)/i". Provide either text or regex.' },
      context: { type: 'integer', description: 'Lines of context around each match (default 2)', default: 2 },
    },
    readOnly: true,
    async handler(args, ctx): Promise<CallResult> {
      const needle = args.text as string | undefined;
      const re = args.regex as string | undefined;
      if (!needle && !re) throw new BlinkwireError('Provide either text or regex.', 'bad_arguments');
      const ctxLines = (args.context as number | undefined) ?? 2;

      let result = last.get(ctx.session);
      if (!result || result.url !== (await ctx.session.url())) {
        result = await takeSnapshot(ctx.session, { mode: 'full' });
        ctx.refs.reset(result.entries);
        last.set(ctx.session, result);
      }

      const lines = result.text.split('\n');
      const rx = re ? parseRegex(re) : undefined;
      const hits: number[] = [];
      for (let i = 0; i < lines.length; i++) {
        const l = lines[i]!;
        const hit = rx ? rx.test(l) : l.toLowerCase().includes(needle!.toLowerCase());
        if (hit) hits.push(i);
      }
      if (hits.length === 0) {
        return text(`No matches for ${rx ? `regex ${re}` : JSON.stringify(needle)}.`);
      }

      const cap = 40;
      const shown = hits.slice(0, cap);
      const keep = new Set<number>();
      for (const h of shown) {
        for (let k = Math.max(0, h - ctxLines); k <= Math.min(lines.length - 1, h + ctxLines); k++) keep.add(k);
      }

      const out: string[] = [];
      let skipped = 0;
      for (let i = 0; i < lines.length; i++) {
        if (!keep.has(i)) {
          skipped++;
          continue;
        }
        if (skipped > 0) {
          out.push(`… ${skipped} lines`);
          skipped = 0;
        }
        out.push(`${shown.includes(i) ? '>' : ' '} ${lines[i]}`);
      }
      if (skipped > 0) out.push(`… ${skipped} lines`);

      const refs = new Set<string>();
      for (const h of shown) {
        for (const m of lines[h]!.matchAll(/\[ref=(e\d+)\]/g)) refs.add(m[1]!);
      }
      const head = `${shown.length} match${shown.length === 1 ? '' : 'es'}${hits.length > cap ? ` (of ${hits.length})` : ''}\n`;
      const tail = refs.size ? `\nrefs: ${[...refs].join(', ')}` : '';
      return text(ctx.budget.clamp(head + out.join('\n') + tail), { matches: shown.length, refs: [...refs] });
    },
  },
  {
    name: 'snapshot_diff',
    title: 'Diff snapshots',
    description:
      'Show only what changed since the last snapshot. The cheapest way to check the effect of an action — usually a handful of lines instead of a whole tree.',
    params: {
      contextLines: { type: 'integer', description: 'Unchanged lines to show around each change (default 2)', default: 2 },
    },
    readOnly: true,
    async handler(args, ctx): Promise<CallResult> {
      const prev = last.get(ctx.session);
      const next = await takeSnapshot(ctx.session, { mode: ctx.cfg.snapshotMode });
      ctx.refs.reset(next.entries);
      last.set(ctx.session, next);
      if (!prev) return text(next.text);

      const delta = diffText(prev.text, next.text, (args.contextLines as number | undefined) ?? 2);
      if (!delta.trim() || !/[+-]/.test(delta)) return text('No changes.', { hash: next.hash });
      return text(ctx.budget.clamp(delta), { hash: next.hash });
    },
  },
];
