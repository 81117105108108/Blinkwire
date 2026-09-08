import type { ToolDef, CallResult } from '../core/types.js';
import { text } from '../core/types.js';
import { BlinkwireError } from '../core/errors.js';
import { settle } from '../core/wait.js';
import { ensureInjected } from '../core/inject.js';
import { keyDefinition, modifierBits, MODIFIER_BIT } from './keyboard.js';

const BUTTON_BIT: Record<string, number> = { left: 1, right: 2, middle: 4 };

async function press(ctx: Parameters<ToolDef['handler']>[1], key: string, extraModifiers = 0): Promise<void> {
  const parts = key.split('+');
  const name = parts.pop() ?? '';
  let bits = extraModifiers;
  for (const p of parts) {
    const b = MODIFIER_BIT[p.trim().toLowerCase()];
    if (!b) throw new BlinkwireError(`Unknown modifier "${p}". Use Alt, Ctrl, Meta or Shift.`, 'bad_arguments');
    bits |= b;
  }
  const d = keyDefinition(name.trim());
  const shift = bits & MODIFIER_BIT.shift!;
  const payload: Record<string, unknown> = {
    type: 'keyDown',
    modifiers: bits,
    key: d.key,
    code: d.code,
    windowsVirtualKeyCode: d.windowsVirtualKeyCode,
    nativeVirtualKeyCode: d.nativeVirtualKeyCode,
  };
  const char = shift ? d.shiftText ?? d.text : d.text;
  if (char) payload.text = char;
  await ctx.session.cdp.send('Input.dispatchKeyEvent', payload);
  await ctx.session.cdp.send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    modifiers: bits,
    key: d.key,
    code: d.code,
    windowsVirtualKeyCode: d.windowsVirtualKeyCode,
    nativeVirtualKeyCode: d.nativeVirtualKeyCode,
  });
}

type Ctx = Parameters<ToolDef['handler']>[1];

async function mouse(ctx: Ctx, type: string, x: number, y: number, extra: Record<string, unknown> = {}): Promise<void> {
  await ctx.session.cdp.send('Input.dispatchMouseEvent', { type, x, y, ...extra });
}

