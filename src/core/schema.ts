import { BlinkwireError } from './errors.js';

export type FieldType = 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'object';

export interface Field {
  type: FieldType | FieldType[];
  description: string;
  required?: boolean;
  enum?: string[];
  items?: { type: FieldType };
  min?: number;
  max?: number;
  default?: unknown;
}

export type ParamSpec = Record<string, Field>;

const JSON_TYPE: Record<FieldType, string> = {
  string: 'string',
  number: 'number',
  integer: 'integer',
  boolean: 'boolean',
  array: 'array',
  object: 'object',
};

export function toJsonSchema(spec: ParamSpec): {
  type: 'object';
  properties: Record<string, unknown>;
  required: string[];
  additionalProperties: false;
} {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const [name, f] of Object.entries(spec)) {
    const types = Array.isArray(f.type) ? f.type : [f.type];
    const prop: Record<string, unknown> = { description: f.description };
    if (types.length === 1) {
      prop.type = JSON_TYPE[types[0]!];
    } else {
      prop.type = types.map((t) => JSON_TYPE[t]);
    }
    if (f.enum) prop.enum = f.enum;
    if (f.items) prop.items = { type: JSON_TYPE[f.items.type] };
    if (typeof f.min === 'number') prop.minimum = f.min;
    if (typeof f.max === 'number') prop.maximum = f.max;
    if (f.default !== undefined) prop.default = f.default;
    if (types.includes('array') && !f.items) prop.items = {};
    properties[name] = prop;
    if (f.required) required.push(name);
  }
  return { type: 'object', properties, required, additionalProperties: false };
}

function checkType(name: string, v: unknown, t: FieldType, f: Field): unknown {
  switch (t) {
    case 'string':
      if (typeof v === 'string') return v;
      if (typeof v === 'number' || typeof v === 'boolean') return String(v);
      return bad(name, v, 'string');
    case 'number': {
      const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
      if (!Number.isFinite(n)) return bad(name, v, 'number');
      if (typeof f.min === 'number' && n < f.min) return bad(name, v, `number >= ${f.min}`);
      if (typeof f.max === 'number' && n > f.max) return bad(name, v, `number <= ${f.max}`);
      return n;
    }
    case 'integer': {
      const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
      if (!Number.isFinite(n) || !Number.isInteger(n)) return bad(name, v, 'integer');
      if (typeof f.min === 'number' && n < f.min) return bad(name, v, `integer >= ${f.min}`);
      if (typeof f.max === 'number' && n > f.max) return bad(name, v, `integer <= ${f.max}`);
      return n;
    }
    case 'boolean':
      if (typeof v === 'boolean') return v;
      if (v === 'true' || v === 1) return true;
      if (v === 'false' || v === 0) return false;
      return bad(name, v, 'boolean');
    case 'array':
      if (Array.isArray(v)) return v;
      if (typeof v === 'string') return [v];
      return bad(name, v, 'array');
    case 'object':
      if (v && typeof v === 'object' && !Array.isArray(v)) return v;
      return bad(name, v, 'object');
  }
}

function bad(name: string, v: unknown, want: string): never {
  throw new BlinkwireError(
    `Invalid argument "${name}": expected ${want}, got ${v === undefined ? 'undefined' : JSON.stringify(v) ?? typeof v}`,
    'bad_arguments',
  );
}

export function validate(spec: ParamSpec | undefined, args: unknown): Record<string, unknown> {
  const input: Record<string, unknown> =
    args && typeof args === 'object' && !Array.isArray(args) ? { ...(args as Record<string, unknown>) } : {};
  if (!spec) return input;

  const out: Record<string, unknown> = {};
  for (const [name, f] of Object.entries(spec)) {
    const raw = input[name];
    if (raw === undefined || raw === null) {
      if (f.required) throw new BlinkwireError(`Missing required argument "${name}".`, 'bad_arguments');
      if (f.default !== undefined) out[name] = f.default;
      continue;
    }
    const types = Array.isArray(f.type) ? f.type : [f.type];
    let value: unknown;
    let ok = false;
    let lastErr: unknown;
    for (const t of types) {
      try {
        value = checkType(name, raw, t, f);
        ok = true;
        break;
      } catch (e) {
        lastErr = e;
      }
    }
    if (!ok) throw lastErr instanceof Error ? lastErr : new BlinkwireError(`Invalid argument "${name}".`, 'bad_arguments');
    if (f.enum && typeof value === 'string' && !f.enum.includes(value)) {
      throw new BlinkwireError(
        `Invalid argument "${name}": ${JSON.stringify(value)} is not one of ${f.enum.join(' | ')}.`,
        'bad_arguments',
      );
    }
    out[name] = value;
  }
  return out;
}
