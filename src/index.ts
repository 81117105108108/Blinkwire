#!/usr/bin/env node
import { parseConfig } from './config.js';
import { createServer } from './server.js';
import { asBlinkwireError } from './core/errors.js';
import { warn } from './core/log.js';

async function main(): Promise<void> {
  const cfg = parseConfig(process.argv.slice(2));
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
}

main().catch((e) => {
  const be = asBlinkwireError(e);
  warn(be.message, be.hint ?? '');
  process.exit(1);
});
