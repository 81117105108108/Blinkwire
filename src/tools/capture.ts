import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import type { ToolDef, CallResult } from '../core/types.js';
import type { ConsoleEntry, NetworkEntry } from '../cdp/session.js';
import { STATIC_TYPES } from '../cdp/session.js';
import { text } from '../core/types.js';
import { BlinkwireError } from '../core/errors.js';
import { screenshot } from '../core/image.js';

const MIME: Record<string, string> = { png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp' };
const LEVEL_RANK: Record<string, number> = { error: 0, warning: 1, info: 2, debug: 3 };

async function save(outputDir: string, filename: string, buf: Buffer): Promise<string> {
  await fs.mkdir(outputDir, { recursive: true });
  const file = path.isAbsolute(filename) ? filename : path.join(outputDir, filename);
  await fs.writeFile(file, buf);
  return pathToFileURL(file).href;
}

function filteredNetwork(all: readonly NetworkEntry[], includeStatic: boolean, filter?: string): NetworkEntry[] {
  let rx: RegExp | undefined;
  if (filter) {
    try {
      rx = new RegExp(filter, 'i');
    } catch {
      throw new BlinkwireError(`Invalid regular expression: ${filter}`, 'bad_arguments');
    }
  }
  return all.filter((e) => {
    if (!includeStatic && e.type && STATIC_TYPES.has(e.type)) return false;
    if (rx && !rx.test(e.url)) return false;
    return true;
  });
}

export const tools: ToolDef[] = [
  {
    name: 'take_screenshot',
    title: 'Take a screenshot',
    description:
      'Capture the page as an image. Screenshots cost a lot of context — prefer browser_snapshot, and use this only when you need to see pixels.',
    params: {
      target: { type: 'string', description: 'Element ref or CSS selector to clip to (default: the viewport)' },
      type: { type: 'string', enum: ['png', 'jpeg', 'webp'], description: 'Image format (default png)' },
      filename: { type: 'string', description: 'Save to this file instead of returning the image' },
      fullPage: { type: 'boolean', description: 'Capture the full scrollable page instead of the viewport' },
      quality: { type: 'number', description: 'JPEG/WebP quality 0-100' },
      scale: { type: 'string', enum: ['css', 'device'], description: 'css (default) = CSS pixels; device = full device resolution' },
      maxWidth: { type: 'integer', description: 'Downscale so the image is at most this many CSS pixels wide' },
    },
    readOnly: true,
    async handler(args, ctx): Promise<CallResult> {
      const format = (args.type as 'png' | 'jpeg' | 'webp' | undefined) ?? 'png';
      const shot = await screenshot(ctx.session, {
        format,
        quality: args.quality as number | undefined,
        fullPage: args.fullPage === true,
        target: args.target as string | undefined,
        scale: (args.scale as 'css' | 'device' | undefined) ?? 'css',
        maxWidth: args.maxWidth as number | undefined,
        resolveBox: async (t) => ctx.refs.box(t),
      });
      const info = `${shot.width}x${shot.height}, ${shot.bytes} bytes`;

      if (args.filename) {
        const uri = await save(ctx.cfg.outputDir, args.filename as string, Buffer.from(shot.data, 'base64'));
        return { kind: 'resource', uri, mime: shot.mime, text: `Saved ${info} to ${uri}` };
      }
      if (ctx.cfg.imageResponses === 'omit') {
        return text(`Screenshot omitted (image-responses=omit). ${info}`, { width: shot.width, height: shot.height });
      }
      return { kind: 'image', mime: shot.mime ?? MIME[format]!, data: shot.data, text: info };
    },
  },
  {
    name: 'pdf_save',
    title: 'Save as PDF',
    description: 'Print the current page to a PDF file.',
    params: {
      filename: { type: 'string', description: 'Output file name (default page.pdf)', default: 'page.pdf' },
      landscape: { type: 'boolean', description: 'Landscape orientation' },
      format: { type: 'string', description: 'Paper format, e.g. Letter, A4', default: 'Letter' },
      printBackground: { type: 'boolean', description: 'Print background graphics', default: true },
      scale: { type: 'number', description: 'Scale factor (default 1)', default: 1 },
    },
    readOnly: true,
    async handler(args, ctx): Promise<CallResult> {
      await ctx.session.ensure('Page');
      const r = await ctx.session.cdp.send<{ data: string }>('Page.printToPDF', {
        landscape: args.landscape === true,
        printBackground: args.printBackground !== false,
        paperWidth: undefined,
        scale: (args.scale as number | undefined) ?? 1,
        ...(args.format ? { paperFormat: args.format } : {}),
      });
      const uri = await save(ctx.cfg.outputDir, (args.filename as string) ?? 'page.pdf', Buffer.from(r.data, 'base64'));
      return { kind: 'resource', uri, mime: 'application/pdf', text: `Saved PDF to ${uri}` };
    },
  },
  {
    name: 'console_messages',
    title: 'Get console messages',
    description: 'Return console output captured since the last navigation. Filter by level or regex to keep it short.',
    params: {
      level: { type: 'string', enum: ['error', 'warning', 'info', 'debug'], description: 'Minimum severity (default from config)' },
      all: { type: 'boolean', description: 'Include messages from before the last navigation' },
      filter: { type: 'string', description: 'Only return messages matching this regex' },
    },
    readOnly: true,
    async handler(args, ctx): Promise<CallResult> {
      const wanted = (args.level as string | undefined) ?? ctx.cfg.consoleLevel;
      const max = LEVEL_RANK[wanted] ?? LEVEL_RANK.info!;
      let rx: RegExp | undefined;
      if (args.filter) {
        try {
          rx = new RegExp(args.filter as string, 'i');
        } catch {
          throw new BlinkwireError(`Invalid regular expression: ${args.filter}`, 'bad_arguments');
        }
      }
      let entries: ConsoleEntry[] = ctx.session.buffers.console.all();
      // Default: only what the current page produced. all:true widens to the whole session.
      if (args.all !== true) {
        const nav = ctx.session.buffers.navSeq;
        entries = entries.filter((e) => e.nav === nav);
      }
      entries = entries.filter((e) => (LEVEL_RANK[e.level] ?? 2) <= max && (!rx || rx.test(e.text)));
      if (entries.length > 200) entries = entries.slice(-200);
      if (entries.length === 0) return text('(no console messages)');
      const body = entries.map((e) => `[${e.level}] ${e.text}${e.url ? `  (${e.url}${e.line !== undefined ? `:${e.line + 1}` : ''})` : ''}`);
      return text(ctx.budget.clamp(body.join('\n')), { count: entries.length });
    },
  },
  {
    name: 'network_requests',
    title: 'List network requests',
    description:
      'List requests made since the page loaded. Off by default — restart with --network-capture if you need it (the Network domain is expensive).',
    params: {
      static: { type: 'boolean', description: 'Include images, fonts, scripts and other static resources (default false)' },
      filter: { type: 'string', description: 'Only return requests whose URL matches this regex' },
      limit: { type: 'integer', description: 'Maximum number of requests to list (default 100)', default: 100 },
    },
    readOnly: true,
    async handler(args, ctx): Promise<CallResult> {
      if (!ctx.session.hasDomain('Network')) {
        return text(
          'Network capture is OFF. Blinkwire leaves the Network domain disabled because it slows every navigation down.\n' +
            'Restart the server with --network-capture to enable it.',
        );
      }
      const all = ctx.session.buffers.network.all();
      const list = filteredNetwork(all, args.static === true, args.filter as string | undefined);
      const limit = (args.limit as number | undefined) ?? 100;
      const shown = list.slice(-limit);
      if (shown.length === 0) return text('(no matching requests)');
      const base = list.length - shown.length;
      const body = shown.map(
        (e, i) =>
          `[${base + i + 1}] ${e.method} ${e.status ?? (e.failed ? 'FAILED' : '…')} ${e.url}` +
          `${e.type ? ` (${e.type}${e.size !== undefined ? `, ${e.size}B` : ''})` : ''}`,
      );
      return text(ctx.budget.clamp(body.join('\n')), { count: shown.length });
    },
  },
  {
    name: 'network_request',
    title: 'Show network request details',
    description: 'Show the headers and body of a single request, by the number printed by browser_network_requests.',
    params: {
      index: { type: 'integer', description: '1-based index from browser_network_requests', required: true },
      part: { type: 'string', enum: ['request', 'response', 'body'], description: 'Return only this part' },
    },
    readOnly: true,
    async handler(args, ctx): Promise<CallResult> {
      if (!ctx.session.hasDomain('Network')) {
        throw new BlinkwireError('Network capture is off.', 'network_off', 'Restart with --network-capture.');
      }
      const all = ctx.session.buffers.network.all();
      const list = filteredNetwork(all, true, undefined);
      const idx = (args.index as number) - 1;
      const e = list[idx];
      if (!e) throw new BlinkwireError(`No request with index ${args.index}.`, 'bad_arguments');

      let body = '';
      try {
        const r = await ctx.session.cdp.send<{ body: string; base64Encoded: boolean }>('Network.getResponseBody', { requestId: e.requestId });
        body = r.body.slice(0, 20_000);
      } catch {
        body = '(body unavailable — the response may have been evicted)';
      }
      const head = `${e.method} ${e.url}\nstatus: ${e.status ?? (e.failed ? 'failed' : 'pending')}  type: ${e.type ?? '?'}  size: ${e.size ?? '?'}`;
      const want = (args.part as string | undefined) ?? 'body';
      const out = want === 'request' ? head : want === 'response' ? `${head}\n\n${body}` : `${head}\n\n${body}`;
      return text(ctx.budget.clamp(out), { url: e.url, status: e.status ?? null });
    },
  },
  {
    name: 'evaluate',
    title: 'Evaluate JavaScript',
    description:
      'Run JavaScript in the page. Pass an arrow function as a string: "() => document.title". With target, the function receives the element.',
    params: {
      function: { type: 'string', description: '() => { /* code */ } or (el) => { /* code */ } when target is given', required: true },
      target: { type: 'string', description: 'Element ref or CSS selector to pass to the function' },
      filename: { type: 'string', description: 'Save the result to this file instead of returning it' },
    },
    async handler(args, ctx): Promise<CallResult> {
      const fn = args.function as string;
      let value: unknown;
      if (args.target) {
        const oid = await ctx.refs.objectId(args.target as string);
        value = await ctx.session.evalOn(oid, fn, undefined, { awaitPromise: true });
      } else {
        value = await ctx.session.eval(fn, undefined, { awaitPromise: true });
      }
      let out: string;
      if (value === undefined) out = 'undefined';
      else if (typeof value === 'string') out = value;
      else {
        try {
          out = JSON.stringify(value, null, 2) ?? String(value);
        } catch {
          out = String(value);
        }
      }
      if (out.length > 20_000) out = `${out.slice(0, 20_000)}\n… [truncated]`;
      if (args.filename) {
        const uri = await save(ctx.cfg.outputDir, args.filename as string, Buffer.from(out, 'utf8'));
        return { kind: 'resource', uri, mime: 'application/json', text: `Saved result to ${uri}` };
      }
      return text(ctx.budget.clamp(out));
    },
  },
];
