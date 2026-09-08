import type { ToolDef, CallResult } from '../core/types.js';
import type { PageSession } from '../cdp/session.js';
import { text } from '../core/types.js';
import { BlinkwireError } from '../core/errors.js';

type Ctx = Parameters<ToolDef['handler']>[1];
type StorageKind = 'localStorage' | 'sessionStorage';

interface Cookie {
  name: string;
  value: string;
  domain?: string;
  path?: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: string;
}

function cookieLine(c: Cookie): string {
  const bits = [`${c.name}=${c.value}`];
  if (c.domain) bits.push(`domain=${c.domain}`);
  if (c.path) bits.push(`path=${c.path}`);
  if (c.expires !== undefined && c.expires > 0) bits.push(`expires=${new Date(c.expires * 1000).toISOString()}`);
  if (c.httpOnly) bits.push('httpOnly');
  if (c.secure) bits.push('secure');
  if (c.sameSite) bits.push(`sameSite=${c.sameSite}`);
  return bits.join('; ');
}

async function cookies(ctx: Ctx): Promise<Cookie[]> {
  await ctx.session.ensure('Network');
  const r = await ctx.session.cdp.send<{ cookies: Cookie[] }>('Network.getCookies');
  return r.cookies ?? [];
}

/** One eval per web-storage operation. */
async function storeOp(
  ctx: Ctx,
  kind: StorageKind,
  op: 'list' | 'get' | 'set' | 'delete' | 'clear',
  key?: string,
  value?: string,
): Promise<string> {
  const r = await ctx.session.eval<{ ok: boolean; result?: string; error?: string }>(
    `(function(a){
      try {
        var s = window[a.kind];
        if (!s) return { ok:false, error:'storage unavailable' };
        if (a.op === 'list') {
          var out = [];
          for (var i = 0; i < s.length && i < 200; i++) {
            var k = s.key(i);
            out.push(k + ' = ' + String(s.getItem(k)).slice(0, 4000));
          }
          return { ok:true, result: out.join('\\n') };
        }
        if (a.op === 'get') {
          var v = s.getItem(a.key);
          if (v === null) return { ok:false, error:'no such key' };
          return { ok:true, result: String(v) };
        }
        if (a.op === 'set') { s.setItem(a.key, a.value); return { ok:true, result:'set' }; }
        if (a.op === 'delete') { s.removeItem(a.key); return { ok:true, result:'deleted' }; }
        s.clear(); return { ok:true, result:'cleared' };
      } catch (e) { return { ok:false, error: String(e) }; }
    })`,
    { kind, op, key: key ?? null, value: value ?? null },
    { awaitPromise: false },
  );
  if (!r?.ok) {
    throw new BlinkwireError(
      `${kind} ${op} failed${r?.error ? `: ${r.error}` : ''}`,
      'storage_denied',
      'The page may be on an opaque origin, or block storage access.',
    );
  }
  return r.result ?? '';
}

function storageTools(kind: StorageKind, prefix: string, label: string): ToolDef[] {
  const keyField = { type: 'string' as const, description: `${label} key`, required: true };
  return [
    {
      name: `${prefix}_list`,
      title: `List ${label}`,
      description: `List all ${label} key-value pairs for the current origin.`,
      readOnly: true,
      async handler(_a, ctx): Promise<CallResult> {
        const out = await storeOp(ctx, kind, 'list');
        return text(ctx.budget.clamp(out || `(${label} is empty)`));
      },
    },
    {
      name: `${prefix}_get`,
      title: `Get ${label} item`,
      description: `Read one ${label} key.`,
      params: { key: keyField },
      readOnly: true,
      async handler(a, ctx): Promise<CallResult> {
        return text(await storeOp(ctx, kind, 'get', a.key as string));
      },
    },
    {
      name: `${prefix}_set`,
      title: `Set ${label} item`,
      description: `Write one ${label} key.`,
      params: { key: keyField, value: { type: 'string', description: 'Value to store', required: true } },
      async handler(a, ctx): Promise<CallResult> {
        await storeOp(ctx, kind, 'set', a.key as string, String(a.value));
        return text(`Set ${a.key} in ${label}.`);
      },
    },
    {
      name: `${prefix}_delete`,
      title: `Delete ${label} item`,
      description: `Remove one ${label} key.`,
      params: { key: keyField },
      async handler(a, ctx): Promise<CallResult> {
        await storeOp(ctx, kind, 'delete', a.key as string);
        return text(`Deleted ${a.key} from ${label}.`);
      },
    },
    {
      name: `${prefix}_clear`,
      title: `Clear ${label}`,
      description: `Remove every ${label} key for the current origin.`,
      async handler(_a, ctx): Promise<CallResult> {
        await storeOp(ctx, kind, 'clear');
        return text(`Cleared ${label}.`);
      },
    },
  ];
}

