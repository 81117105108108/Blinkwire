import { BlinkwireError } from '../core/errors.js';

/** CDP Input modifier bitmask. */
export const MODIFIER_BIT = {
  alt: 1,
  ctrl: 2,
  control: 2,
  meta: 4,
  command: 4,
  cmd: 4,
  shift: 8,
} as const satisfies Readonly<Record<string, number>>;

export interface KeyDef {
  key: string;
  code: string;
  windowsVirtualKeyCode: number;
  nativeVirtualKeyCode: number;
  text?: string;
  shiftText?: string;
}

interface SpecialKey {
  readonly key: string;
  readonly code: string;
  readonly vk: number;
  readonly text?: string;
}

interface PunctuationKey {
  readonly code: string;
  readonly vk: number;
  readonly shift?: string;
}

const ENTER = {
  key: 'Enter',
  code: 'Enter',
  vk: 13,
  text: '\r',
} as const satisfies SpecialKey;

const ESCAPE = {
  key: 'Escape',
  code: 'Escape',
  vk: 27,
} as const satisfies SpecialKey;

const DELETE = {
  key: 'Delete',
  code: 'Delete',
  vk: 46,
} as const satisfies SpecialKey;

const SPACE = {
  key: ' ',
  code: 'Space',
  vk: 32,
  text: ' ',
} as const satisfies SpecialKey;

const ARROW_UP = { key: 'ArrowUp', code: 'ArrowUp', vk: 38 } as const satisfies SpecialKey;
const ARROW_DOWN = { key: 'ArrowDown', code: 'ArrowDown', vk: 40 } as const satisfies SpecialKey;
const ARROW_LEFT = { key: 'ArrowLeft', code: 'ArrowLeft', vk: 37 } as const satisfies SpecialKey;
const ARROW_RIGHT = { key: 'ArrowRight', code: 'ArrowRight', vk: 39 } as const satisfies SpecialKey;

const SPECIAL = {
  enter: ENTER,
  return: ENTER,

  tab: { key: 'Tab', code: 'Tab', vk: 9, text: '\t' },

  escape: ESCAPE,
  esc: ESCAPE,

  backspace: { key: 'Backspace', code: 'Backspace', vk: 8 },

  delete: DELETE,
  del: DELETE,

  arrowup: ARROW_UP,
  up: ARROW_UP,

  arrowdown: ARROW_DOWN,
  down: ARROW_DOWN,

  arrowleft: ARROW_LEFT,
  left: ARROW_LEFT,

  arrowright: ARROW_RIGHT,
  right: ARROW_RIGHT,

  home: { key: 'Home', code: 'Home', vk: 36 },
  end: { key: 'End', code: 'End', vk: 35 },
  pageup: { key: 'PageUp', code: 'PageUp', vk: 33 },
  pagedown: { key: 'PageDown', code: 'PageDown', vk: 34 },
  insert: { key: 'Insert', code: 'Insert', vk: 45 },

  space: SPACE,
  ' ': SPACE,

  f1: { key: 'F1', code: 'F1', vk: 112 },
  f2: { key: 'F2', code: 'F2', vk: 113 },
  f3: { key: 'F3', code: 'F3', vk: 114 },
  f4: { key: 'F4', code: 'F4', vk: 115 },
  f5: { key: 'F5', code: 'F5', vk: 116 },
  f6: { key: 'F6', code: 'F6', vk: 117 },
  f7: { key: 'F7', code: 'F7', vk: 118 },
  f8: { key: 'F8', code: 'F8', vk: 119 },
  f9: { key: 'F9', code: 'F9', vk: 120 },
  f10: { key: 'F10', code: 'F10', vk: 121 },
  f11: { key: 'F11', code: 'F11', vk: 122 },
  f12: { key: 'F12', code: 'F12', vk: 123 },
} as const satisfies Readonly<Record<string, SpecialKey>>;

/** Physical key metadata for US-layout punctuation keys. */
const PUNCTUATION = {
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
} as const satisfies Readonly<Record<string, PunctuationKey>>;

/** Physical digit key corresponding to each Shift+digit character. */
const SHIFTED_DIGITS = {
  '!': '1',
  '@': '2',
  '#': '3',
  '$': '4',
  '%': '5',
  '^': '6',
  '&': '7',
  '*': '8',
  '(': '9',
  ')': '0',
} as const satisfies Readonly<Record<string, string>>;

