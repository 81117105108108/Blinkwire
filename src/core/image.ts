import type { PageSession } from '../cdp/session.js';
import { BlinkwireError } from './errors.js';

export interface ShotOpts {
  format?: 'png' | 'jpeg' | 'webp';
  quality?: number;
  fullPage?: boolean;
  target?: string;
  maxBytes?: number;
  scale?: 'css' | 'device';
  maxWidth?: number;
  resolveBox?: (target: string) => Promise<{ x: number; y: number; width: number; height: number }>;
}

export interface Shot {
  mime: string;
  data: string;
  width: number;
  height: number;
  bytes: number;
}

const MIME: Record<string, string> = { png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp' };

/**
 * Screenshot with a no-dependency downscale ladder. Blinkwire never ships a full
 * 4K PNG into the model's context unless you ask for it.
 */
export async function screenshot(session: PageSession, opts: ShotOpts = {}): Promise<Shot> {
  await session.ensure('Page');
  const format = opts.format ?? 'png';
  const mime = MIME[format]!;
  const maxBytes = opts.maxBytes ?? 1_500_000;
  let quality = opts.quality ?? (format === 'png' ? undefined : 80);

  let clip: { x: number; y: number; width: number; height: number; scale: number } | undefined;
  if (opts.target && opts.resolveBox) {
    const b = await opts.resolveBox(opts.target);
    clip = { x: b.x, y: b.y, width: b.width, height: b.height, scale: 1 };
  }

  let metrics: any;
  try {
    metrics = await session.cdp.send<any>('Page.getLayoutMetrics');
  } catch {
    metrics = undefined;
  }
  const cssViewport = metrics?.cssVisualViewport ?? metrics?.cssLayoutViewport;
  const contentSize = metrics?.cssContentSize;
  const width = clip
    ? Math.round(clip.width)
    : opts.fullPage === true && contentSize?.width
      ? Math.round(contentSize.width)
      : Math.round(cssViewport?.clientWidth ?? 1280);
  const height = clip
    ? Math.round(clip.height)
    : opts.fullPage === true && contentSize?.height
      ? Math.round(contentSize.height)
      : Math.round(cssViewport?.clientHeight ?? 720);

  // maxWidth is honoured by rendering at a reduced device scale factor — no image
  // library needed, and it shrinks the payload before it ever reaches the model.
  const widthDsf = opts.maxWidth && opts.maxWidth > 0 && width > opts.maxWidth ? opts.maxWidth / width : 1;

  const ladder: Array<{ quality?: number; dsf: number }> = [
    { quality, dsf: widthDsf },
    { quality: 50, dsf: Math.min(widthDsf, 0.75) },
    { quality: 35, dsf: Math.min(widthDsf, 0.5) },
  ];

  let last: Shot | undefined;
  let appliedDsf: number | undefined;

  for (const step of ladder) {
    if (step.dsf < 1 && appliedDsf !== step.dsf) {
      appliedDsf = step.dsf;
      try {
        await session.ensure('Emulation');
        await session.cdp.send('Emulation.setDeviceMetricsOverride', {
          width: Math.max(320, Math.round(width)),
          height: Math.max(240, Math.round(height)),
          deviceScaleFactor: step.dsf,
          mobile: false,
        });
      } catch {
        /* ignore: the window may resist a metrics override */
      }
    }
    const params: Record<string, unknown> = {
      format,
      optimizeForSpeed: true,
      captureBeyondViewport: opts.fullPage === true && !clip,
      ...(step.quality !== undefined && format !== 'png' ? { quality: step.quality } : {}),
      ...(clip ? { clip: { ...clip, scale: clip.scale } } : {}),
      ...(opts.scale === 'device' ? { fromSurface: true } : {}),
    };
    const r = await session.cdp.send<{ data: string }>('Page.captureScreenshot', params);
    last = {
      mime,
      data: r.data,
      width: Math.round(width * step.dsf),
      height: Math.round(height * step.dsf),
      bytes: Math.ceil((r.data.length * 3) / 4),
    };
    if (last.bytes <= maxBytes) break;
  }

  if (appliedDsf !== undefined) {
    try {
      await session.cdp.send('Emulation.clearDeviceMetricsOverride');
    } catch {
      /* ignore */
    }
  }
  if (!last) throw new BlinkwireError('Screenshot failed.', 'capture_failed');
  return last;
}
