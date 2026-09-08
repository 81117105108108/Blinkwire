import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * Normalizes output file writing to a dedicated directory and returns a file:// URL.
 */
export async function saveOutputFile(
  outputDir: string,
  filename: string,
  data: string | Uint8Array,
  encoding: BufferEncoding = 'utf8',
): Promise<string> {
  const dir = outputDir && outputDir.trim() ? outputDir : path.join(process.cwd(), 'blinkwire-output');
  await fs.mkdir(dir, { recursive: true });
  const file = path.isAbsolute(filename) ? filename : path.join(dir, filename);
  await fs.writeFile(file, data, typeof data === 'string' ? encoding : undefined);
  return pathToFileURL(file).href;
}
