import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CdpConnection, CdpSession } from './client.js';
import { PageSession } from './session.js';
import { BlinkwireError } from '../core/errors.js';
import { debug, sleep, warn } from '../core/log.js';
import { httpBase, type BlinkwireConfig } from '../config.js';
import { discoverVerbose, findFreePort, probeWithDetail, type Discovered, type ProbeAttempt } from './discovery.js';

export interface TargetInfo {
  id: string;
  type: string;
  title: string;
  url: string;
  webSocketDebuggerUrl?: string;
  attached: boolean;
}

export type ConnectOptions = BlinkwireConfig;

interface VersionInfo {
  Browser: string;
  webSocketDebuggerUrl?: string;
}

const HINT =
  "Blinkwire could not find a Chrome with DevTools enabled. It attaches to the user's running Chrome " +
  'and never starts one of its own unless blinkwire was run with --launch.\n' +
  'Do NOT start a browser yourself — call browser_connect instead (it auto-discovers).\n' +
  "To expose the user's own Chrome, tell the user this exact fix: open chrome://inspect/#remote-debugging, " +
  'enable remote debugging there, then retry and click Allow on the Chrome prompt (Chrome 144+). ' +
  'Note: since Chrome 136, --remote-debugging-port is ignored for the default profile; it only works with a ' +
  'separate --user-data-dir.';

// Managed-launch temp profiles must not survive a crash. index.ts owns signals and
// calls process.exit(), which still fires this hook.
const tempProfileDirs = new Set<string>();

function cleanupTempProfiles(): void {
  for (const dir of tempProfileDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      /* best effort */
    }
  }
  tempProfileDirs.clear();
}

process.once('exit', cleanupTempProfiles);

function findExecutable(explicit?: string): string {
  if (explicit) return explicit;
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const local = process.env.LOCALAPPDATA ?? '';
  const candidates: string[] =
    process.platform === 'win32'
      ? [
          'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
          'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
          path.join(local, 'Google\\Chrome\\Application\\chrome.exe'),
          'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
          'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
          path.join(local, 'Microsoft\\Edge\\Application\\msedge.exe'),
          'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
          path.join(local, 'BraveSoftware\\Brave-Browser\\Application\\brave.exe'),
        ]
      : process.platform === 'darwin'
        ? [
            '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
            '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
            '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
            '/Applications/Chromium.app/Contents/MacOS/Chromium',
          ]
        : ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge', 'brave-browser'];
  for (const c of candidates) {
    try {
      if (c && fs.existsSync(c)) return c;
    } catch {
      /* keep looking */
    }
  }
  if (process.platform !== 'win32' && process.platform !== 'darwin') {
    for (const c of candidates) {
      const p = `/usr/bin/${c}`;
      if (fs.existsSync(p)) return p;
    }
  }
  throw new BlinkwireError(
    'Could not locate a Chrome/Edge binary.',
    'no_browser',
    `Pass --executable-path or set CHROME_PATH.\n${HINT}`,
  );
}

export class BrowserConnection {
  private conn!: CdpConnection;
  private _browser: CdpSession | undefined;
  private _current!: PageSession;
  private readonly attached = new Map<string, PageSession>();
  private child: ChildProcess | undefined;
  private spawned = false;
  private tempProfileDir: string | undefined;
  private managed = false;
  private versionInfo: VersionInfo = { Browser: 'unknown' };
  /** Resolved HTTP base for all DevTools REST calls — synced to discovery, never stale cfg. */
  private httpEndpoint: string;
  /** Every endpoint probed during boot — surfaced in errors and --check. */
  private tried: ProbeAttempt[] = [];

  private constructor(readonly cfg: ConnectOptions) {
    this.httpEndpoint = httpBase(cfg);
  }

  static async open(opts: ConnectOptions): Promise<BrowserConnection> {
    const c = new BrowserConnection(opts);
    await c.boot();
    return c;
  }

