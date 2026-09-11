# Blinkwire

[![CI](https://github.com/81117105108108/Blinkwire/actions/workflows/ci.yml/badge.svg)](https://github.com/81117105108108/Blinkwire/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/blinkwire.svg)](https://www.npmjs.com/package/blinkwire)
[![license](https://img.shields.io/github/license/81117105108108/Blinkwire.svg)](https://github.com/81117105108108/Blinkwire/blob/main/LICENSE)
[![node](https://img.shields.io/node/v/blinkwire.svg)](https://nodejs.org/)

A drop-in replacement for [Playwright MCP](https://github.com/microsoft/playwright-mcp) built **directly on the Chrome DevTools Protocol**. No Playwright, no Puppeteer, no browser download. Blinkwire attaches to a Chrome you already have running and gives an LLM the same tools, with fewer round-trips and far fewer tokens.

```
playwright-mcp:  spawn browser (~1-3s) → Playwright → CDP → polling actionability → accessibility tree
blinkwire:       attach (0ms) → CDP → 1-4 calls per action → pruned tree
```

## Table of Contents

- [Installation](#installation)
- [Quick Start](#quick-start)
- [Configuration](#configuration)
- [Tools](#tools)
- [Examples](#examples)
- [Development](#development)
- [Security](#security)
- [License](#license)

## Why it is faster

| | Playwright MCP | Blinkwire |
|---|---|---|
| Startup | launches a browser (1-3 s) | attaches to yours (0 ms) |
| Deps | Playwright + browser binaries (~400 MB) | `ws` + MCP SDK |
| Typing | 4 key events **per character** | direct bulk string insertion (`Input.insertText`) |
| Click | scroll + actionability polling (10-30 CDP calls) | 1 geometry eval + 3 `Input` calls |
| Scroll | synthetic wheel animation | 1 eval |
| Waiting | fixed `--timeout-settle` sleep | `MutationObserver` — resolves on the first idle frame |
| Snapshot | full accessibility dump | interactive/landmark/heading tree, or a diff |
| Multi-step | N MCP round-trips | **1** via `browser_batch` |
| Network domain | always on | **off** by default (`--network-capture` to enable) |

## Install

```bash
cd blinkwire
npm install
npm run build
```

### Blinkwire finds your Chrome; you don't point it at one

Startup order, first validated hit wins:

1. `--cdp-endpoint`, if given
2. the configured port (default `:9222`)
3. any `DevToolsActivePort` your installed Chrome profiles advertise
4. a sweep of `:9222`–`:9245`

A port is only accepted if `/json/version` answers with a real `Browser` string — a browser that *owns* a port but serves no DevTools (the classic broken-9222 case) is skipped, not attached.

If nothing debuggable exists, Blinkwire **fails with guidance instead of silently opening a new browser** — your tabs are yours. Pass `--launch` only when you explicitly want a separate, managed Chrome (it starts on a verified-free port, announces itself on stderr, and shows `(Blinkwire-managed)` in `browser_status`).

Your own daily Chrome only becomes visible if you restart it once with a debugging port — Chrome only reads that flag at startup:

```bash
# Windows
"C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222

# macOS
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome --remote-debugging-port=9222

# Linux
google-chrome --remote-debugging-port=9222
```

Verify without starting a client: `blinkwire --check` (prints which browser it attached to, then exits).

Running `node dist/index.js` by hand with no MCP client attached now says so and exits instead of hanging.

## Configure your client

Tool names are prefixed `browser_` by default, so Blinkwire is a literal drop-in.

**opencode** (`~/.config/opencode/opencode.json`)

```json
{
  "mcp": {
    "blinkwire": {
      "type": "local",
      "command": ["node", "C:/Users/You/Projects/blinkwire/dist/index.js"],
      "enabled": true
    }
  }
}
```

**Claude Desktop / Cursor / Cline / VS Code**

```json
{
  "mcpServers": {
    "blinkwire": {
      "command": "node",
      "args": ["C:/Users/You/Projects/blinkwire/dist/index.js"]
    }
  }
}
```

## Options

Every flag also reads a `BLINKWIRE_*` env var (e.g. `BLINKWIRE_PORT`).

| Flag | Default | Purpose |
|---|---|---|
| `--port`, `--host` | `9222`, `127.0.0.1` | Where Chrome exposes CDP |
| `--cdp-endpoint` | — | Full endpoint, e.g. `http://127.0.0.1:9222` |
| `--launch` | off | Opt in to a managed browser when no debuggable one is found (default: attach only, fail otherwise) |
| `--headless` | off | Only with `--launch` |
| `--executable-path` | auto | Chrome/Edge binary |
| `--user-data-dir` | temp | Profile dir (only used when Blinkwire launches) |
| `--match-url`, `--match-title`, `--match-index` | — | Which existing tab to attach to |
| `--snapshot-mode` | `interactive` | `interactive` \| `full` \| `minimal` |
| `--snapshot-boxes` | off | Add `[box=x,y,w,h]` to every node |
| `--max-output-tokens` | `6000` | Hard cap on any single response |
| `--console-level` | `info` | Minimum console severity |
| `--image-responses` | `allow` | `omit` to suppress inline images |
| `--network-capture` | off | Enable the Network domain (slower, but needed for `browser_network_requests`) |
| `--timeout-settle` | `500` | Max ms to wait for the page to settle |
| `--timeout-tool` | `60000` | Hard ceiling per tool call — a wedged action cannot stall the queue |
| `--check` | — | Verify a browser is reachable, print which one, exit |
| `--output-dir` | temp dir | Where `filename` arguments are written |
| `--prefix` | `browser_` | Tool-name prefix |
| `--debug` | off | Emit timings into `_meta` |

## Tools (56)

Covers the primary Playwright MCP core automation and utility surface, plus a few extras (batch, diff). Playwright code generator (`codegen`) and verification test wrappers are intentionally omitted in favor of lean execution.

**Navigation** `browser_navigate` `browser_navigate_back` `browser_navigate_forward` `browser_reload` `browser_wait_for`

**Reading** `browser_snapshot` `browser_find` `browser_snapshot_diff` `browser_evaluate`

**Interaction** `browser_click` `browser_hover` `browser_type` `browser_press_key` `browser_select_option` `browser_drag` `browser_drop` `browser_file_upload` `browser_fill_form` `browser_handle_dialog`

**Coordinates** `browser_mouse_move_xy` `browser_mouse_click_xy` `browser_mouse_drag_xy` `browser_mouse_wheel` `browser_scroll`

**Capture** `browser_take_screenshot` `browser_pdf_save` `browser_console_messages` `browser_network_requests` `browser_network_request`

**Tabs & session** `browser_tabs` `browser_close` `browser_resize` `browser_connect` `browser_install` `browser_status` `browser_get_config`

**Storage & network** `browser_cookie_{list,get,set,delete,clear}` `browser_localstorage_{list,get,set,delete,clear}` `browser_sessionstorage_{list,get,set,delete,clear}` `browser_network_state_set` `browser_route` `browser_route_list` `browser_unroute`

**Extras** `browser_batch` — run N actions in one round-trip.

## The three things that save the most

**1. `browser_batch`.** One MCP call, N actions, one settle at the end.

```json
{ "steps": [
  { "tool": "click",   "args": { "target": "e7" } },
  { "tool": "type",    "args": { "target": "e3", "text": "blinkwire" } },
  { "tool": "click",   "args": { "target": "e9" } }
]}
```
→ `1. click ok 4ms / 2. type ok 6ms / 3. click ok 3ms — 3/3 ok, 16ms total`

**2. `browser_snapshot_diff`.** After an action, see only what changed — usually 3-6 lines instead of a whole tree.

**3. `browser_find`.** Locate one element without re-reading the page.

## How the speed works

- **One eval per snapshot.** The DOM walk, role mapping, naming, ref assignment and rendering all happen in-page inside a single `Runtime.evaluate`. Nothing is queried node-by-node over CDP.
- **Refs live in the page.** Elements are held in `window.__bw.els`, so `e4` resolves to geometry in one round-trip with no DOM-domain traffic.
- **Settle, don't sleep.** `settle()` installs a `MutationObserver` and resolves on the first idle frame. A static page costs ~1 ms instead of a fixed 500 ms.
- **No DOM domain in the hot path.** Only `file_upload`, `resize` and selector fallbacks touch it.
- **Fail fast, fail helpfully.** Stale refs, invisible elements and unmatched options all return a one-line error naming the fix.

## Limits

- Chromium-family only (Chrome, Edge, Brave). CDP is the whole point.
- `browser_resize` needs a browser-level connection; without one it falls back to viewport emulation and says so.
- Cross-origin iframes are snapshot from the top document only.
- Network inspection is opt-in because keeping the Network domain enabled measurably slows every navigation.

## Development

```bash
npm run build     # tsc -> dist/
npm test          # unit tests (node --test + tsx)
npm run test:integration  # smoke + attach suites (spawn real Chrome)
npm run lint
npm run coverage
npm run dev       # watch
```

## Examples

End-to-end via MCP client (tool names use default `browser_` prefix):

```ts
import { Client } from '@modelcontextprotocol/sdk/client/index.js';

const browser = await Blinkwire.launch();

await browser.browser_navigate({ url: 'https://example.com' });
await browser.browser_click({ target: 'e4' });
await browser.browser_type({ target: 'e3', text: 'user@example.com' });
await browser.browser_click({ target: 'e9' });
await browser.browser_wait_for({ text: 'Dashboard' });

const snapshot = await browser.browser_snapshot();
console.log(snapshot);

await browser.close();
```

## Diff limits

`diffText` trims common prefix/suffix then LCS on the middle. Once
`(a.length+1)*(b.length+1)` exceeds `MAX_DP_CELLS` (default `4_000_000`,
override with `BLINKWIRE_MAX_DP_CELLS`) it falls back to a cheap
set-based diff — very large snapshots stay fast but coarser.

Architecture: `src/cdp` (transport, discovery, session) → `src/core` (refs, snapshot, diff, wait, image, budget) → `src/tools` (one module per tool family) → `src/server.ts` (MCP wiring).
