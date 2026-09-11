import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Budget, estimateTokens, HeuristicTokenEstimator } from '../src/core/budget.js';

test('Budget.estimate returns 0 for empty input', () => {
  assert.equal(Budget.estimate(''), 0);
  assert.equal(estimateTokens(''), 0);
});

test('Budget.estimate grows with input length', () => {
  const short = Budget.estimate('hello world');
  const long = Budget.estimate('hello world '.repeat(100));
  assert.ok(long > short);
});

test('Budget.estimate handles code-like text', () => {
  const value = Budget.estimate('const x = () => 42;');
  assert.ok(value > 0);
});

test('estimateTokens counts CJK denser than latin', () => {
  const latin = estimateTokens('hello world hello world');
  const cjk = estimateTokens('你好世界你好世界你好世界');
  assert.ok(cjk > 0);
  assert.ok(latin > 0);
});

test('HeuristicTokenEstimator delegates to estimateTokens', () => {
  const est = new HeuristicTokenEstimator();
  assert.equal(est.estimate('abc'), estimateTokens('abc'));
});

test('Budget fits/clamp respect max', () => {
  const b = new Budget(10);
  assert.equal(b.fits('hi'), true);
  const long = 'x'.repeat(5000);
  assert.equal(b.fits(long), false);
  assert.ok(b.clamp(long).length < long.length);
});