  private async boot(): Promise<void> {
    const host = this.cfg.host || '127.0.0.1';
    let found: Discovered | undefined;
    let version: VersionInfo | undefined;

    if (this.cfg.cdpEndpoint) {
      // Explicit endpoint wins; it must validate as real DevTools. A ws:// URL is taken as-is
      // (the WS-only remote-debugging toggle has no HTTP discovery to validate against).
      this.httpEndpoint = this.cfg.cdpEndpoint.replace(/\/+$/, '');
      version = /^wss?:/i.test(this.httpEndpoint)
        ? { Browser: 'Chrome (ws endpoint)', webSocketDebuggerUrl: this.httpEndpoint }
        : await this.tryVersion();
      if (version) {
        found = {
          endpoint: this.httpEndpoint,
          port: this.cfg.port,
          source: '--cdp-endpoint',
          version,
        };
      } else {
        this.tried = [
          { endpoint: this.httpEndpoint, port: this.cfg.port, source: '--cdp-endpoint', ok: false, detail: 'no DevTools answer' },
        ];
      }
    } else {
      const v = await discoverVerbose({
        host,
        port: this.cfg.port,
        userDataDir: this.cfg.userDataDir,
        timeoutMs: Math.min(2000, this.cfg.timeoutNavigation),
      });
      this.tried = v.tried;
      found = v.found;
      version = found?.version;
      if (found) {
        // occam: pin every later HTTP call to the endpoint that actually answered.
        this.httpEndpoint = found.endpoint;
        this.cfg.port = found.port;
      }
    }

    let managed = false;
    if (!found && (this.cfg.launch || this.cfg.autoLaunch)) {
      // No debug-enabled browser anywhere we looked. Start a managed one on a
      // port we verified is free — never reuse a port that something owns but
      // does not serve as DevTools (that is the classic broken-9222 trap).
      const port = await findFreePort(host);
      this.cfg.port = port;
      this.httpEndpoint = `http://${host}:${port}`;
      await this.launch(port);
      version = await this.pollVersion(this.cfg.timeoutNavigation);
      managed = true;
      if (version) {
        found = { endpoint: this.httpEndpoint, port, source: 'blinkwire-managed', version };
        debug(`no debuggable Chrome found — started a managed one on :${port}`);
        warn(
          `No Chrome with DevTools was found, so --launch started a managed one on :${port}. ` +
            `This is a separate browser, not your session. To use your own tabs, enable chrome://inspect/#remote-debugging ` +
            `in your Chrome and reconnect without --launch.`,
        );
      }
    }

    if (!found || !version) {
      throw new BlinkwireError(
        `No CDP endpoint at ${this.httpEndpoint}.`,
        'no_browser',
        `${HINT}\nProbed: ${this.tried.map((t) => `${t.endpoint} [${t.source}] ${t.ok ? 'ok' : t.detail ?? 'refused'}`).join(' | ') || 'nothing reachable'}`,
      );
    }
    this.versionInfo = version;
    this.managed = managed;

    if (version.webSocketDebuggerUrl) {
      this.conn = await CdpConnection.connect(
        version.webSocketDebuggerUrl,
        this.cfg.timeoutNavigation,
      );
      this._browser = new CdpSession(this.conn);
      if (version.Browser.includes('(')) {
        try {
          const bv = await this._browser.send<{ product?: string }>('Browser.getVersion', {}, { timeoutMs: 3000 });
          if (bv?.product) this.versionInfo.Browser = bv.product;
        } catch {
          /* keep placeholder */
        }
      }
      // The user closes tabs. Without this the session stays "alive" and every call fails.
      this._browser.on('Target.detachedFromTarget', (p: { targetId?: string; sessionId?: string }) => {
        for (const [id, ps] of this.attached) {
          if (id === p.targetId || ps.cdp.sessionId === p.sessionId) {
            ps.markClosed();
            this.attached.delete(id);
          }
        }
      });
    }

    const target = await this.pickInitialTarget();
    if (!target) {
      if (!this.cfg.match && this._browser) {
        await this.newTab('about:blank');
        return;
      }
      throw new BlinkwireError('No page target available to attach to.', 'no_target', HINT);
    }

    if (this.conn && this._browser) {
      await this.attach(target.id);
    } else if (target.webSocketDebuggerUrl) {
      this.conn = await CdpConnection.connect(
        target.webSocketDebuggerUrl,
        this.cfg.timeoutNavigation,
      );
      const s = new CdpSession(this.conn);
      this._current = new PageSession(this, target.id, s);
      this.attached.set(target.id, this._current);
    } else {
      throw new BlinkwireError('Target has no debugger URL.', 'no_target', HINT);
    }
    debug('attached', target.url);
  }

  private async tryVersion(): Promise<VersionInfo | undefined> {
    return (await probeWithDetail(this.httpEndpoint, 2000)).version;
  }

