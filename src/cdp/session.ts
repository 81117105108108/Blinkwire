import type { CdpSession } from './client.js';
import type { BrowserConnection } from './connection.js';
import { Ring } from '../core/ring.js';
import { BlinkwireError, EvalError } from '../core/errors.js';
import { debug } from '../core/log.js';

export type Domain =
  | 'Runtime' | 'Page' | 'DOM' | 'CSS' | 'Log' | 'Network'
  | 'Fetch' | 'Emulation' | 'Input' | 'Target' | 'Security' | 'Storage';

export interface EvalOpts {
  awaitPromise?: boolean;
  timeoutMs?: number;
  returnByValue?: boolean;
}

export interface ConsoleEntry {
  seq: number;
  ts: number;
  /** Main-frame navigation counter at the time of the message. */
  nav: number;
  level: 'error' | 'warning' | 'info' | 'debug';
  text: string;
  url?: string;
  line?: number;
}

export interface NetworkEntry {
  seq: number;
  ts: number;
  requestId: string;
  method: string;
  url: string;
  type?: string;
  status?: number;
  size?: number;
  failed?: boolean;
  fromCache?: boolean;
}

export interface PendingDialog {
  type: 'alert' | 'confirm' | 'prompt' | 'beforeunload';
  message: string;
  defaultPrompt?: string;
  resolve(p: { accept: boolean; promptText?: string }): void;
}

export interface Buffers {
  console: Ring<ConsoleEntry>;
  network: Ring<NetworkEntry>;
  dialogs: PendingDialog[];
  navSeq: number;
}

const DOMAIN_METHOD: Record<Domain, string> = {
  Runtime: 'Runtime.enable',
  Page: 'Page.enable',
  DOM: 'DOM.enable',
  CSS: 'CSS.enable',
  Log: 'Log.enable',
  Network: 'Network.enable',
  Fetch: 'Fetch.enable',
  Emulation: 'Emulation.enable',
  Input: 'Input.enable',
  Target: 'Target.setDiscoverTargets',
  Security: 'Security.enable',
  Storage: 'Storage.enable',
};

const STATIC_TYPES = new Set(['Image', 'Font', 'Stylesheet', 'Media', 'WebSocket', 'Manifest']);

function levelOf(type: string): ConsoleEntry['level'] {
  switch (type) {
    case 'error': return 'error';
    case 'warning':
    case 'warn': return 'warning';
    case 'debug':
    case 'trace':
    case 'verbose': return 'debug';
    default: return 'info';
  }
}

function argText(args: any[] | undefined): string {
  if (!args) return '';
  return args
    .map((a) => {
      if (a?.value !== undefined) return typeof a.value === 'string' ? a.value : JSON.stringify(a.value);
      if (a?.description) return a.description;
      if (a?.unserializableValue) return String(a.unserializableValue);
      return a?.type ?? '';
    })
    .join(' ');
}

export class PageSession {
  readonly buffers: Buffers = {
    console: new Ring<ConsoleEntry>(500),
    network: new Ring<NetworkEntry>(500),
    dialogs: [],
    navSeq: 0,
  };

  private readonly enabled = new Set<Domain>();
  private readonly enabling = new Map<Domain, Promise<void>>();
  private bootPromise: Promise<void>;
  private netIndex = new Map<string, NetworkEntry>();
  private rootCache: { navSeq: number; nodeId: number } | undefined;
  private _closed = false;
  private _url = '';
  private _title = '';

  constructor(
    readonly conn: BrowserConnection,
    readonly targetId: string,
    readonly cdp: CdpSession,
  ) {
    this.bootPromise = this.enableBoot();
    this.wire();
  }

  private async enableBoot(): Promise<void> {
    try {
      await Promise.all([this.ensure('Runtime'), this.ensure('Page')]);
    } catch (e) {
      debug('boot enable failed', e);
    }
  }

