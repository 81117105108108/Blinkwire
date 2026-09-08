import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CdpConnection, CdpSession } from './client.js';
import { PageSession } from './session.js';
import { BlinkwireError, TimeoutError } from '../core/errors.js';
import { debug, sleep } from '../core/log.js';
import { httpBase, type BlinkwireConfig } from '../config.js';

export interface TargetInfo {
  id: string;
  type: string;
  title: string;
  url: string;
  webSocketDebuggerUrl?: string;
  attached: boolean;
}

export interface ConnectOptions extends BlinkwireConfig {}

interface VersionInfo {
  Browser: string;
  webSocketDebuggerUrl?: string;
}

const HINT =
  'Start Chrome with a debugging port, e.g.:\n' +
  '  chrome.exe --remote-debugging-port=9222\n' +
  'or let Blinkwire launch one:  blinkwire --launch [--headless]';

function findExecutable(explicit?: string): string {
  if (explicit) return explicit;
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const candidates: string[] =
    process.platform === 'win32'
      ? [
          'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
          'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
          'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
          'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
        ]
      : process.platform === 'darwin'
        ? [
            '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
            '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
            '/Applications/Chromium.app/Contents/MacOS/Chromium',
          ]
        : ['google-chrome', 'chromium', 'chromium-browser', 'microsoft-edge'];
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return c;
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
  throw new BlinkwireError('Could not locate a Chrome/Edge binary.', 'no_browser', `Pass --executable-path or set CHROME_PATH.\n${HINT}`);
}

export class BrowserConnection {
  private conn!: CdpConnection;
  private _browser: CdpSession | undefined;
  private _current!: PageSession;
  private readonly attached = new Map<string, PageSession>();
  private child: ChildProcess | undefined;
  private spawned = false;
  private versionInfo: VersionInfo = { Browser: 'unknown' };

  private constructor(readonly cfg: ConnectOptions) {}

  static async open(opts: ConnectOptions): Promise<BrowserConnection> {
    const c = new BrowserConnection(opts);
    await c.boot();
    return c;
  }

  private async boot(): Promise<void> {
    let version = await this.tryVersion();
    if (!version && this.cfg.launch) {
      await this.launch();
      version = await this.pollVersion(this.cfg.timeoutNavigation);
    }
    if (!version) {
      throw new BlinkwireError(
        `No CDP endpoint at ${httpBase(this.cfg)}.`,
        'no_browser',
        HINT,
      );
    }
    this.versionInfo = version;

    if (version.webSocketDebuggerUrl) {
      this.conn = await CdpConnection.connect(version.webSocketDebuggerUrl, this.cfg.timeoutNavigation);
      this._browser = new CdpSession(this.conn.socket, this.conn);
    }

    const target = await this.pickInitialTarget();
    if (!target) throw new BlinkwireError('No page target available to attach to.', 'no_target', HINT);

    if (this.conn && this._browser) {
      await this.attach(target.id);
    } else if (target.webSocketDebuggerUrl) {
      this.conn = await CdpConnection.connect(target.webSocketDebuggerUrl, this.cfg.timeoutNavigation);
      const s = new CdpSession(this.conn.socket, this.conn);
      this._current = new PageSession(this, target.id, s);
      this.attached.set(target.id, this._current);
    } else {
      throw new BlinkwireError('Target has no debugger URL.', 'no_target', HINT);
    }
    debug('attached', target.url);
  }

