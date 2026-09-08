export type SnapshotMode = 'interactive' | 'full' | 'minimal';
export type ConsoleLevel = 'error' | 'warning' | 'info' | 'debug';
import os from 'node:os';
import path from 'node:path';

export interface BlinkwireConfig {
  prefix: string;
  host: string;
  port: number;
  cdpEndpoint?: string;
  launch: boolean;
  executablePath?: string;
  userDataDir?: string;
  headless: boolean;
  match?: { url?: string; title?: string; index?: number };

  snapshotMode: SnapshotMode;
  snapshotBoxes: boolean;
  maxOutputTokens: number;
  consoleLevel: ConsoleLevel;
  imageResponses: 'allow' | 'omit';
  outputDir: string;

  timeoutAction: number;
  timeoutNavigation: number;
  timeoutSettle: number;

  /** Network domain is OFF by default — it is the single biggest per-navigation cost. */
  networkCapture: boolean;
  testIdAttribute: string;
  debug: boolean;
}

export const DEFAULT_CONFIG: BlinkwireConfig = {
  prefix: 'browser_',
  host: '127.0.0.1',
  port: 9222,
  launch: false,
  headless: false,
  snapshotMode: 'interactive',
  snapshotBoxes: false,
  maxOutputTokens: 6000,
  consoleLevel: 'info',
  imageResponses: 'allow',
  outputDir: path.join(os.tmpdir(), 'blinkwire-output'),
  timeoutAction: 5000,
  timeoutNavigation: 30000,
  timeoutSettle: 500,
  networkCapture: false,
  testIdAttribute: 'data-testid',
  debug: false,
};

function env(name: string): string | undefined {
  const v = process.env[name];
  return v === undefined || v === '' ? undefined : v;
}

function baseUrl(cfg: BlinkwireConfig): string {
  if (cfg.cdpEndpoint) return cfg.cdpEndpoint.replace(/\/+$/, '');
  return `http://${cfg.host}:${cfg.port}`;
}

export function httpBase(cfg: BlinkwireConfig): string {
  return baseUrl(cfg);
}

export function parseConfig(argv: string[]): BlinkwireConfig {
  const cfg: BlinkwireConfig = { ...DEFAULT_CONFIG };
  cfg.outputDir = env('BLINKWIRE_OUTPUT_DIR') ?? path.join(os.tmpdir(), 'blinkwire-output');

  const e = (k: string) => env(`BLINKWIRE_${k}`);
  if (e('PREFIX')) cfg.prefix = e('PREFIX')!;
  if (e('CDP_ENDPOINT')) cfg.cdpEndpoint = e('CDP_ENDPOINT');
  if (e('HOST')) cfg.host = e('HOST')!;
  if (e('PORT')) cfg.port = Number(e('PORT')) || cfg.port;
  if (e('EXECUTABLE_PATH')) cfg.executablePath = e('EXECUTABLE_PATH');
  if (e('USER_DATA_DIR')) cfg.userDataDir = e('USER_DATA_DIR');
  if (e('HEADLESS')) cfg.headless = e('HEADLESS') !== '0' && e('HEADLESS') !== 'false';
  if (e('LAUNCH')) cfg.launch = e('LAUNCH') === '1' || e('LAUNCH') === 'true';
  if (e('SNAPSHOT_MODE')) cfg.snapshotMode = e('SNAPSHOT_MODE') as SnapshotMode;
  if (e('MAX_OUTPUT_TOKENS')) cfg.maxOutputTokens = Number(e('MAX_OUTPUT_TOKENS')) || cfg.maxOutputTokens;
  if (e('CONSOLE_LEVEL')) cfg.consoleLevel = e('CONSOLE_LEVEL') as ConsoleLevel;
  if (e('NETWORK_CAPTURE')) cfg.networkCapture = e('NETWORK_CAPTURE') === '1' || e('NETWORK_CAPTURE') === 'true';
  if (e('TEST_ID_ATTRIBUTE')) cfg.testIdAttribute = e('TEST_ID_ATTRIBUTE')!;
  if (env('BLINKWIRE_DEBUG')) cfg.debug = true;

  const flags = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith('--')) continue;
    const eq = a.indexOf('=');
    const key = eq === -1 ? a.slice(2) : a.slice(2, eq);
    const inlineVal = eq === -1 ? undefined : a.slice(eq + 1);
    flags.add(key);

    const next = (): string | undefined => {
      if (inlineVal !== undefined) return inlineVal;
      const nxt = argv[i + 1];
      if (nxt === undefined || nxt.startsWith('--')) return undefined;
      i++;
      return nxt;
    };
    const bool = (): boolean => {
      if (inlineVal === undefined) return !key.startsWith('no-');
      return inlineVal !== '0' && inlineVal !== 'false';
    };

    switch (key) {
      case 'prefix': cfg.prefix = next() ?? cfg.prefix; break;
      case 'cdp-endpoint': cfg.cdpEndpoint = next(); break;
      case 'host': cfg.host = next() ?? cfg.host; break;
      case 'port': cfg.port = Number(next()) || cfg.port; break;
      case 'executable-path': cfg.executablePath = next(); break;
      case 'user-data-dir': cfg.userDataDir = next(); break;
      case 'headless': case 'no-headless': cfg.headless = bool() && key === 'headless'; break;
      case 'launch': case 'no-launch': cfg.launch = key === 'launch'; break;
      case 'match-url': cfg.match = { ...cfg.match, url: next() }; break;
      case 'match-title': cfg.match = { ...cfg.match, title: next() }; break;
      case 'match-index': cfg.match = { ...cfg.match, index: Number(next()) }; break;
      case 'snapshot-mode': cfg.snapshotMode = (next() as SnapshotMode) ?? cfg.snapshotMode; break;
      case 'snapshot-boxes': case 'no-snapshot-boxes': cfg.snapshotBoxes = key === 'snapshot-boxes'; break;
      case 'max-output-tokens': cfg.maxOutputTokens = Number(next()) || cfg.maxOutputTokens; break;
      case 'console-level': cfg.consoleLevel = (next() as ConsoleLevel) ?? cfg.consoleLevel; break;
      case 'image-responses': cfg.imageResponses = (next() as 'allow' | 'omit') ?? cfg.imageResponses; break;
      case 'output-dir': cfg.outputDir = next() ?? cfg.outputDir; break;
      case 'timeout-action': cfg.timeoutAction = Number(next()) || cfg.timeoutAction; break;
      case 'timeout-navigation': cfg.timeoutNavigation = Number(next()) || cfg.timeoutNavigation; break;
      case 'timeout-settle': cfg.timeoutSettle = Number(next()) || cfg.timeoutSettle; break;
      case 'network-capture': case 'no-network-capture': cfg.networkCapture = key === 'network-capture'; break;
      case 'test-id-attribute': cfg.testIdAttribute = next() ?? cfg.testIdAttribute; break;
      case 'debug': cfg.debug = true; break;
      default: break;
    }
  }
  if (cfg.debug) process.env.BLINKWIRE_DEBUG = '1';
  return cfg;
}
