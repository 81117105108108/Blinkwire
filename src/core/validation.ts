export const MAX_TEXT_LENGTH = 50_000;

export function assertText(value: unknown, name: string): string {
  if (typeof value !== 'string') {
    throw new TypeError(`${name} must be a string`);
  }

  if (value.length > MAX_TEXT_LENGTH) {
    throw new RangeError(`${name} exceeds ${MAX_TEXT_LENGTH} characters`);
  }

  return value;
}

export function assertUrl(value: unknown): string {
  if (typeof value !== 'string') {
    throw new TypeError('url must be a string');
  }

  const url = new URL(value);

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Only http and https URLs are allowed');
  }

  return url.toString();
}

export function assertSelector(value: unknown): string {
  const selector = assertText(value, 'selector');

  if (selector.includes('\0')) {
    throw new Error('selector contains a NUL byte');
  }

  return selector;
}
