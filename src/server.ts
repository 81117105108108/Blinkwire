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
  'Blinkwire — fast CDP browser control. Attaches to a Chrome you already run.',
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
    try {
      const args = validate(tool.params, req.params?.arguments ?? {});
      const c = await getConn();
      const session = c.current;
      let refs = refStores.get(session);
      if (!refs) {
        refs = new RefStore(session);
        refStores.set(session, refs);
      }
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
            refs: refs!,
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
