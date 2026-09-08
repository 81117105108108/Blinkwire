import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

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

/** Ports advertised by already-running Chrome instances via DevToolsActivePort. */
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

export async function scanPorts(host: string, ports: number[], timeoutMs = 600): Promise<Discovered | undefined> {
  const found = await Promise.all(
    ports.map(async (port) => {
      const version = await probe(`http://${host}:${port}`, timeoutMs);
      return version ? { endpoint: `http://${host}:${port}`, port, source: `port scan :${port}`, version } : undefined;
    }),
  );
  return found.find((f): f is Discovered => f !== undefined);
}

/** Find the best available Chrome, validating that DevTools is actually served. */
export async function discover(o: DiscoverOptions): Promise<Discovered | undefined> {
  const host = o.host || '127.0.0.1';
  const seen = new Set<string>();
  const candidates: Array<{ endpoint: string; port: number; source: string }> = [];

  const add = (endpoint: string, port: number, source: string) => {
    if (seen.has(endpoint)) return;
    seen.add(endpoint);
    candidates.push({ endpoint, port, source });
  };

  if (o.cdpEndpoint) add(o.cdpEndpoint.replace(/\/+$/, ''), o.port, '--cdp-endpoint');
  add(`http://${host}:${o.port}`, o.port, `configured port :${o.port}`);
  for (const p of portHints(o.userDataDir)) add(`http://${host}:${p}`, p, `DevToolsActivePort :${p}`);

  for (const c of candidates) {
    const version = await probe(c.endpoint, o.timeoutMs ?? 1500);
    if (version) return { ...c, version };
  }

  // Last resort: sweep the usual DevTools range.
  const range = Array.from({ length: 24 }, (_, i) => 9222 + i).filter((p) => !seen.has(`http://${host}:${p}`));
  return scanPorts(host, range, 600);
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