  private async pollVersion(timeoutMs: number): Promise<VersionInfo | undefined> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const v = await this.tryVersion();
      if (v) return v;
      await sleep(150);
    }
    return undefined;
  }

  private async launch(port?: number): Promise<void> {
    const exe = findExecutable(this.cfg.executablePath);
    let dir = this.cfg.userDataDir;
    if (!dir) {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'blinkwire-profile-'));
      this.tempProfileDir = dir;
      tempProfileDirs.add(dir);
    }
    const usePort = port ?? this.cfg.port;
    this.cfg.port = usePort;
    const args = [
      `--remote-debugging-port=${usePort}`,
      `--user-data-dir=${dir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-networking',
      '--disable-component-update',
      '--disable-features=Translate,BackForwardCache,AcceptCHFrame',
      '--remote-allow-origins=*',
      'about:blank',
    ];
    if (this.cfg.headless) args.unshift('--headless=new');
    debug('launching', exe, args.join(' '));
    this.child = spawn(exe, args, { stdio: 'ignore', detached: false });
    this.spawned = true;
    this.cfg.userDataDir = dir;
  }

  private async pickInitialTarget(): Promise<TargetInfo | undefined> {
    const list = await this.targets('page');
    if (list.length === 0) return undefined;
    const m = this.cfg.match;
    if (m) {
      const u = m.url?.toLowerCase();
      const ti = m.title?.toLowerCase();
      const byUrl = u ? list.filter((t) => t.url.toLowerCase().includes(u)) : list;
      const byTitle = ti ? byUrl.filter((t) => t.title.toLowerCase().includes(ti)) : byUrl;
      if (typeof m.index === 'number') return byTitle[m.index];
      return byTitle[0];
    }
    // The user's real browser is full of chrome://, devtools:// and extension pages.
    return list.find((t) => /^(https?|file|data):/i.test(t.url)) ?? list[0];
  }

  /** Current tab went away but the socket is fine: pick another tab, no reconnect. */
  async reattach(): Promise<PageSession> {
    const t = await this.pickInitialTarget();
    if (!t) throw new BlinkwireError('The attached tab closed and no other tab is open.', 'no_target', 'Open a tab, or use browser_tabs action=new.');
    return this.attach(t.id);
  }

  /** Resolved DevTools HTTP base (post-discovery). Use for diagnostics, not httpBase(cfg). */
  get endpoint(): string {
    return this.httpEndpoint;
  }
  /** Every endpoint probed during boot. */
  get probed(): ProbeAttempt[] {
    return this.tried;
  }
  /** False when the transport dropped (Chrome quit, WS closed) — caller must reconnect. */
  get isAlive(): boolean {
    return !!this.conn && !this.conn.closed;
  }
  get browser(): CdpSession | undefined {
    return this._browser;
  }
  get current(): PageSession {
    return this._current;
  }
  get version(): string {
    return this.versionInfo.Browser;
  }
  /** True when Blinkwire launched this browser itself (attach was impossible). */
  get isManaged(): boolean {
    return this.managed;
  }

  async ensureBrowser(): Promise<CdpSession> {
    if (!this._browser) {
      throw new BlinkwireError(
        'Browser-level CDP is unavailable (attached directly to a page target).',
        'browser_domain',
        'Window resizing needs the browser target. Enable chrome://inspect/#remote-debugging or use --cdp-endpoint.',
      );
    }
    return this._browser;
  }

  private readonly targetOrder = new Map<string, number>();

  private orderTargets(list: TargetInfo[], type?: string): TargetInfo[] {
    for (const t of list) if (!this.targetOrder.has(t.id)) this.targetOrder.set(t.id, this.targetOrder.size);
    return list
      .filter((t) => !type || t.type === type)
      .sort((a, b) => (this.targetOrder.get(a.id) ?? 0) - (this.targetOrder.get(b.id) ?? 0));
  }

  async targets(type?: string): Promise<TargetInfo[]> {
    if (this._browser) {
      try {
        const r = await this._browser.send<{ targetInfos: any[] }>('Target.getTargets');
        return this.orderTargets(
          (r.targetInfos ?? []).map((t) => ({
            id: t.targetId,
            type: t.type,
            title: t.title ?? '',
            url: t.url ?? '',
            attached: t.attached ?? false,
          })),
          type,
        );
      } catch {
        /* fall through to HTTP */
      }
    }
    try {
      const res = await fetch(`${this.httpEndpoint}/json/list`, {
        signal: AbortSignal.timeout(3000),
      });
      const json = (await res.json()) as any[];
      return this.orderTargets(
        json.map((t) => ({
          id: t.id,
          type: t.type,
          title: t.title ?? '',
          url: t.url ?? '',
          webSocketDebuggerUrl: t.webSocketDebuggerUrl,
          attached: !!t.attached,
        })),
        type,
      );
    } catch (e) {
      throw new BlinkwireError(
        `Could not list targets: ${(e as Error).message}`,
        'no_browser',
        HINT,
      );
    }
  }

  async attach(targetId: string): Promise<PageSession> {
    const cached = this.attached.get(targetId);
    if (cached && !cached.closed && !cached.cdp.closed) {
      this._current = cached;
      return cached;
    }
    if (cached) this.attached.delete(targetId);
    const browser = this._browser;
    let s: CdpSession;
    if (browser) {
      const r = await browser.send<{ sessionId: string }>('Target.attachToTarget', {
        targetId,
        flatten: true,
      });
      s = this.conn.session(r.sessionId);
    } else {
      const list = await this.targets();
      const t = list.find((x) => x.id === targetId);
      if (!t?.webSocketDebuggerUrl)
        throw new BlinkwireError(`Cannot attach to ${targetId}.`, 'no_target');
      const direct = await CdpConnection.connect(
        t.webSocketDebuggerUrl,
        this.cfg.timeoutNavigation,
      );
      s = new CdpSession(direct);
    }
    const ps = new PageSession(this, targetId, s);
    this.attached.set(targetId, ps);
    this._current = ps;
    return ps;
  }

  async newTab(url = 'about:blank'): Promise<PageSession> {
    let id: string | undefined;
    if (this._browser) {
      const r = await this._browser.send<{ targetId: string }>('Target.createTarget', { url });
      id = r.targetId;
    } else {
      let res = await fetch(`${this.httpEndpoint}/json/new?${encodeURIComponent(url)}`, {
        method: 'PUT',
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok)
        res = await fetch(`${this.httpEndpoint}/json/new?${encodeURIComponent(url)}`, {
          signal: AbortSignal.timeout(5000),
        });
      const j = (await res.json()) as { id: string };
      id = j.id;
    }
    const ps = await this.attach(id);
    try {
      await ps.cdp.send('Page.bringToFront');
    } catch {
      /* not fatal */
    }
    return ps;
  }

  async closeTab(targetId: string): Promise<void> {
    const wasCurrent = this._current?.targetId === targetId;
    const cached = this.attached.get(targetId);
    if (cached) {
      cached.markClosed();
      this.attached.delete(targetId);
    }
    try {
      if (this._browser) await this._browser.send('Target.closeTarget', { targetId });
      else
        await fetch(`${this.httpEndpoint}/json/close/${targetId}`, {
          signal: AbortSignal.timeout(3000),
        });
    } catch {
      /* already gone */
    }
    if (wasCurrent) {
      await this.reattach().catch(() => {});
    }
  }

  async select(m: { url?: string; title?: string; index?: number }): Promise<PageSession> {
    const list = await this.targets('page');
    let pool = list;
    if (m.url) {
      const q = m.url.toLowerCase();
      pool = pool.filter((t) => t.url.toLowerCase().includes(q));
    }
    if (m.title) {
      const q = m.title.toLowerCase();
      pool = pool.filter((t) => t.title.toLowerCase().includes(q));
    }
    const t = typeof m.index === 'number' ? pool[m.index] : pool[0];
    if (!t) throw new BlinkwireError('No tab matches the given selector.', 'no_target');
    const ps = await this.attach(t.id);
    try {
      await ps.cdp.send('Page.bringToFront');
    } catch {
      /* ignore */
    }
    return ps;
  }

  async close(): Promise<void> {
    for (const [, ps] of this.attached) ps.markClosed();
    this.attached.clear();
    try {
      await this.conn?.close();
    } catch {
      /* ignore */
    }
    if (this.spawned && this.child && !this.child.killed) {
      try {
        this.child.kill();
      } catch {
        /* ignore */
      }
    }
    if (this.tempProfileDir) {
      tempProfileDirs.delete(this.tempProfileDir);
      try {
        fs.rmSync(this.tempProfileDir, { recursive: true, force: true, maxRetries: 3 });
      } catch {
        /* ignore locks or background cleanup delays */
      }
      this.tempProfileDir = undefined;
    }
  }
}