export const tools: ToolDef[] = [
  {
    name: 'click',
    title: 'Click',
    description:
      'Click an element. Pass a ref from browser_snapshot (e.g. "e4") or a CSS selector. Four CDP calls total — no polling.',
    params: {
      target: { type: 'string', description: 'Element ref from the page snapshot (e.g. e4), or a unique CSS selector', required: true },
      element: { type: 'string', description: 'Human-readable element description (for permission prompts)' },
      doubleClick: { type: 'boolean', description: 'Double-click instead of a single click' },
      button: { type: 'string', enum: ['left', 'right', 'middle'], description: 'Mouse button (default left)', default: 'left' },
      modifiers: { type: 'array', items: { type: 'string' }, description: 'Modifier keys to hold: Alt, Ctrl, Meta, Shift' },
      settle: { type: 'number', description: 'Milliseconds to wait for the page to settle afterwards' },
    },
    async handler(args, ctx): Promise<CallResult> {
      const b = await ctx.refs.box(args.target as string);
      const button = (args.button as string) ?? 'left';
      const bits = BUTTON_BIT[button] ?? 1;
      const mods = modifierBits(args.modifiers);
      await mouse(ctx, 'mouseMoved', b.cx, b.cy, { modifiers: mods });
      if (args.doubleClick === true) {
        for (const count of [1, 2]) {
          await mouse(ctx, 'mousePressed', b.cx, b.cy, { button, buttons: bits, clickCount: count, modifiers: mods });
          await mouse(ctx, 'mouseReleased', b.cx, b.cy, { button, buttons: 0, clickCount: count, modifiers: mods });
        }
      } else {
        await mouse(ctx, 'mousePressed', b.cx, b.cy, { button, buttons: bits, clickCount: 1, modifiers: mods });
        await mouse(ctx, 'mouseReleased', b.cx, b.cy, { button, buttons: 0, clickCount: 1, modifiers: mods });
      }
      const rep = await settle(ctx.session, (args.settle as number | undefined) ?? ctx.cfg.timeoutSettle);
      return text(`Clicked ${args.target} — settled in ${rep.ms}ms`, { ms: rep.ms, x: b.cx, y: b.cy });
    },
  },
  {
    name: 'hover',
    title: 'Hover',
    description: 'Move the mouse over an element. Use it to reveal hover menus before clicking.',
    params: {
      target: { type: 'string', description: 'Element ref (e.g. e4) or CSS selector', required: true },
      element: { type: 'string', description: 'Human-readable element description' },
    },
    async handler(args, ctx): Promise<CallResult> {
      const b = await ctx.refs.box(args.target as string);
      await mouse(ctx, 'mouseMoved', b.cx, b.cy);
      const rep = await settle(ctx.session, 0);
      return text(`Hovered ${args.target}`, { x: b.cx, y: b.cy, ms: rep.ms });
    },
  },
  {
    name: 'type',
    title: 'Type text',
    description:
      'Type text into an editable element. By default this is ONE CDP call (Input.insertText) — use slowly:true only when the page needs real per-key events.',
    params: {
      target: { type: 'string', description: 'Element ref (e.g. e4) or CSS selector', required: true },
      text: { type: 'string', description: 'Text to type', required: true },
      element: { type: 'string', description: 'Human-readable element description' },
      submit: { type: 'boolean', description: 'Press Enter after typing' },
      slowly: { type: 'boolean', description: 'Type one character at a time (needed for some autocomplete widgets)' },
      settle: { type: 'number', description: 'Milliseconds to wait for the page to settle afterwards' },
    },
    async handler(args, ctx): Promise<CallResult> {
      const value = args.text as string;
      await ensureInjected(ctx.session);
      const oid = await ctx.refs.objectId(args.target as string);
      await ctx.session.evalOn(oid, function (el: any) {
        return (window as any).__bw.focus(el);
      }, undefined, { awaitPromise: false });

      const slowly = args.slowly === true;
      if (slowly) {
        for (const ch of value) {
          if (ch === '\n') {
            await press(ctx, 'Enter');
          } else {
            await press(ctx, ch);
          }
        }
      } else {
        await ctx.session.cdp.send('Input.insertText', { text: value });
      }
      if (args.submit === true) await press(ctx, 'Enter');

      const rep = await settle(ctx.session, (args.settle as number | undefined) ?? ctx.cfg.timeoutSettle);
      return text(`Typed ${value.length} char${value.length === 1 ? '' : 's'} into ${args.target} — settled in ${rep.ms}ms`, {
        ms: rep.ms,
        fast: !slowly,
      });
    },
  },
  {
    name: 'press_key',
    title: 'Press a key',
    description: 'Press a key or a modifier combo, e.g. "Enter", "ArrowLeft", "Control+A", "Shift+Tab".',
    params: {
      key: { type: 'string', description: 'Key name or character, optionally with modifiers: "Control+A"', required: true },
      modifiers: { type: 'array', items: { type: 'string' }, description: 'Extra modifier keys to hold' },
    },
    async handler(args, ctx): Promise<CallResult> {
      await press(ctx, args.key as string, modifierBits(args.modifiers));
      const rep = await settle(ctx.session, ctx.cfg.timeoutSettle);
      return text(`Pressed ${args.key} — settled in ${rep.ms}ms`, { ms: rep.ms });
    },
  },
  {
    name: 'select_option',
    title: 'Select option',
    description: 'Select one or more options in a <select>. One CDP call — sets the value and fires input/change.',
    params: {
      target: { type: 'string', description: 'Element ref (e.g. e4) or CSS selector for the select', required: true },
      values: { type: 'array', items: { type: 'string' }, description: 'Option value(s) to select', required: true },
      element: { type: 'string', description: 'Human-readable element description' },
    },
    async handler(args, ctx): Promise<CallResult> {
      const oid = await ctx.refs.objectId(args.target as string);
      const r = await ctx.session.evalOn<{ ok: boolean; matched: number; available: string[] }>(
        oid,
        function (el: any, arg: any) {
          if (el.tagName !== 'SELECT') return { ok: false, matched: 0, available: [] };
          const wanted = arg.values.map((v: unknown) => String(v));
          const opts = Array.from(el.options) as any[];
          let matched = 0;
          if (el.multiple) {
            for (const o of opts) {
              const hit = wanted.includes(String(o.value)) || wanted.includes(String(o.textContent).trim());
              o.selected = hit;
              if (hit) matched++;
            }
          } else {
            let found = opts.find((o) => wanted.includes(String(o.value)));
            if (!found) found = opts.find((o) => wanted.includes(String(o.textContent).trim()));
            if (found) {
              el.value = found.value;
              matched = 1;
            }
          }
          if (matched) {
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
          }
          return { ok: matched > 0, matched, available: opts.slice(0, 20).map((o) => String(o.value)) };
        },
        { values: args.values as unknown[] },
        { awaitPromise: false },
      );
      if (!r || !r.ok) {
        throw new BlinkwireError(
          'No option matched the given values.',
          'no_option',
          `Available values: ${(r?.available ?? []).join(', ') || '(none)'}`,
        );
      }
      const rep = await settle(ctx.session, ctx.cfg.timeoutSettle);
      return text(`Selected ${r.matched} option${r.matched === 1 ? '' : 's'} in ${args.target} — settled in ${rep.ms}ms`, { ms: rep.ms });
    },
  },
  {
    name: 'drag',
    title: 'Drag mouse',
    description: 'Drag and drop from one element to another.',
    params: {
      startTarget: { type: 'string', description: 'Source element ref or CSS selector', required: true },
      endTarget: { type: 'string', description: 'Target element ref or CSS selector', required: true },
    },
    async handler(args, ctx): Promise<CallResult> {
      const a = await ctx.refs.box(args.startTarget as string);
      const b = await ctx.refs.box(args.endTarget as string);
      await mouse(ctx, 'mouseMoved', a.cx, a.cy);
      await mouse(ctx, 'mousePressed', a.cx, a.cy, { button: 'left', buttons: 1, clickCount: 1 });
      for (let i = 1; i <= 5; i++) {
        await mouse(ctx, 'mouseMoved', a.cx + ((b.cx - a.cx) * i) / 5, a.cy + ((b.cy - a.cy) * i) / 5, { buttons: 1 });
      }
      await mouse(ctx, 'mouseReleased', b.cx, b.cy, { button: 'left', buttons: 0, clickCount: 1 });
      const rep = await settle(ctx.session, ctx.cfg.timeoutSettle);
      return text(`Dragged ${args.startTarget} -> ${args.endTarget} — settled in ${rep.ms}ms`, { ms: rep.ms });
    },
  },
  {
    name: 'drop',
    title: 'Drop files or data',
    description: 'Drop files or MIME-typed data onto an element, as if dragged in from outside the page.',
    params: {
      target: { type: 'string', description: 'Element ref or CSS selector to drop onto', required: true },
      paths: { type: 'array', items: { type: 'string' }, description: 'Absolute paths of files to drop' },
      data: { type: 'object', description: 'Map of MIME type to string value, e.g. {"text/plain": "hello"}' },
    },
    async handler(args, ctx): Promise<CallResult> {
      const paths = (args.paths as string[] | undefined) ?? [];
      const dataMap = (args.data as Record<string, string> | undefined) ?? {};
      if (paths.length === 0 && Object.keys(dataMap).length === 0) {
        throw new BlinkwireError('Provide paths or data.', 'bad_arguments');
      }
      const items = [
        ...Object.entries(dataMap).map(([mimeType, d]) => ({ mimeType, data: String(d) })),
        ...paths.map((p) => ({ mimeType: 'text/uri-list', data: p })),
      ];
      const b = await ctx.refs.box(args.target as string);
      for (const type of ['dragEnter', 'dragOver', 'drop']) {
        await ctx.session.cdp.send('Input.dispatchDragEvent', {
          type,
          x: b.cx,
          y: b.cy,
          data: { items, dragOperationsMask: 1 },
        });
      }
      const rep = await settle(ctx.session, ctx.cfg.timeoutSettle);
      return text(`Dropped ${items.length} item${items.length === 1 ? '' : 's'} onto ${args.target} — settled in ${rep.ms}ms`, { ms: rep.ms });
    },
  },
  {
    name: 'file_upload',
    title: 'Upload files',
    description: 'Set files on a file input. Point target at the input, or omit it to use the first file input on the page.',
    params: {
      paths: { type: 'array', items: { type: 'string' }, description: 'Absolute paths of the files to upload', required: true },
      target: { type: 'string', description: 'File input ref or CSS selector (defaults to the first file input)' },
    },
    async handler(args, ctx): Promise<CallResult> {
      const files = args.paths as string[];
      if (!files?.length) throw new BlinkwireError('Provide at least one path.', 'bad_arguments');
      const oid = await ctx.refs.objectId((args.target as string | undefined) ?? 'input[type=file]');
      await ctx.session.ensure('DOM');
      await ctx.session.cdp.send('DOM.setFileInputFiles', { files, objectId: oid });
      const rep = await settle(ctx.session, ctx.cfg.timeoutSettle);
      return text(`Attached ${files.length} file${files.length === 1 ? '' : 's'} — settled in ${rep.ms}ms`, { ms: rep.ms });
    },
  },
  {
    name: 'handle_dialog',
    title: 'Handle a dialog',
    description:
      'Accept or dismiss a pending JavaScript dialog (alert, confirm, prompt or beforeunload). Call it right after the action that opened the dialog.',
    params: {
      accept: { type: 'boolean', description: 'Whether to accept the dialog', required: true },
      promptText: { type: 'string', description: 'Text to enter for a prompt dialog' },
    },
    async handler(args, ctx): Promise<CallResult> {
      await ctx.session.ensure('Page');
      const pending = ctx.session.buffers.dialogs[0];
      await ctx.session.cdp.send('Page.handleJavaScriptDialog', {
        accept: args.accept === true,
        ...(args.promptText !== undefined ? { promptText: args.promptText as string } : {}),
      });
      if (pending) ctx.session.buffers.dialogs.shift();
      const what = pending ? `${pending.type} dialog` : 'dialog';
      return text(`${what} ${args.accept === true ? 'accepted' : 'dismissed'}.`);
    },
  },
  {
    name: 'fill_form',
    title: 'Fill form',
    description:
      'Fill many form fields in ONE call. This is the fastest way to complete a form — one MCP round-trip and one settle for the whole form.',
    params: {
      fields: {
        type: 'array',
        description: 'Fields to fill, each {target, value} (or {target, values} for multi-selects)',
        required: true,
      },
      settle: { type: 'number', description: 'Milliseconds to wait for the page to settle after all fields' },
    },
    async handler(args, ctx): Promise<CallResult> {
      const fields = (args.fields as Array<Record<string, unknown>>) ?? [];
      if (fields.length === 0) throw new BlinkwireError('Provide at least one field.', 'bad_arguments');
      await ensureInjected(ctx.session);

      const lines: string[] = [];
      let ok = 0;
      for (let i = 0; i < fields.length; i++) {
        const f = fields[i]!;
        const target = String(f.target ?? '');
        const label = `${i + 1}. ${target}`;
        try {
          const oid = await ctx.refs.objectId(target);
          const kind = await ctx.session.evalOn<string>(oid, function (el: any) {
            return String(el.tagName).toLowerCase();
          }, undefined, { awaitPromise: false });

          if (kind === 'select') {
            const values = (f.values as string[]) ?? (f.value !== undefined ? [String(f.value)] : []);
            await ctx.session.evalOn(oid, function (el: any, arg: any) {
              const wanted = arg.values.map((v: unknown) => String(v));
              const opts = Array.from(el.options) as any[];
              if (el.multiple) {
                for (const o of opts) o.selected = wanted.includes(String(o.value));
              } else {
                const found = opts.find((o) => wanted.includes(String(o.value)));
                if (found) el.value = found.value;
              }
              el.dispatchEvent(new Event('input', { bubbles: true }));
              el.dispatchEvent(new Event('change', { bubbles: true }));
              return true;
            }, { values }, { awaitPromise: false });
          } else {
            const value = String(f.value ?? f.text ?? '');
            await ctx.session.evalOn(oid, function (el: any) {
              return (window as any).__bw.focus(el);
            }, undefined, { awaitPromise: false });
            await ctx.session.cdp.send('Input.insertText', { text: value });
          }
          ok++;
          lines.push(`${label} ok`);
        } catch (e) {
          lines.push(`${label} ERR: ${(e as Error).message.split('\n')[0]}`);
        }
      }
      const rep = await settle(ctx.session, (args.settle as number | undefined) ?? ctx.cfg.timeoutSettle);
      lines.push(`— ${ok}/${fields.length} filled, settled in ${rep.ms}ms`);
      return text(lines.join('\n'), { ok, total: fields.length, ms: rep.ms });
    },
  },
];