type SpecialName = keyof typeof SPECIAL;
type Punctuation = keyof typeof PUNCTUATION;
type ShiftedDigit = keyof typeof SHIFTED_DIGITS;

/** Reverse index of the shift layer, derived so it can never drift from PUNCTUATION. */
const SHIFTED_PUNCTUATION: Readonly<Record<string, PunctuationKey>> = Object.freeze(
  Object.fromEntries(Object.entries(PUNCTUATION).flatMap(([, definition]) => (definition.shift ? [[definition.shift, definition]] : []))),
);

const NAMED_KEYS = Object.keys(SPECIAL).join(', ');

function isAsciiLetter(charCode: number): boolean {
  return (charCode >= 65 && charCode <= 90) || (charCode >= 97 && charCode <= 122);
}

function isAsciiDigit(charCode: number): boolean {
  return charCode >= 48 && charCode <= 57;
}

function toKeyDef(key: string, code: string, virtualKeyCode: number, text?: string, shiftText?: string): KeyDef {
  const definition: KeyDef = {
    key,
    code,
    windowsVirtualKeyCode: virtualKeyCode,
    nativeVirtualKeyCode: virtualKeyCode,
  };
  if (text !== undefined) definition.text = text;
  if (shiftText !== undefined) definition.shiftText = shiftText;
  return definition;
}

function letterKeyDefinition(character: string, charCode: number): KeyDef {
  const uppercaseCode = charCode >= 97 && charCode <= 122 ? charCode - 32 : charCode;
  const uppercase = String.fromCharCode(uppercaseCode);
  return toKeyDef(character, `Key${uppercase}`, uppercaseCode, uppercase.toLowerCase(), uppercase);
}

function digitKeyDefinition(character: string, charCode: number): KeyDef {
  return toKeyDef(character, `Digit${character}`, charCode, character);
}

function shiftedDigitDefinition(character: ShiftedDigit): KeyDef {
  const digit = SHIFTED_DIGITS[character];
  return toKeyDef(character, `Digit${digit}`, digit.charCodeAt(0), character);
}

function punctuationKeyDefinition(character: Punctuation): KeyDef {
  const punctuation = PUNCTUATION[character];
  return toKeyDef(character, punctuation.code, punctuation.vk, character, punctuation.shift);
}

function shiftedPunctuationKeyDefinition(character: string): KeyDef | undefined {
  const punctuation = SHIFTED_PUNCTUATION[character];
  if (!punctuation) return undefined;
  return toKeyDef(character, punctuation.code, punctuation.vk, character);
}

function unsupportedKeyError(key: string): BlinkwireError {
  return new BlinkwireError(
    `Unsupported key ${JSON.stringify(key)}.`,
    'bad_key',
    `Named keys: ${NAMED_KEYS}. Single characters and modifier combos like "Control+A" also work.`,
  );
}

export function keyDefinition(key: string): KeyDef {
  const raw = key ?? '';
  const special: SpecialKey | undefined = SPECIAL[raw.toLowerCase() as SpecialName];

  if (special !== undefined) return toKeyDef(special.key, special.code, special.vk, special.text);

  if (raw.length !== 1) throw unsupportedKeyError(key);

  const charCode = raw.charCodeAt(0);

  if (isAsciiLetter(charCode)) return letterKeyDefinition(raw, charCode);
  if (isAsciiDigit(charCode)) return digitKeyDefinition(raw, charCode);
  if (SHIFTED_DIGITS[raw as ShiftedDigit] !== undefined) return shiftedDigitDefinition(raw as ShiftedDigit);
  if (PUNCTUATION[raw as Punctuation] !== undefined) return punctuationKeyDefinition(raw as Punctuation);

  const shiftedPunctuation = shiftedPunctuationKeyDefinition(raw);
  if (shiftedPunctuation !== undefined) return shiftedPunctuation;

  throw unsupportedKeyError(key);
}

/** Bit for one modifier name, or undefined if it is not a modifier. */
export function modifierBit(name: string): number | undefined {
  return MODIFIER_BIT[String(name ?? '').trim().toLowerCase() as keyof typeof MODIFIER_BIT];
}

export function modifierBits(modifiers: unknown): number {
  if (!Array.isArray(modifiers)) return 0;
  let bits = 0;
  for (const modifier of modifiers) {
    const bit = modifierBit(String(modifier));
    if (bit !== undefined) bits |= bit;
  }
  return bits;
}
