import { execFile } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface VersionInfo {
  Browser: string;
  webSocketDebuggerUrl?: string;
  'Protocol-Version'?: string;
}

export interface Discovered {
  /** HTTP base, e.g. http://127.0.0.1:9222 */
  endpoint: string;
  port: number;
  source: string;
  version: VersionInfo;
}

export interface DiscoverOptions {
  host: string;
  port: number;
  cdpEndpoint?: string;
  userDataDir?: string;
  timeoutMs?: number;
}

function profileDirs(extra?: string | string[]): string[] {
  const dirs: string[] = [];
  if (typeof extra === 'string' && extra) dirs.push(extra);
  else if (Array.isArray(extra)) dirs.push(...extra.filter(Boolean));
  const home = os.homedir();
  const local = process.env.LOCALAPPDATA;
  if (process.platform === 'win32' && local) {
    dirs.push(
      path.join(local, 'Google', 'Chrome', 'User Data'),
      path.join(local, 'Google', 'Chrome Beta', 'User Data'),
      path.join(local, 'Google', 'Chrome Dev', 'User Data'),
      path.join(local, 'Google', 'Chrome SxS', 'User Data'),
      path.join(local, 'Microsoft', 'Edge', 'User Data'),
      path.join(local, 'BraveSoftware', 'Brave-Browser', 'User Data'),
      path.join(local, 'Chromium', 'User Data'),
    );
  } else if (process.platform === 'darwin') {
    dirs.push(
      path.join(home, 'Library', 'Application Support', 'Google', 'Chrome'),
      path.join(home, 'Library', 'Application Support', 'Google', 'Chrome Beta'),
      path.join(home, 'Library', 'Application Support', 'Google', 'Chrome Canary'),
      path.join(home, 'Library', 'Application Support', 'Microsoft Edge'),
      path.join(home, 'Library', 'Application Support', 'BraveSoftware', 'Brave-Browser'),
      path.join(home, 'Library', 'Application Support', 'Chromium'),
    );
  } else {
    dirs.push(
      path.join(home, '.config', 'google-chrome'),
      path.join(home, '.config', 'google-chrome-beta'),
      path.join(home, '.config', 'google-chrome-unstable'),
      path.join(home, '.config', 'microsoft-edge'),
      path.join(home, '.config', 'BraveSoftware', 'Brave-Browser'),
      path.join(home, '.config', 'chromium'),
    );
  }
  return dirs;
}

export interface ProbeAttempt {
  endpoint: string;
  port: number;
  source: string;
  ok: boolean;
  detail?: string;
}

export interface DiscoverVerbose {
  found?: Discovered;
  tried: ProbeAttempt[];
}

/** Loopback aliases: Chrome may bind localhost while we probe 127.0.0.1 and vice versa. */
function hostVariants(host: string): string[] {
  if (host === '127.0.0.1') return ['127.0.0.1', 'localhost'];
  if (host === 'localhost') return ['localhost', '127.0.0.1'];
  return [host];
}

/** Ports and custom --user-data-dir paths from running browser command lines. */
export async function processPortHints(timeoutMs = 3000): Promise<Array<{ port: number; wsPath?: string }>> {
  const ports = new Set<number>();
  const dataDirs = new Set<string>();
  const collect = (text: string): void => {
    for (const m of text.matchAll(/--remote-debugging-port[=\s]+(\d{2,5})/g)) {
      const p = Number(m[1]);
      if (Number.isInteger(p) && p > 0 && p < 65536) ports.add(p);
    }
    for (const m of text.matchAll(/--user-data-dir=(?:"([^"]+)"|'([^']+)'|(\S+))/g)) {
      const dir = m[1] ?? m[2] ?? m[3];
      if (dir) dataDirs.add(dir);
    }
  };
  try {
    if (process.platform === 'win32') {
      const { stdout } = await execFileAsync(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          "Get-CimInstance Win32_Process -Filter \"(Name='chrome.exe' OR Name='msedge.exe' OR Name='brave.exe' OR Name='chromium.exe')\" | Select-Object -ExpandProperty CommandLine",
        ],
        { timeout: timeoutMs, windowsHide: true },
      );
      collect(stdout ?? '');
    } else {
      const { stdout } = await execFileAsync('ps', ['-axo', 'command'], { timeout: timeoutMs });
      collect(stdout ?? '');
    }
  } catch {
    /* process scan is best-effort; HTTP probing still runs */
  }
  const byPort = new Map<number, string | undefined>();
  for (const h of portHints([...dataDirs])) byPort.set(h.port, h.wsPath);
  for (const p of ports) if (!byPort.has(p)) byPort.set(p, undefined);
  return [...byPort].map(([port, wsPath]) => ({ port, wsPath }));
}

/**
 * DevToolsActivePort = "<port>\n/devtools/browser/<uuid>". Line 2 matters: Chrome's
 * chrome://inspect/#remote-debugging toggle (Chrome 144+) serves WebSocket only — no
 * /json/* — so the ws path in this file is the ONLY way to reach the user's own browser.
 */