interface Route {
  pattern: string;
  status: number;
  body?: string;
  contentType?: string;
  headers?: string[];
}

const routes = new Map<string, Route>();
const wired = new WeakMap<PageSession, boolean>();

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${escaped.replace(/\*/g, '.*').replace(/\?/g, '.')}$`);
}

function parseHeaders(list: string[] | undefined): Array<{ name: string; value: string }> {
  return (list ?? [])
    .map((h) => {
      const i = h.indexOf(':');
      return i === -1 ? null : { name: h.slice(0, i).trim(), value: h.slice(i + 1).trim() };
    })
    .filter((h): h is { name: string; value: string } => h !== null);
}

function wireFetch(ctx: Ctx): void {
  if (wired.get(ctx.session)) return;
  wired.set(ctx.session, true);
  ctx.session.cdp.on('Fetch.requestPaused', (p: any) => {
    const url = String(p?.request?.url ?? '');
    const id = String(p?.requestId ?? '');
    void (async () => {
      try {
        let hit: Route | undefined;
        for (const r of routes.values()) {
          if (globToRegExp(r.pattern).test(url)) {
            hit = r;
            break;
          }
        }
        if (!hit) {
          await ctx.session.cdp.send('Fetch.continueRequest', { requestId: id });
          return;
        }
        const headers = [{ name: 'Content-Type', value: hit.contentType ?? 'application/json' }, ...parseHeaders(hit.headers)];
        await ctx.session.cdp.send('Fetch.fulfillRequest', {
          requestId: id,
          responseCode: hit.status,
          responseHeaders: headers,
          ...(hit.body !== undefined ? { body: Buffer.from(hit.body, 'utf8').toString('base64') } : {}),
        });
      } catch {
        try {
          await ctx.session.cdp.send('Fetch.continueRequest', { requestId: id });
        } catch {
          /* ignore */
        }
      }
    })();
  });
}

export const tools: ToolDef[] = [
  {
    name: 'cookie_list',
    title: 'List cookies',
    description: 'List cookies for the current page, optionally filtered by domain or path.',
    params: {
      domain: { type: 'string', description: 'Filter by domain substring' },
      path: { type: 'string', description: 'Filter by path prefix' },
    },
    readOnly: true,
    async handler(a, ctx): Promise<CallResult> {
      let list = await cookies(ctx);
      if (a.domain) list = list.filter((c) => (c.domain ?? '').includes(a.domain as string));
      if (a.path) list = list.filter((c) => (c.path ?? '').startsWith(a.path as string));
      if (list.length === 0) return text('(no cookies)');
      return text(ctx.budget.clamp(list.map(cookieLine).join('\n')), { count: list.length });
    },
  },
  {
    name: 'cookie_get',
    title: 'Get cookie',
    description: 'Read one cookie by name.',
    params: { name: { type: 'string', description: 'Cookie name', required: true } },
    readOnly: true,
    async handler(a, ctx): Promise<CallResult> {
      const c = (await cookies(ctx)).find((x) => x.name === a.name);
      if (!c) throw new BlinkwireError(`No cookie named ${JSON.stringify(a.name)}.`, 'no_cookie');
      return text(cookieLine(c));
    },
  },
  {
    name: 'cookie_set',
    title: 'Set cookie',
    description: 'Create or overwrite a cookie on the current page.',
    params: {
      name: { type: 'string', description: 'Cookie name', required: true },
      value: { type: 'string', description: 'Cookie value', required: true },
      domain: { type: 'string', description: 'Cookie domain' },
      path: { type: 'string', description: 'Cookie path (default /)' },
      expires: { type: 'number', description: 'Unix timestamp in seconds' },
      httpOnly: { type: 'boolean', description: 'HTTP only' },
      secure: { type: 'boolean', description: 'Secure' },
      sameSite: { type: 'string', enum: ['Strict', 'Lax', 'None'], description: 'SameSite policy' },
    },
    async handler(a, ctx): Promise<CallResult> {
      const url = await ctx.session.url();
      await ctx.session.ensure('Network');
      await ctx.session.cdp.send('Network.setCookie', {
        name: a.name,
        value: a.value,
        ...(a.domain ? { domain: a.domain } : { url }),
        path: (a.path as string | undefined) ?? '/',
        ...(a.expires !== undefined ? { expires: a.expires } : {}),
        ...(a.httpOnly !== undefined ? { httpOnly: a.httpOnly } : {}),
        ...(a.secure !== undefined ? { secure: a.secure } : {}),
        ...(a.sameSite ? { sameSite: a.sameSite } : {}),
      });
      return text(`Set cookie ${a.name}.`);
    },
  },
  {
    name: 'cookie_delete',
    title: 'Delete cookie',
    description: 'Delete one cookie by name.',
    params: { name: { type: 'string', description: 'Cookie name', required: true } },
    async handler(a, ctx): Promise<CallResult> {
      const url = await ctx.session.url();
      await ctx.session.ensure('Network');
      await ctx.session.cdp.send('Network.deleteCookies', { name: a.name, url });
      return text(`Deleted cookie ${a.name}.`);
    },
  },
  {
    name: 'cookie_clear',
    title: 'Clear cookies',
    description: 'Delete every cookie in the browser.',
    async handler(_a, ctx): Promise<CallResult> {
      await ctx.session.ensure('Network');
      await ctx.session.cdp.send('Network.clearBrowserCookies');
      return text('Cleared all cookies.');
    },
  },
  ...storageTools('localStorage', 'localstorage', 'localStorage'),
  ...storageTools('sessionStorage', 'sessionstorage', 'sessionStorage'),
  {
    name: 'network_state_set',
    title: 'Set network state',
    description: 'Go offline or back online. Useful for testing error paths.',
    params: { state: { type: 'string', enum: ['online', 'offline'], description: 'Desired state', required: true } },
    async handler(a, ctx): Promise<CallResult> {
      const offline = a.state === 'offline';
      await ctx.session.ensure('Network');
      await ctx.session.cdp.send('Network.emulateNetworkConditions', {
        offline,
        latency: 0,
        downloadThroughput: offline ? 0 : -1,
        uploadThroughput: offline ? 0 : -1,
      });
      return text(`Network is now ${a.state}.`);
    },
  },
  {
    name: 'route',
    title: 'Mock network requests',
    description: 'Stub responses for URLs matching a pattern. Restart mocking by re-adding the route.',
    params: {
      pattern: { type: 'string', description: 'URL pattern with * wildcards, e.g. **/api/users', required: true },
      status: { type: 'integer', description: 'HTTP status to return (default 200)', default: 200 },
      body: { type: 'string', description: 'Response body' },
      contentType: { type: 'string', description: 'Content-Type header' },
      headers: { type: 'array', items: { type: 'string' }, description: 'Extra headers as "Name: Value"' },
    },
    async handler(a, ctx): Promise<CallResult> {
      const pattern = a.pattern as string;
      await ctx.session.ensure('Fetch');
      wireFetch(ctx);
      routes.set(pattern, {
        pattern,
        status: (a.status as number | undefined) ?? 200,
        ...(a.body !== undefined ? { body: String(a.body) } : {}),
        ...(a.contentType ? { contentType: a.contentType as string } : {}),
        ...(a.headers ? { headers: a.headers as string[] } : {}),
      });
      await ctx.session.cdp.send('Fetch.enable', { patterns: [{ urlPattern: pattern }] });
      return text(`Routing ${pattern} -> ${(a.status as number | undefined) ?? 200}`, { routes: routes.size });
    },
  },
  {
    name: 'route_list',
    title: 'List network routes',
    description: 'Show the active mocked routes.',
    readOnly: true,
    async handler(): Promise<CallResult> {
      if (routes.size === 0) return text('(no active routes)');
      return text([...routes.values()].map((r) => `${r.pattern} -> ${r.status} ${r.contentType ?? ''}`).join('\n'));
    },
  },
  {
    name: 'unroute',
    title: 'Remove network routes',
    description: 'Remove one mocked route, or all of them when no pattern is given.',
    params: { pattern: { type: 'string', description: 'Pattern to remove (omit to remove all)' } },
    async handler(a, ctx): Promise<CallResult> {
      if (a.pattern) routes.delete(a.pattern as string);
      else routes.clear();
      if (routes.size === 0) {
        try {
          await ctx.session.cdp.send('Fetch.disable');
        } catch {
          /* ignore */
        }
      }
      return text(routes.size === 0 ? 'Removed all routes.' : `Removed ${a.pattern}.`, { routes: routes.size });
    },
  },
];