  private wire(): void {
    const nav = () => this.buffers.navSeq;
    this.cdp.on('Runtime.consoleAPICalled', (p: any) => {
      this.buffers.console.push({
        seq: this.buffers.console.seq + 1,
        ts: Date.now(),
        nav: nav(),
        level: levelOf(p?.type ?? 'log'),
        text: argText(p?.args),
        url: p?.stackTrace?.callFrames?.[0]?.url,
        line: p?.stackTrace?.callFrames?.[0]?.lineNumber,
      });
    });
    this.cdp.on('Runtime.exceptionThrown', (p: any) => {
      const d = p?.exceptionDetails;
      this.buffers.console.push({
        seq: this.buffers.console.seq + 1,
        ts: Date.now(),
        nav: nav(),
        level: 'error',
        text: d?.exception?.description ?? d?.text ?? 'Uncaught exception',
        url: d?.url,
        line: d?.lineNumber,
      });
    });
    this.cdp.on('Log.entryAdded', (p: any) => {
      const e = p?.entry;
      if (!e) return;
      if (e.source === 'network') return; // duplicated by the Network domain
      this.buffers.console.push({
        seq: this.buffers.console.seq + 1,
        ts: Date.now(),
        nav: nav(),
        level: levelOf(e.level ?? 'info'),
        text: e.text ?? '',
        url: e.url,
        line: e.lineNumber,
      });
    });
    this.cdp.on('Page.frameNavigated', (p: any) => {
      if (p?.frame?.parentId !== undefined) return;
      this._url = p.frame.url ?? '';
      this.buffers.navSeq++;
      this.netIndex.clear();
    });
    this.cdp.on('Page.javascriptDialogOpening', (p: any) => {
      this.buffers.dialogs.push({
        type: p?.type ?? 'alert',
        message: p?.message ?? '',
        defaultPrompt: p?.defaultPrompt,
        resolve: () => {},
      });
    });
    this.cdp.on('Page.javascriptDialogClosed', () => {
      this.buffers.dialogs.shift();
    });

    this.cdp.on('Network.requestWillBeSent', (p: any) => {
      const e: NetworkEntry = {
        seq: this.buffers.network.seq + 1,
        ts: Date.now(),
        requestId: p.requestId,
        method: p.request?.method ?? 'GET',
        url: p.request?.url ?? '',
        type: p.type,
      };
      this.netIndex.set(p.requestId, e);
      this.buffers.network.push(e);
    });
    this.cdp.on('Network.responseReceived', (p: any) => {
      const e = this.netIndex.get(p.requestId);
      if (!e) return;
      e.status = p.response?.status;
      e.type = p.type ?? e.type;
      e.fromCache = !!p.response?.fromDiskCache;
    });
    this.cdp.on('Network.loadingFinished', (p: any) => {
      const e = this.netIndex.get(p.requestId);
      if (e) e.size = p.encodedDataLength;
      this.netIndex.delete(p.requestId);
    });
    this.cdp.on('Network.loadingFailed', (p: any) => {
      const e = this.netIndex.get(p.requestId);
      if (e) {
        e.failed = true;
        e.status = undefined;
      }
      this.netIndex.delete(p.requestId);
    });
  }

  async ensure(...domains: Domain[]): Promise<void> {
    await Promise.all(
      domains.map((d) => {
        if (this.enabled.has(d)) return undefined;
        let p = this.enabling.get(d);
        if (!p) {
          const method = DOMAIN_METHOD[d];
          const params: Record<string, unknown> =
            d === 'Network' ? { maxResourceBufferSize: 10_000_000, maxTotalBufferSize: 50_000_000 } : {};
          p = this.cdp
            .send(method, params)
            .then(() => {
              this.enabled.add(d);
              this.enabling.delete(d);
            })
            .catch((e: Error) => {
              this.enabling.delete(d);
              throw e;
            });
          this.enabling.set(d, p);
        }
        return p;
      }),
    );
  }

  hasDomain(d: Domain): boolean {
    return this.enabled.has(d);
  }