  private async tryVersion(): Promise<VersionInfo | undefined> {
    try {
      const res = await fetch(`${httpBase(this.cfg)}/json/version`, { signal: AbortSignal.timeout(2000) });
      if (!res.ok) return undefined;
      return (await res.json()) as VersionInfo;
    } catch {
      return undefined;
    }
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

  private async launch(): Promise<void> {
    const exe = findExecutable(this.cfg.executablePath);
    const dir =
      this.cfg.userDataDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'blinkwire-profile-'));
    const args = [
      `--remote-debugging-port=${this.cfg.port}`,
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
      const byUrl = m.url ? list.filter((t) => t.url.includes(m.url!)) : list;
      const byTitle = m.title ? byUrl.filter((t) => t.title.includes(m.title!)) : byUrl;
      if (typeof m.index === 'number') return byTitle[m.index] ?? byTitle[0];
      return byTitle[0];
    }
    return list[0];
  }

  get connRaw(): CdpConnection {
    return this.conn;
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

  async versionInfo_(): Promise<VersionInfo> {
    return this.versionInfo;
  }

  async ensureBrowser(): Promise<CdpSession> {
    if (!this._browser) {
      throw new BlinkwireError(
        'Browser-level CDP is unavailable (attached directly to a page target).',
        'browser_domain',
        'Window resizing needs the browser target. Restart Chrome with --remote-debugging-port and use --cdp-endpoint.',
      );
    }
    return this._browser;
  }

  async targets(type?: string): Promise<TargetInfo[]> {
    if (this._browser) {
      try {
        const r = await this._browser.send<{ targetInfos: any[] }>('Target.getTargets');
        return (r.targetInfos ?? [])
          .filter((t) => !type || t.type === type)
          .map((t) => ({
            id: t.targetId,
            type: t.type,
            title: t.title ?? '',
            url: t.url ?? '',
            attached: t.attached ?? false,
          }));
      } catch {
        /* fall through to HTTP */
      }
    }
    try {
      const res = await fetch(`${httpBase(this.cfg)}/json/list`, { signal: AbortSignal.timeout(3000) });
      const json = (await res.json()) as any[];
      return json
        .filter((t) => !type || t.type === type)
        .map((t) => ({
          id: t.id,
          type: t.type,
          title: t.title ?? '',
          url: t.url ?? '',
          webSocketDebuggerUrl: t.webSocketDebuggerUrl,
          attached: !!t.attached,
        }));
    } catch (e) {
      throw new BlinkwireError(`Could not list targets: ${(e as Error).message}`, 'no_browser', HINT);
    }
  }

  async attach(targetId: string): Promise<PageSession> {
    const cached = this.attached.get(targetId);
    if (cached && !cached.closed) {
      this._current = cached;
      return cached;
    }
    const browser = this._browser;
    let s: CdpSession;
    if (browser) {
      const r = await browser.send<{ sessionId: string }>('Target.attachToTarget', { targetId, flatten: true });
      s = this.conn.session(r.sessionId);
    } else {
      const list = await this.targets();
      const t = list.find((x) => x.id === targetId);
      if (!t?.webSocketDebuggerUrl) throw new BlinkwireError(`Cannot attach to ${targetId}.`, 'no_target');
      const direct = await CdpConnection.connect(t.webSocketDebuggerUrl, this.cfg.timeoutNavigation);
      s = new CdpSession(direct.socket, direct);
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
      const base = httpBase(this.cfg);
      let res = await fetch(`${base}/json/new?${encodeURIComponent(url)}`, { method: 'PUT', signal: AbortSignal.timeout(5000) });
      if (!res.ok) res = await fetch(`${base}/json/new?${encodeURIComponent(url)}`, { signal: AbortSignal.timeout(5000) });
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
    const cached = this.attached.get(targetId);
    if (cached) {
      cached.markClosed();
      this.attached.delete(targetId);
    }
    try {
      if (this._browser) await this._browser.send('Target.closeTarget', { targetId });
      else await fetch(`${httpBase(this.cfg)}/json/close/${targetId}`, { signal: AbortSignal.timeout(3000) });
    } catch {
      /* already gone */
    }
  }

  async select(m: { url?: string; title?: string; index?: number }): Promise<PageSession> {
    const list = await this.targets('page');
    let pool = list;
    if (m.url) pool = pool.filter((t) => t.url.includes(m.url!));
    if (m.title) pool = pool.filter((t) => t.title.includes(m.title!));
    if (typeof m.index === 'number') pool = [pool[m.index] ?? pool[0]!];
    const t = pool[0];
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
  }
}

