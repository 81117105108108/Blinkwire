import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { portHints } from '../src/cdp/discovery.js';
import { toJsonSchema } from '../src/core/schema.js';
import { SNAPSHOT_FN_SRC } from '../src/core/inpage-snapshot.js';

test('portHints parses port and DevToolsActivePort wsPath', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bw-hint-'));
  try {
    fs.writeFileSync(
      path.join(dir, 'DevToolsActivePort'),
      '54321\n/devtools/browser/11111111-2222-3333-4444-555555555555\n',
    );
    const hints = portHints(dir);
    const match = hints.find((h) => h.port === 54321);
    assert.ok(match);
    assert.equal(match.wsPath, '/devtools/browser/11111111-2222-3333-4444-555555555555');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('toJsonSchema omits empty required array', () => {
  const schema = toJsonSchema({
    q: { type: 'string', description: 'optional query' },
  });
  assert.equal('required' in schema, false);

  const schemaReq = toJsonSchema({
    q: { type: 'string', description: 'required query', required: true },
  });
  assert.deepEqual(schemaReq.required, ['q']);
});

test('SNAPSHOT_FN_SRC compiles cleanly', () => {
  const fn = (0, eval)(`(${SNAPSHOT_FN_SRC})`);
  assert.equal(typeof fn, 'function');
});
