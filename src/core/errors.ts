import type { CallResult } from './types.js';

export class BlinkwireError extends Error {
  readonly code: string;
  readonly hint?: string;

  constructor(message: string, code = 'blinkwire_error', hint?: string) {
    super(message);
    this.name = 'BlinkwireError';
    this.code = code;
    this.hint = hint;
  }

  toCallResult(): CallResult {
    const hint = this.hint ? `\n\n${this.hint}` : '';
    return { kind: 'text', text: `Error: ${this.message}${hint}`, isError: true };
  }
}

export class TimeoutError extends BlinkwireError {
  constructor(message: string, hint?: string) {
    super(message, 'timeout', hint);
    this.name = 'TimeoutError';
  }
}

export class EvalError extends BlinkwireError {
  constructor(message: string, hint?: string) {
    super(message, 'eval_error', hint ?? 'The page script threw. Check the page state with browser_snapshot.');
    this.name = 'EvalError';
  }
}

export class TargetGoneError extends BlinkwireError {
  constructor(message = 'The browser tab or connection is gone.', hint?: string) {
    super(message, 'target_gone', hint ?? 'Re-attach with browser_connect, or re-open the tab.');
    this.name = 'TargetGoneError';
  }
}

export function isBlinkwireError(e: unknown): e is BlinkwireError {
  return e instanceof BlinkwireError;
}

export function fail(message: string, code?: string, hint?: string): never {
  throw new BlinkwireError(message, code, hint);
}

/** Normalise anything thrown into a BlinkwireError without losing the message. */
export function asBlinkwireError(e: unknown): BlinkwireError {
  if (e instanceof BlinkwireError) return e;
  if (e instanceof Error) {
    if (e.name === 'TimeoutError' || (e as { code?: string }).code === 'timeout' || e.name === 'AbortError') {
      return new TimeoutError(e.message);
    }
    return new BlinkwireError(e.message);
  }
  return new BlinkwireError(String(e));
}