  /** One round trip. `fn` is serialised with .toString() — keep it self-contained. */
  async eval<R = unknown>(fn: ((arg: any) => unknown) | string, arg?: unknown, opts?: EvalOpts): Promise<R> {
    await this.bootPromise;
    const expr = typeof fn === 'string' ? fn : fn.toString();
    const expression = `(${expr})(${JSON.stringify(arg ?? null)})`;
    const res = await this.cdp.send<any>(
      'Runtime.evaluate',
      {
        expression,
        returnByValue: opts?.returnByValue ?? true,
        awaitPromise: opts?.awaitPromise ?? true,
        userGesture: true,
        allowUnsafeEvalBlockedByCSP: true,
      },
      { timeoutMs: opts?.timeoutMs },
    );
    return this.unwrap<R>(res);
  }

  /** One round trip against a live objectId. */
  async evalOn<R = unknown>(
    objectId: string,
    fn: ((el: any, arg: any) => unknown) | string,
    arg?: unknown,
    opts?: EvalOpts,
  ): Promise<R> {
    await this.bootPromise;
    // Runtime.callFunctionOn binds the target object to `this` — NOT to the first
    // parameter. Wrap so the callee still receives (element, arg).
    const src = typeof fn === 'string' ? fn : fn.toString();
    const functionDeclaration = `(function(__bwArg){ return (${src}).call(this, this, __bwArg); })`;
    const res = await this.cdp.send<any>(
      'Runtime.callFunctionOn',
      {
        objectId,
        functionDeclaration,
        arguments: [{ value: arg ?? null }],
        returnByValue: opts?.returnByValue ?? true,
        awaitPromise: opts?.awaitPromise ?? true,
        userGesture: true,
      },
      { timeoutMs: opts?.timeoutMs },
    );
    return this.unwrap<R>(res);
  }

  private unwrap<R>(res: any): R {
    if (res?.exceptionDetails) {
      const d = res.exceptionDetails;
      const msg = d.exception?.description ?? d.text ?? 'evaluation failed';
      throw new EvalError(msg.split('\n')[0] ?? msg);
    }
    return res?.result?.value as R;
  }

  async queryObjectId(selector: string, opts?: { rootObjectId?: string }): Promise<string> {
    const navSeq = this.buffers.navSeq;
    let rootNodeId = this.rootCache?.navSeq === navSeq ? this.rootCache.nodeId : undefined;
    if (rootNodeId === undefined) {
      await this.ensure('DOM');
      const doc = await this.cdp.send<{ root: { nodeId: number } }>('DOM.getDocument', { depth: 0, pierce: true });
      rootNodeId = doc.root.nodeId;
      this.rootCache = { navSeq, nodeId: rootNodeId };
    }
    const { nodeId } = await this.cdp.send<{ nodeId: number }>('DOM.querySelector', {
      nodeId: rootNodeId,
      selector,
    });
    if (!nodeId) {
      throw new BlinkwireError(
        `No element matches selector ${JSON.stringify(selector)}.`,
        'no_element',
        'Take a fresh browser_snapshot and use a ref like "e4", or fix the selector.',
      );
    }
    const { object } = await this.cdp.send<{ object: { objectId?: string } }>('DOM.resolveNode', { nodeId });
    if (!object?.objectId) throw new BlinkwireError(`Could not resolve ${selector} to an object.`, 'no_element');
    return object.objectId;
  }

  async url(): Promise<string> {
    if (!this._url) this._url = await this.eval<string>(() => location.href);
    return this._url;
  }

  async title(): Promise<string> {
    const t = await this.eval<string>(() => document.title);
    this._title = t ?? '';
    return this._title;
  }

  async close(): Promise<void> {
    await this.conn.closeTab(this.targetId);
  }

  markClosed(): void {
    this._closed = true;
  }

  get closed(): boolean {
    return this._closed;
  }
}

export { STATIC_TYPES };
