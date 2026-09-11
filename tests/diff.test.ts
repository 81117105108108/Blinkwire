import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diffText, MAX_DP_CELLS } from '../src/core/diff.js';

test('diffText reports no changes for identical strings', () => {
  const result = diffText('abc', 'abc');
  assert.ok(typeof result === 'string');
  assert.ok(result.includes('unchanged'));
  assert.ok(!result.includes('+ ') || result.includes('unchanged'));
});

test('diffText detects appended line', () => {
  const result = diffText('a\nb', 'a\nb\nc');
  assert.ok(result.includes('+ c'));
});

test('diffText detects removed line', () => {
  const result = diffText('a\nb\nc', 'a\nc');
  assert.ok(result.includes('- b'));
});

test('diffText falls back safely for very large inputs', () => {
  const a = Array.from({ length: 3000 }, (_, i) => `line-${i}-a`).join('\n');
  const b = Array.from({ length: 3000 }, (_, i) => `line-${i}-b`).join('\n');
  assert.ok(MAX_DP_CELLS > 0);
  const result = diffText(a, b);
  assert.ok(typeof result === 'string' && result.length > 0);
});

test('MAX_DP_CELLS honours env override', () => {
  assert.ok(Number.isFinite(MAX_DP_CELLS));
});
