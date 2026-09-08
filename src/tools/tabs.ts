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
    },
    async handler(args, ctx): Promise<CallResult> {
      const { BrowserConnection } = await import('../cdp/connection.js');
      const cfg = { ...ctx.cfg } as typeof ctx.cfg & { match?: { url?: string; title?: string; index?: number } };
      if (args.cdpEndpoint) cfg.cdpEndpoint = args.cdpEndpoint as string;
      if (args.host) cfg.host = args.host as string;
      if (typeof args.port === 'number') cfg.port = args.port as number;
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
      'Nothing to install — Blinkwire attaches to a Chrome you already run. IMPORTANT: never start a browser yourself. If no browser is visible, call browser_connect (it auto-discovers); the server starts a managed one on its own as a last resort.',
    readOnly: true,
    async handler(): Promise<CallResult> {
      return text(
        [
          'Blinkwire does not download or install a browser — it attaches over CDP.',
          '',
          'You do not start Chrome. Blinkwire finds it: configured port, then any debuggable',
          'instance in the running profiles, then a port sweep. It starts a managed browser only',
          'when blinkwire itself was run with --launch — never otherwise.',
          '',
          'If the user wants their OWN daily Chrome to be visible, they must restart it once with:',
          '  Windows: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --remote-debugging-port=9222',
          '  macOS:   /Applications/Google\\ Chrome.app/Contents/MacOS/Google\\ Chrome --remote-debugging-port=9222',
          '  Linux:   google-chrome --remote-debugging-port=9222',
          'Chrome only reads that flag at startup; asking you to type or run it achieves nothing.',
          '',
          'Verify with:  blinkwire --check',
          '',
          'Note: Chrome ignores --remote-debugging-port if an instance with the same --user-data-dir is already running.',
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
          `target:      ${s.targetId}`,
          `url:         ${await s.url()}`,
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
