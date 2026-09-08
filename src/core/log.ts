/** stderr-only logging. stdout is the MCP transport — never touch it. */

const DEBUG = !!process.env.BLINKWIRE_DEBUG;

export function nowMs(): number {
  return Date.now();
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, Math.max(0, ms)));
}

export function debug(...a: unknown[]): void {
  if (!DEBUG) return;
  process.stderr.write(`[blinkwire] ${a.map(fmt).join(' ')}\n`);
}

export function warn(...a: unknown[]): void {
  process.stderr.write(`[blinkwire] ${a.map(fmt).join(' ')}\n`);
}

function fmt(v: unknown): string {
  if (typeof v === 'string') return v;
  if (v instanceof Error) return v.stack ?? `${v.name}: ${v.message}`;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}
