import WebSocket from 'ws';
import { BlinkwireError, TimeoutError } from '../core/errors.js';

export interface SendOpts {
  timeoutMs?: number;
  sessionId?: string;
}

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
  method: string;
}

type Listener = (params: any) => void;

/** A CDP endpoint. `sessionId` scopes the view to one flattened target. */
export class CdpSession {
  constructor(
    private readonly owner: CdpConnection,
    readonly sessionId?: string,
  ) {}

  send<T = any>(method: string, params?: Record<string, unknown>, opts?: SendOpts): Promise<T> {
    return this.owner.send<T>(method, params, {
      timeoutMs: opts?.timeoutMs,
      sessionId: opts?.sessionId ?? this.sessionId,
    });
  }

  on(method: string, cb: Listener): () => void {
    return this.owner.on(method, cb, this.sessionId);
  }

  onceFor<T = any>(method: string, predicate: (p: T) => boolean, timeoutMs = 5000): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        off();
        reject(new TimeoutError(`Timed out after ${timeoutMs}ms waiting for CDP event ${method}.`));
      }, timeoutMs);
      const off = this.on(method, (p) => {
        if (!predicate(p as T)) return;
        clearTimeout(timer);
        off();
        resolve(p as T);
      });
    });
  }

  get closed(): boolean {
    return this.owner.closed;
  }
}

export class CdpConnection {
  private ws!: WebSocket;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly listeners = new Map<string, Set<{ cb: Listener; sessionId?: string }>>();
  private readonly sessions = new Map<string, CdpSession>();
  private _closed = false;

  static async connect(wsUrl: string, timeoutMs = 10000): Promise<CdpConnection> {
    const c = new CdpConnection();
    await c.open(wsUrl, timeoutMs);
    return c;
  }

  private open(wsUrl: string, timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl, { perMessageDeflate: false, maxPayload: 512 * 1024 * 1024 });
      this.ws = ws;
      const timer = setTimeout(() => {
        reject(
          new TimeoutError(
            `Could not reach ${wsUrl} within ${timeoutMs}ms.`,
            'Start Chrome with --remote-debugging-port=9222, or run blinkwire with --launch.',
          ),
        );
        try { ws.terminate(); } catch { /* ignore */ }
      }, timeoutMs);

      ws.on('open', () => {
        clearTimeout(timer);
        resolve();
      });
      ws.on('error', (e: Error) => {
        clearTimeout(timer);
        reject(new BlinkwireError(`WebSocket error: ${e.message}`, 'cdp_transport'));
      });
      ws.on('close', () => {
        clearTimeout(timer);
        this.handleClose();
      });
      ws.on('message', (raw: Buffer) => this.onMessage(raw));
    });
  }

  private handleClose(): void {
    if (this._closed) return;
    this._closed = true;
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new BlinkwireError(`CDP connection closed while awaiting ${p.method}.`, 'cdp_closed'));
    }
    this.pending.clear();
  }

  private onMessage(raw: Buffer): void {
    let msg: any;
    try {
      msg = JSON.parse(raw.toString('utf8'));
    } catch {
      return;
    }
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) {
        p.reject(
          new BlinkwireError(
            `CDP ${p.method} failed: ${msg.error.message ?? 'unknown error'}${msg.error.code ? ` (code ${msg.error.code})` : ''}`,
            'cdp_error',
          ),
        );
      } else {
        p.resolve(msg.result);
      }
      return;
    }
    if (msg.method) {
      const set = this.listeners.get(msg.method);
      if (!set) return;
      for (const l of set) {
        if (l.sessionId !== undefined && msg.sessionId !== l.sessionId) continue;
        try {
          l.cb(msg.params);
        } catch {
          /* a bad listener must never break the transport */
        }
      }
    }
  }

  send<T = any>(method: string, params?: Record<string, unknown>, opts?: SendOpts): Promise<T> {
    if (this._closed || this.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(
        new BlinkwireError(`CDP socket is not open (sending ${method}).`, 'cdp_closed', 'Re-attach with browser_connect.'),
      );
    }
    const id = this.nextId++;
    const timeoutMs = opts?.timeoutMs ?? 30000;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new TimeoutError(`CDP ${method} timed out after ${timeoutMs}ms.`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer, method });
      try {
        this.ws.send(JSON.stringify({ id, method, params: params ?? {}, ...(opts?.sessionId ? { sessionId: opts.sessionId } : {}) }));
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new BlinkwireError(`Failed to send CDP ${method}: ${(e as Error).message}`, 'cdp_transport'));
      }
    });
  }

  on(method: string, cb: Listener, sessionId?: string): () => void {
    let set = this.listeners.get(method);
    if (!set) {
      set = new Set();
      this.listeners.set(method, set);
    }
    const entry = { cb, sessionId };
    set.add(entry);
    return () => {
      set!.delete(entry);
    };
  }

  session(sessionId: string): CdpSession {
    let s = this.sessions.get(sessionId);
    if (!s) {
      s = new CdpSession(this, sessionId);
      this.sessions.set(sessionId, s);
    }
    return s;
  }

  async close(): Promise<void> {
    this._closed = true;
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new BlinkwireError('CDP connection closed.', 'cdp_closed'));
    }
    this.pending.clear();
    try {
      this.ws.close();
    } catch {
      /* ignore */
    }
  }

  get closed(): boolean {
    return this._closed;
  }
}
