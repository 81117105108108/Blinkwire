import type { ToolDef, CallResult } from '../core/types.js';
import { text } from '../core/types.js';
import { BlinkwireError } from '../core/errors.js';
import { ensureInjected } from '../core/inject.js';
import { settle } from '../core/wait.js';

type Ctx = Parameters<ToolDef['handler']>[1];

const BUTTON_BIT: Record<string, number> = { left: 1, right: 2, middle: 4 };

export const tools: ToolDef[] = [
  {
    name: 'mouse_move_xy',
    title: 'Move mouse',
    description: 'Move the mouse to viewport coordinates (CSS pixels).',
    params: {
      x: { type: 'number', description: 'X coordinate', required: true },
      y: { type: 'number', description: 'Y coordinate', required: true },
    },
    async handler(args, ctx): Promise<CallResult> {
      await ctx.session.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: args.x, y: args.y });
      return text(`Moved mouse to ${args.x},${args.y}`);
    },
  },
  {
    name: 'mouse_click_xy',
    title: 'Click at coordinates',
    description: 'Click at viewport coordinates. Prefer browser_click with a ref — coordinates break when the layout shifts.',
    params: {
      x: { type: 'number', description: 'X coordinate', required: true },
      y: { type: 'number', description: 'Y coordinate', required: true },
      button: { type: 'string', enum: ['left', 'right', 'middle'], description: 'Mouse button (default left)', default: 'left' },
      doubleClick: { type: 'boolean', description: 'Double-click instead of a single click' },
    },
    async handler(args, ctx): Promise<CallResult> {
      const x = args.x as number;
      const y = args.y as number;
      const button = (args.button as string) ?? 'left';
      const bits = BUTTON_BIT[button] ?? 1;
      await ctx.session.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
      const counts = args.doubleClick === true ? [1, 2] : [1];
      for (const c of counts) {
        await ctx.session.cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, buttons: bits, clickCount: c });
        await ctx.session.cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, buttons: 0, clickCount: c });
      }
      const rep = await settle(ctx.session, ctx.cfg.timeoutSettle);
      return text(`Clicked at ${x},${y} — settled in ${rep.ms}ms`, { ms: rep.ms });
    },
  },
  {
    name: 'mouse_drag_xy',
    title: 'Drag between coordinates',
    description: 'Drag from one viewport coordinate to another.',
    params: {
      fromX: { type: 'number', description: 'Start X', required: true },
      fromY: { type: 'number', description: 'Start Y', required: true },
      toX: { type: 'number', description: 'End X', required: true },
      toY: { type: 'number', description: 'End Y', required: true },
    },
    async handler(args, ctx): Promise<CallResult> {
      const x0 = args.fromX as number;
      const y0 = args.fromY as number;
      const x1 = args.toX as number;
      const y1 = args.toY as number;
      await ctx.session.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x0, y: y0 });
      await ctx.session.cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: x0, y: y0, button: 'left', buttons: 1, clickCount: 1 });
      for (let i = 1; i <= 5; i++) {
        await ctx.session.cdp.send('Input.dispatchMouseEvent', {
          type: 'mouseMoved',
          x: x0 + ((x1 - x0) * i) / 5,
          y: y0 + ((y1 - y0) * i) / 5,
          buttons: 1,
        });
      }
      await ctx.session.cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x1, y: y1, button: 'left', buttons: 0, clickCount: 1 });
      const rep = await settle(ctx.session, ctx.cfg.timeoutSettle);
      return text(`Dragged ${x0},${y0} -> ${x1},${y1} — settled in ${rep.ms}ms`, { ms: rep.ms });
    },
  },
  {
    name: 'mouse_wheel',
    title: 'Scroll with the wheel',
    description: 'Dispatch a wheel event. Prefer browser_scroll — it is a single round-trip instead of a synthetic scroll animation.',
    params: {
      deltaX: { type: 'number', description: 'Horizontal scroll delta in pixels' },
      deltaY: { type: 'number', description: 'Vertical scroll delta in pixels (positive = down)' },
    },
    async handler(args, ctx): Promise<CallResult> {
      const dx = (args.deltaX as number | undefined) ?? 0;
      const dy = (args.deltaY as number | undefined) ?? 0;
      const pos = await ctx.session.eval<{ x: number; y: number }>('function(){ return { x: window.scrollX, y: window.scrollY }; }', undefined, {
        awaitPromise: false,
      });
      await ctx.session.cdp.send('Input.dispatchMouseEvent', {
        type: 'mouseWheel',
        x: pos?.x ?? 0,
        y: pos?.y ?? 0,
        deltaX: dx,
        deltaY: dy,
      });
      const rep = await settle(ctx.session, 0);
      return text(`Wheeled by ${dx},${dy} — settled in ${rep.ms}ms`, { ms: rep.ms });
    },
  },
  {
    name: 'scroll',
    title: 'Scroll the page',
    description:
      'Scroll the page or an element. ONE round-trip (no synthetic wheel events), and it reports whether you hit the end.',
    params: {
      target: { type: 'string', description: 'Element ref or CSS selector to scroll (default: the page)' },
      direction: { type: 'string', enum: ['up', 'down', 'left', 'right'], description: 'Direction to scroll (default down)', default: 'down' },
      amount: { type: 'number', description: 'Pixels to scroll (default 400)', default: 400 },
      x: { type: 'number', description: 'Absolute scrollLeft (overrides direction)' },
      y: { type: 'number', description: 'Absolute scrollTop (overrides direction)' },
    },
    async handler(args, ctx): Promise<CallResult> {
      await ensureInjected(ctx.session);
      const amount = (args.amount as number | undefined) ?? 400;
      const dir = (args.direction as string | undefined) ?? 'down';
      const absX = args.x as number | undefined;
      const absY = args.y as number | undefined;

      let expr: string;
      if (typeof absX === 'number' || typeof absY === 'number') {
        expr = `(function(a){ var t = a.el || document.scrollingElement || document.documentElement;
          if (t === document.scrollingElement || t === document.documentElement || t === document.body) { window.scrollTo(a.x, a.y); }
          else { if (typeof a.x === 'number') t.scrollLeft = a.x; if (typeof a.y === 'number') t.scrollTop = a.y; }
          return window.__bw.scroll(t, 0, 0); })`;
      } else {
        expr = `(function(a){ return window.__bw.scroll(a.el, a.dx, a.dy); })`;
      }

      let elExpr = 'null';
      const id = ctx.refs.check((args.target as string | undefined) ?? '');
      if (id) elExpr = `window.__bw.els[${JSON.stringify(id)}]`;
      else if (args.target) elExpr = `document.querySelector(${JSON.stringify(args.target)})`;

      const dx = dir === 'left' ? -amount : dir === 'right' ? amount : 0;
      const dy = dir === 'up' ? -amount : dir === 'down' ? amount : 0;

      const r = await ctx.session.eval<{ x: number; y: number; atEnd: boolean; atTop: boolean }>(
        `(function(a){ var el = ${elExpr}; return (${expr})(a); })`,
        { el: null, dx, dy, x: absX ?? null, y: absY ?? null },
        { awaitPromise: false },
      );
      if (!r) throw new BlinkwireError('Scroll failed — the target may not exist.', 'no_element');
      return text(`Scrolled to ${Math.round(r.x)},${Math.round(r.y)}${r.atEnd ? ' (end)' : ''}${r.atTop ? ' (top)' : ''}`, {
        x: r.x,
        y: r.y,
        atEnd: r.atEnd,
      });
    },
  },
];