export function portHints(extra?: string | string[]): Array<{ port: number; wsPath?: string }> {
  const out = new Map<number, string | undefined>();
  for (const dir of profileDirs(extra)) {
    try {
      const [first, second] = fs.readFileSync(path.join(dir, 'DevToolsActivePort'), 'utf8').split(/\r?\n/);
      const p = Number(first?.trim());
      const ws = second?.trim();
      if (Number.isInteger(p) && p > 0 && p < 65536 && !out.has(p))
        out.set(p, ws?.startsWith('/devtools/browser/') ? ws : undefined);
    } catch {
      /* no file / unreadable profile dir */
    }
  }
  return [...out].map(([port, wsPath]) => ({ port, wsPath }));
}

export async function probeWithDetail(
  endpoint: string,
  timeoutMs = 1500,
  wsPath?: string,
): Promise<{ version?: VersionInfo; detail?: string }> {
  const base = endpoint.replace(/\/+$/, '');
  try {
    const res = await fetch(`${base}/json/version`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) {
      // Something answered but has no HTTP discovery: the WS-only remote-debugging toggle.
      if (wsPath)
        return {
          version: { Browser: 'Chrome (remote-debugging toggle)', webSocketDebuggerUrl: `${base.replace(/^http/, 'ws')}${wsPath}` },
        };
      return { detail: `HTTP ${res.status}` };
    }
    const j = (await res.json()) as VersionInfo;
    if (!j || typeof j.Browser !== 'string' || j.Browser.length === 0)
      return { detail: 'not DevTools (no Browser string)' };
    if (!j.webSocketDebuggerUrl && wsPath) j.webSocketDebuggerUrl = `${base.replace(/^http/, 'ws')}${wsPath}`;
    return { version: j };
  } catch (e) {
    const msg = e instanceof Error ? e.name : 'fetch failed';
    return { detail: msg === 'TimeoutError' ? `timeout ${timeoutMs}ms` : 'connection refused' };
  }
}

interface Candidate {
  endpoint: string;
  port: number;
  source: string;
  wsPath?: string;
}

/** Probe in parallel, prefer candidates in list order. */
async function probeAll(cands: Candidate[], timeoutMs: number, tried: ProbeAttempt[]): Promise<Discovered | undefined> {
  const results = await Promise.all(cands.map((c) => probeWithDetail(c.endpoint, timeoutMs, c.wsPath)));
  let found: Discovered | undefined;
  cands.forEach((c, i) => {
    const { version, detail } = results[i]!;
    tried.push({ endpoint: c.endpoint, port: c.port, source: c.source, ok: !!version, detail });
    if (version && !found) found = { endpoint: c.endpoint, port: c.port, source: c.source, version };
  });
  return found;
}

/** Find the best available Chrome and report every endpoint tried — for --check and error hints. */
export async function discoverVerbose(o: DiscoverOptions): Promise<DiscoverVerbose> {
  const host = o.host || '127.0.0.1';
  const timeoutMs = o.timeoutMs ?? 1500;
  const tried: ProbeAttempt[] = [];
  const seen = new Map<string, Candidate>();
  const add = (list: Candidate[], endpoint: string, port: number, source: string, wsPath?: string) => {
    const prev = seen.get(endpoint);
    if (prev) {
      prev.wsPath ??= wsPath; // configured :9222 may be the WS-only toggle — keep its ws path
      return;
    }
    const c = { endpoint, port, source, wsPath };
    seen.set(endpoint, c);
    list.push(c);
  };

  const cheap: Candidate[] = [];
  if (o.cdpEndpoint) add(cheap, o.cdpEndpoint.replace(/\/+$/, ''), o.port, '--cdp-endpoint');
  // Probe loopback aliases: Chrome may listen on localhost while cfg says 127.0.0.1.
  for (const h of hostVariants(host)) add(cheap, `http://${h}:${o.port}`, o.port, `configured port :${o.port} (${h})`);
  for (const { port, wsPath } of portHints(o.userDataDir))
    for (const h of hostVariants(host)) add(cheap, `http://${h}:${port}`, port, `DevToolsActivePort :${port} (${h})`, wsPath);
  let found = await probeAll(cheap, timeoutMs, tried);
  if (found) return { found, tried };

  // Running-process ports catch --remote-debugging-port values outside the sweep range.
  // ponytail: spawns PowerShell on Windows (~1s), so it only runs after the cheap probes miss.
  const proc: Candidate[] = [];
  for (const { port, wsPath } of await processPortHints())
    for (const h of hostVariants(host)) add(proc, `http://${h}:${port}`, port, `process arg :${port} (${h})`, wsPath);
  found = await probeAll(proc, timeoutMs, tried);
  if (found) return { found, tried };

  // Last resort: sweep the usual DevTools range on every loopback alias.
  const sweep: Candidate[] = [];
  for (const h of hostVariants(host))
    for (let p = 9222; p < 9246; p++) add(sweep, `http://${h}:${p}`, p, `port scan :${p}`);
  found = await probeAll(sweep, 600, tried);
  return found ? { found, tried } : { tried };
}

export async function findFreePort(host = '127.0.0.1'): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, host, () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}
