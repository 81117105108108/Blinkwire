import type { ToolDef, CallResult } from '../core/types.js';
import { text } from '../core/types.js';
import { settle } from '../core/wait.js';
import { validate } from '../core/schema.js';

/** Resolved lazily: tools/index.js imports batch.js, so touching it at module-eval would deadlock. */
let registry: Map<string, ToolDef> | undefined;
async function toolRegistry(): Promise<Map<string, ToolDef>> {
  if (!registry) {
    const { allTools } = await import('./index.js');
    registry = new Map<string, ToolDef>();
    for (const t of allTools) {
      registry.set(t.name, t);
      registry.set(`browser_${t.name}`, t);
    }
  }
  return registry;
}

/**
 * batch runs N tools inside ONE MCP round-trip. This is Blinkwire's single
 * biggest latency win: the model pays one request/response cycle instead of N.
 */
export const tools: ToolDef[] = [
  {
    name: 'batch',
    title: 'Run several actions at once',
    description:
      'Run several Blinkwire actions in ONE call. This is the biggest latency and context win available: you pay one round-trip instead of N. ' +
      'Each step is {tool, args}. Tool names may be bare ("click") or prefixed ("browser_click"). ' +
      'By default only failures (and the last step) have their full output inlined — use `include` to see more.',
    params: {
      steps: {
        type: 'array',
        description: 'Steps to run in order, each {tool: string, args: object}',
        required: true,
      },
      stopOnError: { type: 'boolean', description: 'Stop at the first failure (default true)', default: true },
      settle: { type: 'number', description: 'Milliseconds to wait for the page to settle after all steps' },
      include: { type: 'array', items: { type: 'integer' }, description: '1-based step indices whose full output to inline' },
    },
    async handler(args, ctx): Promise<CallResult> {
      const steps = (args.steps as Array<Record<string, unknown>>) ?? [];
      if (steps.length === 0) throw new Error('Provide at least one step.');
      const stopOnError = args.stopOnError !== false;
      const include = new Set((args.include as number[] | undefined) ?? []);
      const byName = await toolRegistry();

      const t0 = Date.now();
      const lines: string[] = [];
      let ok = 0;
      let failed = 0;
      let aborted = false;

      for (let i = 0; i < steps.length; i++) {
        const step = steps[i]!;
        const label = `${i + 1}. ${String(step.tool ?? '?')}`;
        if (aborted) {
          lines.push(`${label} skipped`);
          continue;
        }
        const tool = byName.get(String(step.tool ?? ''));
        if (!tool) {
          failed++;
          lines.push(`${label} ERR: unknown tool "${String(step.tool ?? '')}"`);
          if (stopOnError) aborted = true;
          continue;
        }
        const s0 = Date.now();
        try {
          const parsed = validate(tool.params, step.args ?? {});
          const r = await tool.handler(parsed, ctx);
          const ms = Date.now() - s0;
          ok++;
          lines.push(`${label} ok ${ms}ms`);
          if (include.has(i + 1) || i === steps.length - 1 || r.isError) {
            const body = r.kind === 'text' ? r.text : r.kind === 'image' ? `(image, ${r.data.length} b64 chars)` : r.text;
            for (const l of String(body).split('\n')) lines.push(`   ${l}`);
          }
        } catch (e) {
          failed++;
          const msg = (e as Error).message.split('\n')[0] ?? String(e);
          lines.push(`${label} ERR: ${msg}`);
          if (stopOnError) aborted = true;
        }
      }

      let tail = '';
      if (typeof args.settle === 'number' && args.settle > 0) {
        const rep = await settle(ctx.session, args.settle as number);
        tail = `\n— settled in ${rep.ms}ms`;
      }
      lines.push(`— ${ok}/${steps.length} ok${failed ? `, ${failed} failed` : ''}, ${Date.now() - t0}ms total${tail ? tail.slice(1) : ''}`);
      return text(ctx.budget.clamp(lines.join('\n')), { ok, failed, total: steps.length, ms: Date.now() - t0 });
    },
  },
];
