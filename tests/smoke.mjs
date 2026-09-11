import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const PORT = 9333;
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'bw-test-'));
const root = path.resolve(import.meta.dirname, '..');

const PAGE = `<!doctype html><html><head><title>Blinkwire Fixture</title></head><body>
<nav><a href="#one">One</a><a href="#two">Two</a></nav>
<main>
  <h1>Hello Blinkwire</h1>
  <p id="msg">idle</p>
  <input id="q" placeholder="Search" />
  <button id="go" onclick="document.getElementById('msg').textContent='clicked ' + document.getElementById('q').value">Go</button>
  <select id="sel"><option value="a">A</option><option value="b">B</option></select>
  <div id="scroller" style="height:80px;overflow:auto;border:1px solid #000"><div style="height:600px">scroll target content</div></div>
</main></body></html>`;

const child = spawn(
  process.execPath,
  ['dist/index.js', `--port=${PORT}`, '--launch', '--headless', `--user-data-dir=${PROFILE}`],
  {
    cwd: root,
    stdio: ['pipe', 'pipe', 'pipe'],
  },
);

let stderr = '';
child.stderr.on('data', (d) => (stderr += d.toString()));

let nextId = 1;
const waiting = new Map();
let buffer = '';
child.stdout.on('data', (chunk) => {
  buffer += chunk.toString();
  let i;
  while ((i = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, i).trim();
    buffer = buffer.slice(i + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    if (msg.id !== undefined && waiting.has(msg.id)) {
      const { resolve, reject } = waiting.get(msg.id);
      waiting.delete(msg.id);
      if (msg.error) reject(new Error(JSON.stringify(msg.error)));
      else resolve(msg.result);
    }
  }
});

function send(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    waiting.set(id, { resolve, reject });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    setTimeout(() => {
      if (waiting.has(id)) {
        waiting.delete(id);
        reject(new Error(`timeout: ${method}`));
      }
    }, 60000);
  });
}
function notify(method, params) {
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
}

const results = [];
function check(name, cond, detail = '') {
  results.push({ name, ok: !!cond, detail });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

async function stop(proc) {
  if (!proc || proc.exitCode !== null || proc.signalCode !== null) return;
  proc.kill();
  await Promise.race([
    new Promise((resolve) => proc.once('exit', () => resolve(true))),
    new Promise((resolve) => setTimeout(() => resolve(false), 5000)),
  ]);
}

function cleanDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    // Best effort: Chrome may briefly retain locks while exiting.
  }
}

const toolText = (r) =>
  (r?.content ?? []).map((c) => c.text ?? (c.type === 'image' ? '<image>' : '')).join('\n');

async function call(name, args) {
  const r = await send('tools/call', { name: `browser_${name}`, arguments: args });
  return { text: toolText(r), isError: !!r?.isError, raw: r };
}

