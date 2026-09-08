import type { ParamSpec } from './schema.js';
import type { BrowserConnection } from '../cdp/connection.js';
import type { PageSession } from '../cdp/session.js';
import type { BlinkwireConfig } from '../config.js';
import type { RefStore } from './refs.js';
import type { Budget } from './budget.js';

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

export interface TextResult {
  kind: 'text';
  text: string;
  isError?: boolean;
  meta?: Record<string, Json>;
}
export interface ImageResult {
  kind: 'image';
  mime: string;
  data: string;
  text?: string;
  isError?: boolean;
  meta?: Record<string, Json>;
}
export interface BlobResult {
  kind: 'resource';
  uri: string;
  mime: string;
  text: string;
  isError?: boolean;
  meta?: Record<string, Json>;
}
export type CallResult = TextResult | ImageResult | BlobResult;

export function text(s: string, meta?: Record<string, Json>): TextResult {
  return meta ? { kind: 'text', text: s, meta } : { kind: 'text', text: s };
}
export function err(s: string, meta?: Record<string, Json>): TextResult {
  return { kind: 'text', text: s, isError: true, ...(meta ? { meta } : {}) };
}

export interface ToolContext {
  conn: BrowserConnection;
  session: PageSession;
  cfg: BlinkwireConfig;
  refs: RefStore;
  budget: Budget;
  /** base name -> prefixed name, e.g. 'snapshot' -> 'browser_snapshot' */
  toolName(base: string): string;
}

export interface ToolDef {
  /** base name, e.g. 'click'. The server prefixes it. */
  name: string;
  title: string;
  description: string;
  params?: ParamSpec;
  readOnly?: boolean;
  destructive?: boolean;
  handler(args: Record<string, unknown>, ctx: ToolContext): Promise<CallResult>;
}
