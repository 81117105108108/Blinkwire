/**
 * The in-page DOM walker. Runs as ONE Runtime.evaluate and returns rendered lines
 * plus the ref table. This single round-trip is why Blinkwire snapshots faster
 * than servers that query the accessibility tree over multiple CDP calls.
 */
export const SNAPSHOT_FN_SRC = `function(arg){
  var ATTR = 'data-bw-ref';
  var mode = arg.mode || 'interactive';
  var depthLimit = arg.depth > 0 ? arg.depth : 1000;
  var boxes = !!arg.boxes;
  var maxNodes = arg.maxNodes || 1200;
  var SKIP = { SCRIPT:1, STYLE:1, NOSCRIPT:1, TEMPLATE:1, HEAD:1, META:1, LINK:1, TITLE:1, BASE:1, svg:1, SVG:1 };
  var LANDMARK = { navigation:1, main:1, banner:1, contentinfo:1, complementary:1, form:1, search:1, region:1 };
  var ROLE_RE = /^(button|link|tab|menuitem|checkbox|radio|switch|combobox|textbox|option|menuitemcheckbox|menuitemradio|searchbox|slider|spinbutton|img)$/;

  var prev = document.querySelectorAll('[' + ATTR + ']');
  for (var i = 0; i < prev.length; i++) prev[i].removeAttribute(ATTR);

  var root = arg.selector ? document.querySelector(arg.selector) : document.body;
  if (!root) return { lines: [], refs: [], url: location.href, title: document.title, truncated: false, total: 0 };

  // Pre-index label[for] once to turn O(n^2) nameOf lookups into O(1)
  var LABEL_MAP = {};
  var allLabels = document.querySelectorAll('label[for]');
  for (var li = 0; li < allLabels.length; li++) {
    var forId = allLabels[li].getAttribute('for');
    if (forId && !LABEL_MAP[forId]) LABEL_MAP[forId] = allLabels[li];
  }

  function cssEsc(s){ return String(s).replace(/["\\\\]/g, '\\\\$&'); }
  function txt(s){ return String(s == null ? '' : s).replace(/\\s+/g, ' ').trim(); }

  function visible(el){
    if (el.hasAttribute('hidden')) return false;
    // Fast path: if offsetParent is null and element is not fixed/sticky, it is not displayed
    if (el.offsetParent === null && el !== document.body && el !== document.documentElement) {
      var pos = getComputedStyle(el).position;
      if (pos !== 'fixed' && pos !== 'sticky') return false;
    }
    if (el.getClientRects().length === 0) return false;
    var cs = getComputedStyle(el);
    if (cs.visibility === 'hidden') return false;
    if (parseFloat(cs.opacity || '1') < 0.01) return false;
    return true;
  }

  function directText(el){
    var s = '';
    for (var i = 0; i < el.childNodes.length; i++) {
      var n = el.childNodes[i];
      if (n.nodeType === 3) s += n.nodeValue;
    }
    return txt(s);
  }

  function roleOf(el){
    var r = el.getAttribute('role');
    if (r) return r;
    var t = el.tagName;
    var ty = (el.getAttribute('type') || '').toLowerCase();
    switch (t) {
      case 'A': return el.hasAttribute('href') ? 'link' : 'generic';
      case 'BUTTON': return 'button';
      case 'SELECT': return 'combobox';
      case 'TEXTAREA': return 'textbox';
      case 'SUMMARY': return 'button';
      case 'NAV': return 'navigation';
      case 'MAIN': return 'main';
      case 'HEADER': return 'banner';
      case 'FOOTER': return 'contentinfo';
      case 'ASIDE': return 'complementary';
      case 'FORM': return 'form';
      case 'TABLE': return 'table';
      case 'UL': case 'OL': return 'list';
      case 'LI': return 'listitem';
      case 'IFRAME': return 'iframe';
      case 'DIALOG': return 'dialog';
      case 'PROGRESS': return 'progressbar';
      case 'IMG': return 'img';
      case 'INPUT':
        if (ty === 'checkbox') return 'checkbox';
        if (ty === 'radio') return 'radio';
        if (ty === 'submit' || ty === 'button' || ty === 'reset' || ty === 'image') return 'button';
        if (ty === 'file') return 'filebutton';
        return 'textbox';
      default:
        if (t.length === 2 && t.charAt(0) === 'H' && t >= 'H1' && t <= 'H6') return 'heading';
        return 'generic';
    }
  }

  function nameOf(el){
    var n = el.getAttribute('aria-label');
    if (n) return txt(n).slice(0, 160);
    var lb = el.getAttribute('aria-labelledby');
    if (lb) {
      var parts = lb.split(/\\s+/).map(function(id){
        var t = document.getElementById(id);
        return t ? (t.innerText || t.textContent || '') : '';
      }).join(' ');
      if (txt(parts)) return txt(parts).slice(0, 160);
    }
    var alt = el.getAttribute('alt');
    if (alt) return txt(alt).slice(0, 160);
    var ti = el.getAttribute('title');
    if (ti) return txt(ti).slice(0, 160);
    var ph = el.getAttribute('placeholder');
    if (ph) return txt(ph).slice(0, 160);
    var t = el.tagName;
    if (t === 'INPUT' || t === 'SELECT' || t === 'TEXTAREA') {
      if (el.id && LABEL_MAP[el.id]) {
        var l = LABEL_MAP[el.id];
        return txt(l.innerText || l.textContent).slice(0, 160);
      }
      var p = el.closest ? el.closest('label') : null;
      if (p) return txt(p.innerText || p.textContent).slice(0, 160);
      var ty = (el.getAttribute('type') || '').toLowerCase();
      if ((ty === 'submit' || ty === 'button' || ty === 'reset') && el.value) return txt(el.value).slice(0, 160);
    }
    var d = directText(el);
    if (d) return d.slice(0, 160);
    return '';
  }

  function interactive(el){
    var t = el.tagName;
    if (t === 'A') return el.hasAttribute('href');
    if (t === 'BUTTON' || t === 'SELECT' || t === 'TEXTAREA' || t === 'SUMMARY') return true;
    if (t === 'INPUT') return (el.getAttribute('type') || '').toLowerCase() !== 'hidden';
    if (el.getAttribute('contenteditable') === 'true') return true;
    var r = el.getAttribute('role');
    if (r && ROLE_RE.test(r)) return true;
    var tabi = el.getAttribute('tabindex');
    if (tabi !== null && tabi !== '-1') return true;
    return false;
  }

  function interesting(el){
    if (interactive(el)) return true;
    var r = roleOf(el);
    if (r === 'heading') return true;
    if (LANDMARK[r]) return true;
    return false;
  }

  var truncated = false;
  var total = 0;
  var keep = [];
  function mark(el, d){
    total++;
    if (total > 20000) { truncated = true; return false; }
    if (el.getAttribute('aria-hidden') === 'true' && el !== root) return false;
    var any = false;
    if (d < depthLimit) {
      for (var i = 0; i < el.children.length; i++) {
        var c = el.children[i];
        if (SKIP[c.tagName]) continue;
        if (!visible(c)) continue;
        if (mark(c, d + 1)) any = true;
      }
    }
    var self = mode === 'full' ? true : interesting(el);
    if (self || any) { keep.push(el); return true; }
    return false;
  }
  var keepSet = new Set();
  function markRoot(){
    var stack = [];
    function visit(el, d){
      total++;
      if (total > 20000) { truncated = true; return false; }
      if (el.getAttribute('aria-hidden') === 'true' && el !== root) return false;
      var any = false;
      if (d < depthLimit) {
        for (var i = 0; i < el.children.length; i++) {
          var c = el.children[i];
          if (SKIP[c.tagName]) continue;
          if (!visible(c)) continue;
          if (visit(c, d + 1)) any = true;
        }
      }
      var self = mode === 'full' ? true : interesting(el);
      if (self || any) { keepSet.add(el); }
      return self || any;
    }
    visit(root, 0);
  }
  markRoot();

  var refs = [];
  var refCount = 0;
  var els = {};
  var lines = [];
  var emitted = 0;

  function states(el){
    var out = '';
    if (el.disabled) out += ' [disabled]';
    if (el.tagName === 'INPUT' || el.tagName === 'OPTION') {
      if (el.checked) out += ' [checked]';
      if (el.selected) out += ' [selected]';
      if (el.required) out += ' [required]';
    }
    if (el.tagName === 'SELECT' && el.required) out += ' [required]';
    var exp = el.getAttribute('aria-expanded');
    if (exp === 'true') out += ' [expanded]';
    else if (exp === 'false') out += ' [collapsed]';
    var pr = el.getAttribute('aria-pressed');
    if (pr === 'true') out += ' [pressed]';
    if (document.activeElement === el) out += ' [focused]';
    return out;
  }

  function valueOf(el){
    var t = el.tagName;
    if (t === 'INPUT' || t === 'TEXTAREA' || t === 'SELECT') {
      var ty = (el.getAttribute('type') || '').toLowerCase();
      if (ty === 'password') return '';
      var v = el.value;
      if (v && String(v).length && ty !== 'checkbox' && ty !== 'radio' && ty !== 'file') {
        return ' [value=' + JSON.stringify(String(v).slice(0, 40)) + ']';
      }
    }
    return '';
  }

  function render(el, indent, path){
    if (emitted >= maxNodes) { truncated = true; return; }
    var r = roleOf(el);
    var nm = nameOf(el);
    var isI = interactive(el);
    var ref = '';
    if (isI) {
      refCount++;
      var id = 'e' + refCount;
      ref = ' [ref=' + id + ']';
      el.setAttribute(ATTR, id);
      els[id] = el;
      refs.push({ id: id, tag: el.tagName.toLowerCase() });
    }
    var lvl = r === 'heading' ? ' [level=' + el.tagName.charAt(1) + ']' : '';
    var bx = '';
    if (boxes) {
      var rc = el.getBoundingClientRect();
      bx = ' [box=' + Math.round(rc.left) + ',' + Math.round(rc.top) + ',' + Math.round(rc.width) + ',' + Math.round(rc.height) + ']';
    }
    var line = r + (nm ? ' ' + JSON.stringify(nm) : '') + ref + lvl + states(el) + valueOf(el) + bx;
    if (mode === 'minimal') {
      if (isI) { lines.push((path ? path + ' > ' : '') + line); emitted++; }
    } else {
      lines.push(new Array(indent + 1).join('  ') + '- ' + line);
      emitted++;
    }
    var kids = [];
    for (var i = 0; i < el.children.length; i++) {
      var c = el.children[i];
      if (SKIP[c.tagName]) continue;
      if (!keepSet.has(c)) continue;
      kids.push(c);
    }
    if (mode === 'minimal') {
      for (var k = 0; k < kids.length; k++) render(kids[k], indent, path ? path + ' > ' + r : r);
      return;
    }
    if (kids.length === 1 && !interesting(el) && r === 'generic' && !nm) {
      render(kids[0], indent, path);
      return;
    }
    for (var j = 0; j < kids.length; j++) render(kids[j], indent + 1, path);
  }

  var startChildren = [];
  for (var i = 0; i < root.children.length; i++) {
    var c = root.children[i];
    if (SKIP[c.tagName]) continue;
    if (!keepSet.has(c)) continue;
    startChildren.push(c);
  }
  if (mode === 'minimal') {
    for (var m = 0; m < startChildren.length; m++) render(startChildren[m], 0, '');
  } else if (startChildren.length === 1 && !interesting(root)) {
    render(startChildren[0], 0, '');
  } else {
    for (var s = 0; s < startChildren.length; s++) render(startChildren[s], 1, '');
  }

  if (!window.__bw) window.__bw = { v: 1, els: {} };
  window.__bw.els = els;
  return { lines: lines, refs: refs, url: location.href, title: document.title, truncated: truncated, total: total };
}`;