try {
  await send('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'smoke', version: '1.0.0' },
  });
  notify('notifications/initialized');

  const list = await send('tools/list', {});
  const names = list.tools.map((t) => t.name);
  check('tools/list returns tools', names.length > 30, `${names.length} tools`);
  for (const required of [
    'browser_snapshot',
    'browser_click',
    'browser_type',
    'browser_navigate',
    'browser_navigate_back',
    'browser_hover',
    'browser_press_key',
    'browser_select_option',
    'browser_drag',
    'browser_drop',
    'browser_file_upload',
    'browser_fill_form',
    'browser_find',
    'browser_take_screenshot',
    'browser_pdf_save',
    'browser_console_messages',
    'browser_network_requests',
    'browser_evaluate',
    'browser_handle_dialog',
    'browser_resize',
    'browser_tabs',
    'browser_close',
    'browser_wait_for',
    'browser_mouse_click_xy',
    'browser_scroll',
  ]) {
    check(`has ${required}`, names.includes(required));
  }
  check(
    'snapshot schema is compact',
    JSON.stringify(list.tools.find((t) => t.name === 'browser_snapshot')).length < 1200,
  );

  const nav = await call('navigate', { url: `data:text/html,${encodeURIComponent(PAGE)}` });
  check('navigate', /Blinkwire Fixture/.test(nav.text), nav.text.split('\n')[0]);

  const snap = await call('snapshot', {});
  check(
    'snapshot renders tree',
    /- heading "Hello Blinkwire"/.test(snap.text),
    snap.text.split('\n').slice(1, 4).join(' | '),
  );
  const refs = [...snap.text.matchAll(/\[ref=(e\d+)\]/g)].map((m) => m[1]);
  check('snapshot assigns refs', refs.length >= 4, refs.join(','));

  const find = await call('find', { text: 'Go' });
  check('find locates element', /ref=e\d+/.test(find.text), find.text.split('\n')[0]);

  const buttonRef = snap.text
    .split('\n')
    .find((l) => /button "Go"/.test(l))
    ?.match(/\[ref=(e\d+)\]/)?.[1];
  const inputRef = snap.text
    .split('\n')
    .find((l) => /textbox/.test(l))
    ?.match(/\[ref=(e\d+)\]/)?.[1];

  const typed = await call('type', { target: inputRef, text: 'blinkwire' });
  check('type (fast path)', /Typed 9 chars/.test(typed.text), typed.text.split('\n')[0]);

  const clicked = await call('click', { target: buttonRef });
  check('click', /Clicked/.test(clicked.text), clicked.text.split('\n')[0]);

  const after = await call('evaluate', {
    function: '() => document.getElementById("msg").textContent',
  });
  check(
    'click handler fired with typed value',
    after.text.includes('clicked blinkwire'),
    after.text.trim(),
  );

  await call('evaluate', {
    function:
      "() => { const q = document.getElementById('q'); q.value = ''; q.focus(); return true; }",
  });
  await call('press_key', { key: '_' });
  await call('press_key', { key: '{' });
  await call('press_key', { key: 'A' });
  const shifted = await call('evaluate', { function: "() => document.getElementById('q').value" });
  check(
    'press_key handles shifted punctuation + letters',
    shifted.text.includes('_{'),
    shifted.text.trim(),
  );

  const selRef = snap.text
    .split('\n')
    .find((l) => /combobox/.test(l))
    ?.match(/\[ref=(e\d+)\]/)?.[1];
  const sel = await call('select_option', { target: selRef, values: ['b'] });
  check('select_option', /Selected 1 option/.test(sel.text), sel.text.split('\n')[0]);
  const selVal = await call('evaluate', { function: '() => document.getElementById("sel").value' });
  check('select_option applied', selVal.text.trim() === 'b', selVal.text.trim());

  const batch = await call('batch', {
    steps: [
      { tool: 'click', args: { target: buttonRef } },
      { tool: 'press_key', args: { key: 'End' } },
      { tool: 'evaluate', args: { function: '() => 1 + 1' } },
    ],
    include: [3],
  });
  check(
    'batch runs 3 steps in one call',
    /3\/3 ok/.test(batch.text),
    batch.text.split('\n').filter((l) => l.startsWith('—'))[0],
  );
  check('batch inlines requested output', /2/.test(batch.text));

  const batchRecurse = await call('batch', {
    steps: [
      { tool: 'batch', args: { steps: [{ tool: 'evaluate', args: { function: '() => 1' } }] } },
    ],
  });
  check(
    'batch rejects recursive self-call',
    /ERR: Recursive batch execution is forbidden/.test(batchRecurse.text),
    batchRecurse.text.split('\n')[0],
  );

  const routePattern = '**/blinkwire-route-isolation-test/**';
  const routeBaseline = await call('route_list', {});
  check(
    'route list starts empty',
    /no active routes/.test(routeBaseline.text),
    routeBaseline.text.trim(),
  );
  await call('route', { pattern: routePattern, status: 200, body: '{}' });
  const routeListed = await call('route_list', {});
  check(
    'route applies to current session',
    routeListed.text.includes(routePattern),
    routeListed.text.trim(),
  );
  await call('tabs', { action: 'new', url: 'about:blank' });
  const routeIsolated = await call('route_list', {});
  check(
    'routes stay scoped to their session',
    /no active routes/.test(routeIsolated.text),
    routeIsolated.text.trim(),
  );
  await call('tabs', { action: 'select', index: 0 });
  const routeRestored = await call('route_list', {});
  check(
    'returning to session restores its routes',
    routeRestored.text.includes(routePattern),
    routeRestored.text.trim(),
  );
  await call('unroute', {});
  await call('tabs', { action: 'close', index: 1 });

  const filled = await call('fill_form', {
    fields: [
      { target: '#q', value: 'abc' },
      { target: '#q', value: 'xyz' },
    ],
  });
  check('fill_form', /2\/2 filled/.test(filled.text), filled.text.split('\n').pop());

  const diff = await call('snapshot_diff', {});
  check('snapshot_diff', diff.text.length > 0, diff.text.split('\n')[0]);

  const scroll = await call('scroll', { amount: 50 });
  check('scroll single round-trip', /Scrolled/.test(scroll.text), scroll.text.split('\n')[0]);

  const scrollTarget = await call('scroll', { target: '#scroller', direction: 'down', amount: 50 });
  check(
    'scroll honors target element',
    /Scrolled to 0,50/.test(scrollTarget.text),
    scrollTarget.text.split('\n')[0],
  );

  const scrollAbsolute = await call('scroll', { target: '#scroller', y: 140 });
  check(
    'absolute scroll honors target element',
    /Scrolled to 0,140/.test(scrollAbsolute.text),
    scrollAbsolute.text.split('\n')[0],
  );

  const shot = await send('tools/call', {
    name: 'browser_take_screenshot',
    arguments: { type: 'jpeg', quality: 40 },
  });
  const img = (shot.content ?? []).find((c) => c.type === 'image');
  check(
    'screenshot returns image',
    !!img && img.data.length > 100,
    img ? `${img.data.length} b64 chars` : 'none',
  );

  const status = await call('status', {});
  check('status reports browser', /Chrome|Edg/.test(status.text), status.text.split('\n')[0]);

  const unknown = await call('nope', {});
  check('unknown tool errors cleanly', unknown.isError, unknown.text.slice(0, 60));

  const badRef = await call('click', { target: 'e999' });
  check(
    'stale ref gives a helpful error',
    badRef.isError && /snapshot/.test(badRef.text),
    badRef.text.split('\n')[0],
  );
} catch (e) {
  check('smoke run completed without throwing', false, String(e.message));
} finally {
  await stop(child);
  cleanDir(PROFILE);
  if (stderr.trim()) console.log('\n--- server stderr ---\n' + stderr.slice(0, 2000));
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
}
