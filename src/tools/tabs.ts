import type { ToolDef, CallResult } from '../core/types.js';
import type { BrowserConnection } from '../cdp/connection.js';
import { text } from '../core/types.js';
import { BlinkwireError } from '../core/errors.js';
import { debug } from '../core/log.js';

/**
 * `browser_connect` can swap the live connection at runtime. The server drains
 * this slot after every call so the next tool uses the new browser.
 */
let override: BrowserConnection | undefined;

export function setOverride(c: BrowserConnection): void {
  override = c;
}

export function takeOverride(): BrowserConnection | undefined {
  const o = override;
  override = undefined;
  return o;
}

const tools: ToolDef[] = [
  {
    name: 'tabs',
    title: 'Manage tabs',
    description:
      'List, create, close or select a browser tab. Prefer select over new when a matching tab already exists.',
    params: {
      action: { type: 'string', enum: ['list', 'new', 'close', 'select'], description: 'Operation to perform', required: true },
      index: { type: 'integer', description: 'Tab index, used for close/select. If omitted for close, the current tab is closed.' },
      url: { type: 'string', description: 'URL to open in the new tab (action=new), or a URL substring to match (action=select).' },
      title: { type: 'string', description: 'Title substring to match (action=select).' },
    },
    async handler(args, ctx): Promise<CallResult> {
      const action = args.action as string;
      if (action === 'list') {
        const list = await ctx.conn.targets('page');
        if (list.length === 0) return text('(no page targets)');
        const cur = ctx.session.targetId;
        return text(
          list.map((t, i) => `${t.id === cur ? '*' : ' '} [${i}] ${t.title || '(untitled)'} — ${t.url}`).join('\n'),
          { tabs: list.length },
        );
      }
      if (action === 'new') {
        const ps = await ctx.conn.newTab((args.url as string) ?? 'about:blank');
        return text(`Opened a new tab${args.url ? ` at ${args.url}` : ''}.`, { targetId: ps.targetId });
      }
      if (action === 'close') {
        const id =
          typeof args.index === 'number'
            ? (await ctx.conn.targets('page'))[args.index as number]?.id
            : ctx.session.targetId;
        if (!id) throw new BlinkwireError('No tab to close.', 'no_target');
        await ctx.conn.closeTab(id);
        return text('Closed the tab.');
      }
      const ps = await ctx.conn.select({
        url: args.url as string | undefined,
        title: args.title as string | undefined,
        index: typeof args.index === 'number' ? (args.index as number) : undefined,
      });
      return text(`Selected tab ${await ps.url()}`, { targetId: ps.targetId });
    },
  },
  {
    name: 'close',
    title: 'Close the current tab',
    description: 'Close the current tab. The browser itself is left running — Blinkwire does not own it.',
    destructive: true,
    async handler(_args, ctx): Promise<CallResult> {
      const url = await ctx.session.url();
      await ctx.session.close();
      return text(`Closed tab ${url}`);
    },
  },
  {
    name: 'resize',
    title: 'Resize browser window',
    description:
      'Resize the browser window. Uses the real window bounds when a browser-level CDP connection is available, otherwise emulates the viewport.',
    params: {
      width: { type: 'number', description: 'Width in pixels', required: true, min: 200 },
      height: { type: 'number', description: 'Height in pixels', required: true, min: 200 },
    },
    async handler(args, ctx): Promise<CallResult> {
      const w = Math.round(args.width as number);
      const h = Math.round(args.height as number);
      try {
        const b = await ctx.conn.ensureBrowser();
        const { windowId } = await b.send<{ windowId: number }>('Browser.getWindowForTarget', { targetId: ctx.session.targetId });
        await b.send('Browser.setWindowBounds', { windowId, bounds: { width: w, height: h, windowState: 'normal' } });
        return text(`Resized the window to ${w}x${h}.`, { path: 'window' });
      } catch (e) {
        debug('window resize fell back to emulation:', e);
        await ctx.session.ensure('Emulation');
        await ctx.session.cdp.send('Emulation.setDeviceMetricsOverride', {
          width: w,
          height: h,
          deviceScaleFactor: 1,
          mobile: false,
        });
        return text(`Emulated a ${w}x${h} viewport (real window bounds unavailable).`, { path: 'emulation' });
      }
    },
  },
  {
    name: 'connect',
    title: 'Connect to a browser over CDP',
    description:
      'Attach Blinkwire to a Chrome instance. With no arguments it auto-discovers the running Chrome (configured port, then any debuggable instance it finds). Use this to switch browsers or tabs without restarting the server — never start a browser yourself.',
    params: {
      cdpEndpoint: { type: 'string', description: 'Base URL of the CDP endpoint, e.g. http://127.0.0.1:9222' },
      host: { type: 'string', description: 'Host to connect to (default 127.0.0.1)' },
      port: { type: 'integer', description: 'Debugging port (default 9222)' },
      matchUrl: { type: 'string', description: 'Attach to the tab whose URL contains this text' },
      matchTitle: { type: 'string', description: 'Attach to the tab whose title contains this text' },
      index: { type: 'integer', description: 'Attach to the Nth matching tab' },
      allowLaunch: { type: 'boolean', description: 'Opt in to starting a managed browser if none is found (default false — attach only)' },
    },
    async handler(args, ctx): Promise<CallResult> {
      const { BrowserConnection } = await import('../cdp/connection.js');
      const cfg = { ...ctx.cfg } as typeof ctx.cfg & { match?: { url?: string; title?: string; index?: number } };
      if (args.cdpEndpoint) cfg.cdpEndpoint = args.cdpEndpoint as string;
      if (args.host) cfg.host = args.host as string;
      if (typeof args.port === 'number') cfg.port = args.port as number;
      // occam: browser_connect is attach-only — never inherit --launch from server cfg.
      const allowLaunch = args.allowLaunch === true;
      cfg.launch = allowLaunch;
      cfg.autoLaunch = allowLaunch;
      const m: { url?: string; title?: string; index?: number } = {};
      if (args.matchUrl) m.url = args.matchUrl as string;
      if (args.matchTitle) m.title = args.matchTitle as string;
      if (typeof args.index === 'number') m.index = args.index as number;
      cfg.match = Object.keys(m).length ? m : undefined;
      const conn = await BrowserConnection.open(cfg);
      setOverride(conn);
      const url = await conn.current.url();
      return text(`Connected to ${conn.version} — attached to ${url}`, { browser: conn.version, url });
    },
  },
  {
    name: 'install',
    title: 'Show CDP setup instructions',
    description:
      'Nothing to install — Blinkwire attaches to a Chrome you already run. Never start a browser yourself; call browser_connect to auto-discover.',
    readOnly: true,
    async handler(): Promise<CallResult> {
      return text(
        [
          'Blinkwire attaches over CDP to your running Chrome.',
          '',
          '1. In your running Chrome, open: chrome://inspect/#remote-debugging',
          '2. Enable remote debugging on that page.',
          '3. Call browser_connect (or run blinkwire --check) and click Allow on the Chrome prompt.',
          '',
          'Note: since Chrome 136, --remote-debugging-port=9222 is ignored on the default profile',
          'and only works when paired with a separate --user-data-dir.',
        ].join('\n'),
      );
    },
  },
  {
    name: 'status',
    title: 'Connection status',
    description: 'Show the attached browser, active target and buffer sizes. Cheap diagnostic — call it first when something looks wrong.',
    readOnly: true,
    async handler(_args, ctx): Promise<CallResult> {
      const s = ctx.session;
      return text(
        [
          `browser:     ${ctx.conn.version}${ctx.conn.isManaged ? ' (Blinkwire-managed)' : ' (user-attached)'}`,
          `endpoint:    ${ctx.conn.endpoint}`,
          `target:      ${s.targetId}`,
          `url:         ${await s.url()}`,
          `alive:       ${ctx.conn.isAlive ? 'yes' : 'no (next call reconnects)'}`,
          `navigations: ${s.buffers.navSeq}`,
          `refs:        ${ctx.refs.size}`,
          `console:     ${s.buffers.console.size} entries`,
          `network:     ${s.buffers.network.size} entries (domain ${s.hasDomain('Network') ? 'on' : 'off'})`,
          `dialogs:     ${s.buffers.dialogs.length} pending`,
        ].join('\n'),
      );
    },
  },
  {
    name: 'get_config',
    title: 'Get config',
    description: 'Return the resolved configuration after merging CLI flags and environment variables.',
    readOnly: true,
    async handler(_args, ctx): Promise<CallResult> {
      return text(JSON.stringify(ctx.cfg, null, 2));
    },
  },
];

export { tools };
