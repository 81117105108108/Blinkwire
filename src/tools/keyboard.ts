import { BlinkwireError } from '../core/errors.js';

/** CDP Input modifier bitmask. */
export const MODIFIER_BIT: Record<string, number> = {
  alt: 1,
  ctrl: 2,
  control: 2,
  meta: 4,
  command: 4,
  cmd: 4,
  shift: 8,
};

export interface KeyDef {
  key: string;
  code: string;
  windowsVirtualKeyCode: number;
  nativeVirtualKeyCode: number;
  text?: string;
  shiftText?: string;
}

interface Special {
  key: string;
  code: string;
  vk: number;
  text?: string;
}

const SPECIAL: Record<string, Special> = {
  enter: { key: 'Enter', code: 'Enter', vk: 13, text: '\r' },
  return: { key: 'Enter', code: 'Enter', vk: 13, text: '\r' },
  tab: { key: 'Tab', code: 'Tab', vk: 9, text: '\t' },
  escape: { key: 'Escape', code: 'Escape', vk: 27 },
  esc: { key: 'Escape', code: 'Escape', vk: 27 },
  backspace: { key: 'Backspace', code: 'Backspace', vk: 8 },
  delete: { key: 'Delete', code: 'Delete', vk: 46 },
  del: { key: 'Delete', code: 'Delete', vk: 46 },
  arrowup: { key: 'ArrowUp', code: 'ArrowUp', vk: 38 },
  arrowdown: { key: 'ArrowDown', code: 'ArrowDown', vk: 40 },
  arrowleft: { key: 'ArrowLeft', code: 'ArrowLeft', vk: 37 },
  arrowright: { key: 'ArrowRight', code: 'ArrowRight', vk: 39 },
  up: { key: 'ArrowUp', code: 'ArrowUp', vk: 38 },
  down: { key: 'ArrowDown', code: 'ArrowDown', vk: 40 },
  left: { key: 'ArrowLeft', code: 'ArrowLeft', vk: 37 },
  right: { key: 'ArrowRight', code: 'ArrowRight', vk: 39 },
  home: { key: 'Home', code: 'Home', vk: 36 },
  end: { key: 'End', code: 'End', vk: 35 },
  pageup: { key: 'PageUp', code: 'PageUp', vk: 33 },
  pagedown: { key: 'PageDown', code: 'PageDown', vk: 34 },
  space: { key: ' ', code: 'Space', vk: 32, text: ' ' },
  insert: { key: 'Insert', code: 'Insert', vk: 45 },
  f1: { key: 'F1', code: 'F1', vk: 112 },
  f5: { key: 'F5', code: 'F5', vk: 116 },
  f12: { key: 'F12', code: 'F12', vk: 123 },
};

/** code, vk, and the shift-layer character where one exists. */
const PUNCT: Record<string, { code: string; vk: number; shift?: string }> = {
  '-': { code: 'Minus', vk: 189, shift: '_' },
  '=': { code: 'Equal', vk: 187, shift: '+' },
  '[': { code: 'BracketLeft', vk: 219, shift: '{' },
  ']': { code: 'BracketRight', vk: 221, shift: '}' },
  '\\': { code: 'Backslash', vk: 220, shift: '|' },
  ';': { code: 'Semicolon', vk: 186, shift: ':' },
  "'": { code: 'Quote', vk: 222, shift: '"' },
  ',': { code: 'Comma', vk: 188, shift: '<' },
  '.': { code: 'Period', vk: 190, shift: '>' },
  '/': { code: 'Slash', vk: 191, shift: '?' },
  '`': { code: 'Backquote', vk: 192, shift: '~' },
};

/** Characters produced by Shift+digit. */
const SHIFTED_DIGITS: Record<string, string> = {
  '!': '1', '@': '2', '#': '3', '$': '4', '%': '5', '^': '6', '&': '7', '*': '8', '(': '9', ')': '0',
};

const NAMED = Object.keys(SPECIAL).join(', ');

export function keyDefinition(key: string): KeyDef {
  const raw = key ?? '';
  const lower = raw.toLowerCase();

  const s = SPECIAL[lower];
  if (s) {
    return {
      key: s.key,
      code: s.code,
      windowsVirtualKeyCode: s.vk,
      nativeVirtualKeyCode: s.vk,
      ...(s.text ? { text: s.text } : {}),
    };
  }

  if (raw.length === 1) {
    if (/[a-z]/i.test(raw)) {
      const up = raw.toUpperCase();
      return {
        key: raw,
        code: `Key${up}`,
        windowsVirtualKeyCode: up.charCodeAt(0),
        nativeVirtualKeyCode: up.charCodeAt(0),
        text: raw.toLowerCase(),
        shiftText: up,
      };
    }
    if (/[0-9]/.test(raw)) {
      return {
        key: raw,
        code: `Digit${raw}`,
        windowsVirtualKeyCode: raw.charCodeAt(0),
        nativeVirtualKeyCode: raw.charCodeAt(0),
        text: raw,
      };
    }
    const shifted = SHIFTED_DIGITS[raw];
    if (shifted) {
      return {
        key: raw,
        code: `Digit${shifted}`,
        windowsVirtualKeyCode: shifted.charCodeAt(0),
        nativeVirtualKeyCode: shifted.charCodeAt(0),
        text: raw,
      };
    }
    const p = PUNCT[raw];
    if (p) {
      return {
        key: raw,
        code: p.code,
        windowsVirtualKeyCode: p.vk,
        nativeVirtualKeyCode: p.vk,
        text: raw,
        ...(p.shift ? { shiftText: p.shift } : {}),
      };
    }
  }

  throw new BlinkwireError(
    `Unsupported key ${JSON.stringify(key)}.`,
    'bad_key',
    `Named keys: ${NAMED}. Single characters and modifier combos like "Control+A" also work.`,
  );
}

export function modifierBits(modifiers: unknown): number {
  if (!Array.isArray(modifiers)) return 0;
  let bits = 0;
  for (const m of modifiers) {
    const b = MODIFIER_BIT[String(m).toLowerCase()];
    if (b) bits |= b;
  }
  return bits;
}
