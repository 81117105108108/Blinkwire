import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import type { ToolDef } from '../core/types.js';
import { text } from '../core/types.js';
import { BlinkwireError } from '../core/errors.js';
import { settle, waitForText } from '../core/wait.js';
import { sleep } from '../core/log.js';

function normaliseUrl(raw: string): string {
  const u = raw.trim();
  if (!u) throw new BlinkwireError('No URL given.', 'bad_arguments');
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(u)) return u;
  if (/^(about|data|file|chrome|view-source):/i.test(u)) return u;
  return `https://${u}`;
}

export const tools: ToolDef[] = [
  {
    name: 'navigate',
    title: 'Navigate to a URL',
    description:
      'Navigate to a URL and wait for the page to settle. Resolves on the load event (or the SPA history event) instead of a fixed sleep.',
    params: {
      url: { type: 'string', description: 'The URL to navigate to', required: true },
    },
    async handler(args, ctx) {
      const url = normaliseUrl(args.url as string);
      const s = ctx.session;
      await s.ensure('Page');

      const t0 = Date.now();
      const loaded = Promise.race([
        s.cdp.onceFor('Page.loadEventFired', () => true, ctx.cfg.timeoutNavigation).catch(() => 'timeout'),
        s.cdp.onceFor('Page.navigatedWithinDocument', () => true, ctx.cfg.timeoutNavigation).catch(() => 'timeout'),
        sleep(1200).then(() => 'grace'),
      ]);
      await s.cdp.send('Page.navigate', { url });
      await loaded;
      const rep = await settle(s, ctx.cfg.timeoutSettle);

      return text(`Navigated to ${await s.url()}\ntitle: ${await s.title()}\nsettled: ${rep.settled ? 'yes' : 'timeout'} in ${Date.now() - t0}ms`, {
        url,
        ms: Date.now() - t0,
      });
    },
  },
  {
    name: 'navigate_back',
    title: 'Go back',
    description: 'Go back to the previous page in the history.',
    async handler(_args, ctx) {
      return step(ctx, -1);
    },
  },
  {
    name: 'navigate_forward',
    title: 'Go forward',
    description: 'Go forward to the next page in the history.',
    async handler(_args, ctx) {
      return step(ctx, 1);
    },
  },
  {
    name: 'reload',
    title: 'Reload the page',
    description: 'Reload the current page.',
    params: {
      ignoreCache: { type: 'boolean', description: 'Bypass the cache when reloading' },
    },
    async handler(args, ctx) {
      const s = ctx.session;
      await s.ensure('Page');
      const loaded = s.cdp.onceFor('Page.loadEventFired', () => true, ctx.cfg.timeoutNavigation).catch(() => 'timeout');
      await s.cdp.send('Page.reload', { ignoreCache: args.ignoreCache === true });
      await loaded;
      const rep = await settle(s, ctx.cfg.timeoutSettle);
      return text(`Reloaded ${await s.url()} — settled in ${rep.ms}ms`, { ms: rep.ms });
    },
  },
  {
    name: 'wait_for',
    title: 'Wait for',
    description:
      'Wait for text to appear or disappear, or for a fixed time. Uses a MutationObserver, so it returns the instant the text shows up.',
    params: {
      time: { type: 'number', description: 'The time to wait in seconds' },
      text: { type: 'string', description: 'The text to wait for' },
      textGone: { type: 'string', description: 'The text to wait for to disappear' },
      timeout: { type: 'number', description: 'Timeout in seconds when waiting for text (default 10)' },
    },
    async handler(args, ctx) {
      const secs = args.time as number | undefined;
      const want = args.text as string | undefined;
      const gone = args.textGone as string | undefined;
      if (secs === undefined && !want && !gone) {
        throw new BlinkwireError('Pass one of time, text or textGone.', 'bad_arguments');
      }
      if (secs !== undefined) {
        await sleep(secs * 1000);
        return text(`Waited ${secs}s.`, { ms: Math.round(secs * 1000) });
      }
      const r = await waitForText(ctx.session, (want ?? gone)!, {
        gone: !!gone,
        timeoutMs: ((args.timeout as number | undefined) ?? 10) * 1000,
      });
      const label = gone ? `text gone: ${gone}` : `text: ${want}`;
      return text(r.ok ? `${label} — matched in ${r.ms}ms` : `${label} — timed out after ${r.ms}ms`, { ok: r.ok, ms: r.ms });
    },
  },
];

async function step(ctx: Parameters<ToolDef['handler']>[1], delta: number) {
  const s = ctx.session;
  await s.ensure('Page');
  const { currentIndex, entries } = await s.cdp.send<{ currentIndex: number; entries: Array<{ id: number; url: string }> }>(
    'Page.getNavigationHistory',
  );
  const next = currentIndex + delta;
  if (next < 0 || next >= entries.length) {
    return text(delta < 0 ? 'Already at the beginning of the history.' : 'Already at the end of the history.');
  }
  const loaded = Promise.race([
    s.cdp.onceFor('Page.loadEventFired', () => true, ctx.cfg.timeoutNavigation).catch(() => 'timeout'),
    s.cdp.onceFor('Page.navigatedWithinDocument', () => true, ctx.cfg.timeoutNavigation).catch(() => 'timeout'),
    sleep(1200).then(() => 'grace'),
  ]);
  await s.cdp.send('Page.navigateToHistoryEntry', { entryId: entries[next]!.id });
  await loaded;
  const rep = await settle(s, ctx.cfg.timeoutSettle);
  return text(`Now at ${await s.url()} — settled in ${rep.ms}ms`, { ms: rep.ms });
}

export async function writeOutput(cfg: { outputDir: string }, filename: string, data: string): Promise<string> {
  await fs.mkdir(cfg.outputDir, { recursive: true });
  const file = path.isAbsolute(filename) ? filename : path.join(cfg.outputDir, filename);
  await fs.writeFile(file, data, 'utf8');
  return pathToFileURL(file).href;
}
