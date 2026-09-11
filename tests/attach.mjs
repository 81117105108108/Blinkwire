/**
 * Blinkwire's headline feature: attach to a Chrome the user is already running.
 * No browser download, no launch, no profile juggling.
 */
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { existsSync } from 'node:fs';
import { platform } from 'node:os';

function findChromeExecutable() {
  if (process.env.CHROME_PATH) {
    return process.env.CHROME_PATH;
  }

  const candidates =
    platform() === 'win32'
      ? [
          'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
          'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
          path.join(process.env.LOCALAPPDATA ?? '', 'Google\\Chrome\\Application\\chrome.exe'),
        ]
      : platform() === 'darwin'
        ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
        : [
            '/usr/bin/google-chrome',
            '/usr/bin/google-chrome-stable',
            '/usr/bin/chromium',
            '/usr/bin/chromium-browser',
          ];

  const found = candidates.find((candidate) => candidate && existsSync(candidate));

  if (!found) {
    throw new Error('Chrome not found. Set CHROME_PATH to the Chrome executable.');
  }

  return found;
}

const chromePath = findChromeExecutable();

const PORT = 9445;
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'bw-attach-'));
const CHROME = chromePath;
const root = path.resolve(import.meta.dirname, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Stand in for "a Chrome the user already has open".
const chrome = spawn(
  CHROME,
  [
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${PROFILE}`,
    '--headless=new',
    '--no-first-run',
    '--no-default-browser-check',
    'data:text/html,<h1>Attached</h1><button id=b>Hi</button>',
  ],
  { stdio: 'ignore' },
);

let up = false;
for (let i = 0; i < 60 && !up; i++) {
  try {
    up = (await fetch(`http://127.0.0.1:${PORT}/json/version`)).ok;
  } catch {
    await sleep(200);
  }
}
if (!up) {
  console.log('FAIL  chrome never exposed a debugging port');
  chrome.kill();
  process.exit(1);
}

const child = spawn(process.execPath, ['dist/index.js', `--port=${PORT}`], {
  cwd: root,
  stdio: ['pipe', 'pipe', 'pipe'],
});
let stderr = '';
child.stderr.on('data', (d) => (stderr += d.toString()));

let nextId = 1;
const waiting = new Map();
let buffer = '';
child.stdout.on('data', (c) => {
  buffer += c.toString();
  let i;
  while ((i = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, i).trim();
    buffer = buffer.slice(i + 1);
    if (!line) continue;
    let m;
    try {
      m = JSON.parse(line);
    } catch {
      continue;
    }
    if (m.id !== undefined && waiting.has(m.id)) {
      const { resolve, reject } = waiting.get(m.id);
      waiting.delete(m.id);
      if (m.error) reject(new Error(JSON.stringify(m.error)));
      else resolve(m.result);
    }
  }
});
const send = (method, params) =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    waiting.set(id, { resolve, reject });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    setTimeout(
      () => waiting.has(id) && (waiting.delete(id), reject(new Error(`timeout: ${method}`))),
      40000,
    );
  });
const callText = async (name, args) =>
  ((await send('tools/call', { name, arguments: args })).content ?? [])
    .map((c) => c.text ?? '')
    .join('\n');

const results = [];
const check = (n, ok, d = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? `  — ${d}` : ''}`);
};

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

try {
  await send('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'attach', version: '1' },
  });
  child.stdin.write(
    JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }) + '\n',
  );

  const status = await callText('browser_status', {});
  check('attaches without launching a browser', /Chrome|Edg/.test(status), status.split('\n')[0]);
  check('did not spawn its own browser', !/blinkwire-profile/.test(status));

  const snap = await callText('browser_snapshot', {});
  check(
    "reads the user's existing tab",
    /heading "Attached"/.test(snap),
    snap.split('\n').slice(1, 3).join(' | '),
  );

  const ref = snap.match(/button "Hi" \[ref=(e\d+)\]/)?.[1];
  const clicked = await callText('browser_click', { target: ref });
  check('acts on the attached tab', /Clicked/.test(clicked), clicked.split('\n')[0]);

  const tabs = await callText('browser_tabs', { action: 'list' });
  check(
    'lists tabs of the attached browser',
    /\[0\]/.test(tabs),
    tabs.split('\n')[0]?.slice(0, 60),
  );

  const created = await callText('browser_tabs', {
    action: 'new',
    url: 'data:text/html,<h1>Second</h1>',
  });
  check('opens a new tab', /Opened a new tab/.test(created), created.split('\n')[0]);

  const after = await callText('browser_status', {});
  check(
    'current tab switched to the new one',
    /Second/.test(after) || /url:/.test(after),
    after.split('\n')[2]?.slice(0, 60),
  );
} catch (e) {
  check('attach run completed', false, e.message);
} finally {
  await stop(child);
  await stop(chrome);
  cleanDir(PROFILE);
  if (stderr.trim()) console.log('\n--- stderr ---\n' + stderr.slice(0, 1200));
  const failed = results.filter((r) => !r).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
}
