import type { PageSession } from '../cdp/session.js';

export interface SettleReport {
  settled: boolean;
  ms: number;
  reason: 'idle' | 'timeout' | 'timeout-hard';
}

const SETTLE_FN = function (arg: any) {
  return new Promise((resolve) => {
    const t0 = performance.now();
    const quiet = arg.quietMs || 0;
    const timeout = Math.max(arg.timeoutMs || 500, 20);
    let timer: any = null;
    let done = false;
    const finish = (reason: string) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      try { mo.disconnect(); } catch { /* ignore */ }
      resolve({ settled: reason === 'idle', ms: Math.round(performance.now() - t0), reason });
    };
    const mo = new MutationObserver(() => {
      if (quiet <= 0) return finish('idle');
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => finish('idle'), quiet);
    });
    mo.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
    setTimeout(() => finish('timeout'), timeout);
    if (quiet <= 0) {
      const tick = () => requestAnimationFrame(() => finish('idle'));
      if (document.readyState === 'complete') tick();
      else window.addEventListener('load', tick, { once: true });
    } else {
      timer = setTimeout(() => finish('idle'), quiet);
    }
  });
};

const WAIT_TEXT_FN = function (arg: any) {
  return new Promise((resolve) => {
    const t0 = performance.now();
    const read = () => {
      const b = document.body;
      return b ? b.innerText || b.textContent || '' : '';
    };
    const hit = (s: string) => (arg.exact ? s.includes(arg.text) : s.toLowerCase().includes(String(arg.text).toLowerCase()));
    const check = () => {
      const h = hit(read());
      if (arg.gone ? !h : h) {
        resolve({ ok: true, ms: Math.round(performance.now() - t0) });
        return true;
      }
      return false;
    };
    if (check()) return;
    const mo = new MutationObserver(() => {
      if (check()) mo.disconnect();
    });
    mo.observe(document.documentElement, { subtree: true, childList: true, characterData: true });
    setTimeout(() => {
      mo.disconnect();
      resolve({ ok: false, ms: Math.round(performance.now() - t0) });
    }, arg.timeoutMs || 5000);
  });
};

/**
 * Waits for the page to stop changing. Uses a MutationObserver, not polling:
 * resolves on the first idle frame instead of burning a fixed sleep.
 */
export async function settle(session: PageSession, timeoutMs = 500, quietMs = 0): Promise<SettleReport> {
  const started = Date.now();
  const r = await session.eval<SettleReport>(SETTLE_FN, { timeoutMs, quietMs }, { timeoutMs: timeoutMs + 2000 });
  return r ?? { settled: false, ms: Date.now() - started, reason: 'timeout-hard' };
}

export async function waitForText(
  session: PageSession,
  text: string,
  opts?: { gone?: boolean; timeoutMs?: number; exact?: boolean },
): Promise<{ ok: boolean; ms: number }> {
  const timeoutMs = opts?.timeoutMs ?? 5000;
  const r = await session.eval<{ ok: boolean; ms: number }>(
    WAIT_TEXT_FN,
    { text, gone: !!opts?.gone, exact: !!opts?.exact, timeoutMs },
    { timeoutMs: timeoutMs + 2000 },
  );
  return r ?? { ok: false, ms: timeoutMs };
}
