#!/usr/bin/env node
import { parseConfig } from './config.js';
import { createServer } from './server.js';
import { asBlinkwireError } from './core/errors.js';
import { warn } from './core/log.js';
import { BrowserConnection } from './cdp/connection.js';

const VERSION = '0.1.0';

function printHelp(): void {
  process.stdout.write(
    [
      `blinkwire ${VERSION} — CDP-native browser MCP server. Attaches to the Chrome you already run.`,
      '',
      'Usage: blinkwire [options]',
      '',
      '  --port <n>            DevTools port to prefer (default 9222)',
      '  --host <host>         DevTools host (default 127.0.0.1)',
      '  --cdp-endpoint <url>  Explicit DevTools HTTP base, e.g. http://127.0.0.1:9222',
      '  --launch              Opt in to starting a managed browser when none is found',
      '                        (default: attach to your running Chrome only, never create one)',
      '  --no-launch           Explicitly disable the managed-browser fallback',
      '  --headless            Headless mode (only with --launch)',
      '  --check               Verify a Chrome can be reached, print how, then exit',
      '  --match-url <s>       Attach to the tab whose URL contains this text',
      '  --match-title <s>     Attach to the tab whose title contains this text',
      '  --snapshot-mode <m>   interactive | full | minimal (default interactive)',
      '  --max-output-tokens   Hard cap per response (default 6000)',
      '  --network-capture     Enable the Network domain (needed for network_requests)',
      '  --timeout-tool <ms>   Hard ceiling per tool call (default 60000)',
      '  --prefix <p>          Tool name prefix (default browser_)',
      '  --debug               Extra diagnostics on stderr',
      '  --help                This text',
      '  --version             Print the version',
      '',
      'Attach behaviour: explicit endpoint → configured port → DevToolsActivePort of',
      'running profiles → port sweep :9222-:9245. A separate browser is started only',
      'with --launch, on a verified-free port. Without it, a missing browser is an',
      'error with instructions — never a surprise new Chrome.',
      '',
      'This process speaks MCP over stdio. Run it from an MCP client, not by hand.',
      '',
    ].join('\n'),
  );
}

/** One-shot diagnostic: prove a browser is reachable, say exactly which one, exit. */
async function runCheck(): Promise<void> {
  const cfg = parseConfig(process.argv.slice(2).filter((a) => a !== '--check'));
  const conn = await BrowserConnection.open(cfg);
  try {
    const url = await conn.current.url();
    process.stdout.write(
      `ok: attached to ${conn.version}${conn.isManaged ? ' (Blinkwire-managed)' : ''}\ntab: ${url}\n`,
    );
  } finally {
    await conn.close();
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    printHelp();
    return;
  }
  if (argv.includes('--version') || argv.includes('-v')) {
    process.stdout.write(`blinkwire ${VERSION}\n`);
    return;
  }
  if (argv.includes('--check')) {
    await runCheck();
    return;
  }
  if (process.stdin.isTTY) {
    // A person typed this by hand. It would otherwise sit here silently forever.
    process.stderr.write(
      'blinkwire speaks MCP over stdio — there is nothing to see here by hand.\n' +
        'Run it with --help for options, --check to verify a Chrome is reachable,\n' +
        'or start it from your MCP client.\n',
    );
    process.exitCode = 2;
    return;
  }

  const cfg = parseConfig(argv);
  const server = await createServer(cfg);

  let closing = false;
  const shutdown = async (): Promise<void> => {
    if (closing) return;
    closing = true;
    await server.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
  process.on('disconnect', () => void shutdown());
  process.on('uncaughtException', (error) => {
    warn(error instanceof Error ? error.message : String(error));
    void shutdown().finally(() => process.exit(1));
  });
}

main().catch((e) => {
  const be = asBlinkwireError(e);
  warn(be.message, be.hint ?? '');
  process.exit(1);
});
