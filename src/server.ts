import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

import type { BlinkwireConfig } from './config.js';
import type { CallResult, ToolContext } from './core/types.js';
import { allTools, toolMap } from './tools/index.js';
import { takeOverride } from './tools/tabs.js';
import { BrowserConnection } from './cdp/connection.js';
import { RefStore } from './core/refs.js';
import { Budget } from './core/budget.js';
import { validate, toJsonSchema } from './core/schema.js';
import { BlinkwireError, asBlinkwireError } from './core/errors.js';
import { debug } from './core/log.js';

const INSTRUCTIONS = [
  'Blinkwire — fast CDP browser control. It attaches to a Chrome the user already runs.',
  'RULE 1: never start a browser yourself. No shell commands, no playwright, no new Chrome.',
  'If a call reports no browser, use browser_connect — it auto-discovers the user\'s running Chrome.',
  'A managed browser exists only if the server was started with --launch; otherwise ask the user',
  'to restart their Chrome with --remote-debugging-port=9222. Your job is the page, not the process.',
  'Workflow: browser_snapshot -> act on a [ref=eN] -> browser_snapshot only when the page changed.',
  'Prefer refs over coordinates; prefer browser_find over re-reading the whole snapshot;',
  'use browser_batch to run several actions in ONE call (biggest latency win).',
].join(' ');

function toMcpContent(r: CallResult): Array<Record<string, unknown>> {
  if (r.kind === 'image') {
    const out: Array<Record<string, unknown>> = [{ type: 'image', data: r.data, mimeType: r.mime }];
    if (r.text) out.push({ type: 'text', text: r.text });
    return out;
  }
  if (r.kind === 'resource') {
    return [{ type: 'resource', resource: { uri: r.uri, mimeType: r.mime, text: r.text } }];
  }
  return [{ type: 'text', text: r.text }];
}

export async function createServer(cfg: BlinkwireConfig): Promise<{ close(): Promise<void> }> {
  const server = new Server({ name: 'blinkwire', version: '0.1.0' }, { capabilities: { tools: {} }, instructions: INSTRUCTIONS });

  let conn: BrowserConnection | undefined;
  const budgets = new Budget(cfg.maxOutputTokens);
  const refStores = new WeakMap<object, RefStore>();
  let requestChain: Promise<void> = Promise.resolve();

  /**
   * MCP transports can deliver tool calls concurrently, while sessions and ref
   * stores are mutable shared state. Serialize execution per server instance.
   * Each call also carries a hard ceiling (timeoutTool) so one wedged action
   * can never park the whole queue forever.
   */
  async function serializeToolCall<T>(task: () => Promise<T>, extraMs = 0): Promise<T> {
    const ceiling = Math.max(1000, cfg.timeoutTool) + Math.max(0, extraMs);
    const guarded = async (): Promise<T> => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<T>((_, reject) => {
        timer = setTimeout(
          () => reject(new BlinkwireError(`Tool call exceeded its ${ceiling}ms ceiling.`, 'tool_timeout')),
          ceiling,
        );
      });
      try {
        return await Promise.race([task(), timeout]);
      } finally {
        clearTimeout(timer);
      }
    };
    const result = requestChain.then(guarded, guarded);
    requestChain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async function getConn(): Promise<BrowserConnection> {
    const o = takeOverride();
    if (o) {
      try {
        await conn?.close();
      } catch {
        /* ignore */
      }
      conn = o;
    }
    if (!conn || conn.current.closed) {
      conn = await BrowserConnection.open(cfg);
    }
    return conn;
  }

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: allTools.map((t) => ({
      name: cfg.prefix + t.name,
      title: t.title,
      description: t.description,
      inputSchema: toJsonSchema(t.params ?? {}),
      annotations: {
        title: t.title,
        readOnlyHint: t.readOnly === true,
        destructiveHint: t.destructive === true,
      },
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const t0 = Date.now();
    const name = String(req.params?.name ?? '');
    const base = name.startsWith(cfg.prefix) ? name.slice(cfg.prefix.length) : name;
    const tool = toolMap.get(base);
    if (!tool) {
      const known = allTools.map((t) => cfg.prefix + t.name).join(', ');
      return { content: [{ type: 'text', text: `Unknown tool "${name}". Known tools: ${known}` }], isError: true };
    }
    // An explicit wait_for must be allowed to run its course.
    const rawArgs = (req.params?.arguments ?? {}) as { time?: unknown };
    const extraMs =
      base === 'wait_for' && typeof rawArgs.time === 'number' && rawArgs.time > 0 ? rawArgs.time * 1000 : 0;
    return serializeToolCall(async () => {
    try {
      const args = validate(tool.params, req.params?.arguments ?? {});
      const c = await getConn();
      const session = c.current;
      let refs = refStores.get(session);
      if (!refs) {
        refs = new RefStore(session);
        refStores.set(session, refs);
      }
      const sessionRefs: RefStore = refs;
      const makeRun = (depth: number) => {
        return async (toolNameOrBase: string, rawArgs: Record<string, unknown>): Promise<CallResult> => {
          if (depth > 2) {
            throw new BlinkwireError('Maximum nested tool execution depth exceeded', 'max_depth_exceeded');
          }
          const baseTarget = toolNameOrBase.startsWith(cfg.prefix)
            ? toolNameOrBase.slice(cfg.prefix.length)
            : toolNameOrBase;
          if (baseTarget === 'batch') {
            throw new BlinkwireError('Recursive batch execution is forbidden', 'bad_batch_recursion');
          }
          const targetTool = toolMap.get(baseTarget);
          if (!targetTool) {
            throw new BlinkwireError(`Unknown tool "${toolNameOrBase}"`, 'unknown_tool');
          }
          const parsed = validate(targetTool.params, rawArgs ?? {});
          const nestedCtx: ToolContext = {
            conn: c,
            session,
            cfg,
            refs: sessionRefs,
            budget: budgets,
            toolName: (b) => cfg.prefix + b,
            run: makeRun(depth + 1),
          };
          return await targetTool.handler(parsed, nestedCtx);
        };
      };

      const ctx: ToolContext = {
        conn: c,
        session,
        cfg,
        refs,
        budget: budgets,
        toolName: (b) => cfg.prefix + b,
        run: makeRun(1),
      };
      const r = await tool.handler(args, ctx);
      const ms = Date.now() - t0;
      debug(`${name} ${ms}ms`);
      return {
        content: toMcpContent(r),
        ...(r.isError ? { isError: true } : {}),
        ...(cfg.debug || r.meta ? { _meta: { ...(r.meta ?? {}), ms } } : {}),
      };
    } catch (e) {
      const be = asBlinkwireError(e);
      debug(`${name} failed:`, be.message);
      return { content: toMcpContent(be.toCallResult()), isError: true };
    }
    }, extraMs);
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);

  return {
    async close() {
      try {
        await server.close();
      } catch {
        /* ignore */
      }
      try {
        await conn?.close();
      } catch {
        /* ignore */
      }
    },
  };
}
