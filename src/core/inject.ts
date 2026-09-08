import type { PageSession } from '../cdp/session.js';

/**
 * In-page helper installed once per navigation. Gives Blinkwire 1-call geometry,
 * focus, select and scroll without touching the DOM domain at all.
 * Serialised and evaluated as a plain string — keep it ES5-safe and self-contained.
 */
export const INJECT_SRC = `function(){
  if (window.__bw && window.__bw.v === 1) return 'ok';
  function clamp(v, lo, hi){ return v < lo ? lo : (v > hi ? hi : v); }
  window.__bw = {
    v: 1,
    els: {},
    box: function(el, scroll){
      if (!el) return null;
      if (scroll !== false) { try { el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' }); } catch(e){} }
      var r = el.getBoundingClientRect();
      var cs = getComputedStyle(el);
      var vw = window.innerWidth, vh = window.innerHeight;
      var op = parseFloat(cs.opacity || '1');
      return {
        x: r.left, y: r.top, width: r.width, height: r.height,
        cx: clamp(r.left + r.width / 2, 0, Math.max(vw - 1, 0)),
        cy: clamp(r.top + r.height / 2, 0, Math.max(vh - 1, 0)),
        visible: r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && op > 0.01,
        inViewport: r.bottom > 0 && r.right > 0 && r.top < vh && r.left < vw,
        scrolled: scroll !== false
      };
    },
    focus: function(el){ if (!el) return false; try { el.focus({ preventScroll: false }); } catch(e){ try { el.focus(); } catch(e2){} } return document.activeElement === el; },
    scroll: function(el, dx, dy){
      var t = el || document.scrollingElement || document.documentElement;
      var before = { x: t.scrollLeft, y: t.scrollTop };
      if (t === document.scrollingElement || t === document.documentElement || t === document.body) {
        window.scrollBy(dx, dy);
      } else { t.scrollLeft += dx; t.scrollTop += dy; }
      var after = { x: t.scrollLeft, y: t.scrollTop };
      var maxY = Math.max(0, (t.scrollHeight || 0) - (t.clientHeight || window.innerHeight));
      return { x: after.x, y: after.y, dx: after.x - before.x, dy: after.y - before.y, maxY: maxY,
               atEnd: Math.abs(after.y - maxY) < 2, atTop: after.y < 2 };
    },
    setFiles: function(el){ return !!(el && el.tagName === 'INPUT'); }
  };
  return 'ok';
}`;

/** 1-RTT element lookup by ref id. Returns a live objectId for Runtime.callFunctionOn. */
export const REF_EXPR = (id: string): string =>
  `(function(){ var e = window.__bw && window.__bw.els[${JSON.stringify(id)}]; return e || null; })()`;

const injectedAt = new WeakMap<PageSession, number>();

/** Idempotent per navigation. Costs one evaluate only after a navigation. */
export async function ensureInjected(session: PageSession): Promise<void> {
  if (injectedAt.get(session) === session.buffers.navSeq) return;
  await session.eval(INJECT_SRC, undefined, { awaitPromise: false });
  injectedAt.set(session, session.buffers.navSeq);
}
