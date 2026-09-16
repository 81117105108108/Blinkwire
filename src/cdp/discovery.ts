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

/**
 * A valid DevTools endpoint answers /json/version with a Browser string.
 * Anything else (404s, other services squatting on the port) is rejected —
 * otherwise we happily attach to a port that a browser owns but does not serve.
 */
export async function probe(endpoint: string, timeoutMs = 1500): Promise<VersionInfo | undefined> {
  const url = `${endpoint.replace(/\/+$/, '')}/json/version`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return undefined;
    const j = (await res.json()) as VersionInfo;
    if (!j || typeof j.Browser !== 'string' || j.Browser.length === 0) return undefined;
    return j;
  } catch {
    return undefined;
  }
}

function profileDirs(extra?: string): string[] {
  const dirs: string[] = [];
  if (extra) dirs.push(extra);
  const home = os.homedir();
  const local = process.env.LOCALAPPDATA;
  if (process.platform === 'win32' && local) {
    dirs.push(
      path.join(local, 'Google', 'Chrome', 'User Data'),
      path.join(local, 'Google', 'Chrome SxS', 'User Data'),
      path.join(local, 'Microsoft', 'Edge', 'User Data'),
      path.join(local, 'Chromium', 'User Data'),
    );
  } else if (process.platform === 'darwin') {
    dirs.push(
      path.join(home, 'Library', 'Application Support', 'Google', 'Chrome'),
      path.join(home, 'Library', 'Application Support', 'Microsoft Edge'),
      path.join(home, 'Library', 'Application Support', 'Chromium'),
    );
  } else {
    dirs.push(
      path.join(home, '.config', 'google-chrome'),
      path.join(home, '.config', 'microsoft-edge'),
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

/** Ports from running browser command lines (--remote-debugging-port=...). */
export async function processPortHints(timeoutMs = 3000): Promise<number[]> {
  const out = new Set<number>();
  const collect = (text: string): void => {
    for (const m of text.matchAll(/--remote-debugging-port[=\s]+(\d{2,5})/g)) {
      const p = Number(m[1]);
      if (Number.isInteger(p) && p > 0 && p < 65536) out.add(p);
    }
  };
  try {
    if (process.platform === 'win32') {
      // PowerShell CIM is the reliable cmdline source on modern Windows (wmic is deprecated).
      const { stdout } = await execFileAsync(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          "Get-CimInstance Win32_Process -Filter \"(Name='chrome.exe' OR Name='msedge.exe' OR Name='chromium.exe')\" | Select-Object -ExpandProperty CommandLine",
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
  return [...out];
}
export function portHints(extra?: string): number[] {
  const out: number[] = [];
  for (const dir of profileDirs(extra)) {
    try {
      const file = path.join(dir, 'DevToolsActivePort');
      if (!fs.existsSync(file)) continue;
      const first = fs.readFileSync(file, 'utf8').split(/\r?\n/)[0]?.trim();
      const p = Number(first);
      if (Number.isInteger(p) && p > 0 && p < 65536) out.push(p);
    } catch {
      /* unreadable profile dir */
    }
  }
  return [...new Set(out)];
}

export async function probeWithDetail(
  endpoint: string,
  timeoutMs = 1500,
): Promise<{ version?: VersionInfo; detail?: string }> {
  const url = `${endpoint.replace(/\/+$/, '')}/json/version`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return { detail: `HTTP ${res.status}` };
    const j = (await res.json()) as VersionInfo;
    if (!j || typeof j.Browser !== 'string' || j.Browser.length === 0)
      return { detail: 'not DevTools (no Browser string)' };
    return { version: j };
  } catch (e) {
    const msg = e instanceof Error ? e.name : 'fetch failed';
    return { detail: msg === 'TimeoutError' ? `timeout ${timeoutMs}ms` : 'connection refused' };
  }
}

export async function scanPorts(host: string, ports: number[], timeoutMs = 600): Promise<Discovered | undefined> {
  const v = await scanPortsVerbose(host, ports, timeoutMs, 'port scan');
  return v.found;
}

export async function scanPortsVerbose(
  host: string,
  ports: number[],
  timeoutMs = 600,
  sourcePrefix = 'port scan',
): Promise<DiscoverVerbose> {
  const tried: ProbeAttempt[] = [];
  for (const port of ports) {
    const endpoint = `http://${host}:${port}`;
    const { version, detail } = await probeWithDetail(endpoint, timeoutMs);
    tried.push({ endpoint, port, source: `${sourcePrefix} :${port}`, ok: !!version, detail });
    if (version) return { found: { endpoint, port, source: `${sourcePrefix} :${port}`, version }, tried };
  }
  return { tried };
}

/** Find the best available Chrome, validating that DevTools is actually served. */
export async function discover(o: DiscoverOptions): Promise<Discovered | undefined> {
  const v = await discoverVerbose(o);
  return v.found;
}

/** Same as discover() but reports every endpoint tried — for --check and error hints. */
export async function discoverVerbose(o: DiscoverOptions): Promise<DiscoverVerbose> {
  const host = o.host || '127.0.0.1';
  const tried: ProbeAttempt[] = [];
  const seen = new Set<string>();
  const candidates: Array<{ endpoint: string; port: number; source: string }> = [];

  const add = (endpoint: string, port: number, source: string) => {
    if (seen.has(endpoint)) return;
    seen.add(endpoint);
    candidates.push({ endpoint, port, source });
  };

  if (o.cdpEndpoint) add(o.cdpEndpoint.replace(/\/+$/, ''), o.port, '--cdp-endpoint');
  // Probe loopback aliases: Chrome may listen on localhost while cfg says 127.0.0.1.
  for (const h of hostVariants(host)) add(`http://${h}:${o.port}`, o.port, `configured port :${o.port} (${h})`);
  for (const p of portHints(o.userDataDir))
    for (const h of hostVariants(host)) add(`http://${h}:${p}`, p, `DevToolsActivePort :${p} (${h})`);
  // Running-process ports catch --remote-debugging-port values outside the sweep range.
  for (const p of await processPortHints())
    for (const h of hostVariants(host)) add(`http://${h}:${p}`, p, `process arg :${p} (${h})`);

  for (const c of candidates) {
    const { version, detail } = await probeWithDetail(c.endpoint, o.timeoutMs ?? 1500);
    tried.push({ ...c, ok: !!version, detail });
    if (version) return { found: { ...c, version }, tried };
  }

  // Last resort: sweep the usual DevTools range on every loopback alias.
  for (const h of hostVariants(host)) {
    const range = Array.from({ length: 24 }, (_, i) => 9222 + i).filter(
      (p) => !seen.has(`http://${h}:${p}`),
    );
    const sweep = await scanPortsVerbose(h, range, 600);
    tried.push(...sweep.tried);
    if (sweep.found) return { found: sweep.found, tried };
  }
  return { tried };
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
