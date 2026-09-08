/**
 * Dependency-free line diff. Trims the common prefix/suffix, then runs an LCS on
 * the (usually tiny) middle. Falls back to a cheap set-based diff for huge middles.
 */
export function diffText(prev: string, next: string, contextLines = 2): string {
  const a = prev.split('\n');
  const b = next.split('\n');
  if (a.length === 0 && b.length === 0) return '';

  let start = 0;
  const maxStart = Math.min(a.length, b.length);
  while (start < maxStart && a[start] === b[start]) start++;

  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }

  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);

  let ops: Array<{ t: ' ' | '+' | '-'; s: string }> = [];
  if (midA.length === 0 && midB.length === 0) {
    ops = [];
  } else if (midA.length * midB.length > 4_000_000) {
    ops = cheapDiff(midA, midB);
  } else {
    ops = lcsDiff(midA, midB);
  }

  const out: string[] = [];
  if (start > 0) out.push(`… ${start} unchanged line${start === 1 ? '' : 's'}`);
  for (const o of ops) out.push(`${o.t} ${o.s}`);
  const tail = a.length - endA;
  if (tail > 0) out.push(`… ${tail} unchanged line${tail === 1 ? '' : 's'}`);
  return withContext(out, contextLines);
}

function cheapDiff(a: string[], b: string[]): Array<{ t: ' ' | '+' | '-'; s: string }> {
  const setB = new Set(b);
  const setA = new Set(a);
  const out: Array<{ t: ' ' | '+' | '-'; s: string }> = [];
  for (const s of a) out.push({ t: setB.has(s) ? ' ' : '-', s });
  for (const s of b) if (!setA.has(s)) out.push({ t: '+', s });
  return out;
}

function lcsDiff(a: string[], b: string[]): Array<{ t: ' ' | '+' | '-'; s: string }> {
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const out: Array<{ t: ' ' | '+' | '-'; s: string }> = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ t: ' ', s: a[i]! });
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      out.push({ t: '-', s: a[i]! });
      i++;
    } else {
      out.push({ t: '+', s: b[j]! });
      j++;
    }
  }
  while (i < n) out.push({ t: '-', s: a[i++]! });
  while (j < m) out.push({ t: '+', s: b[j++]! });
  return out;
}

function withContext(lines: string[], ctx: number): string {
  const keep = new Array<boolean>(lines.length).fill(false);
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i]![0];
    if (t === '+' || t === '-') {
      for (let k = Math.max(0, i - ctx); k <= Math.min(lines.length - 1, i + ctx); k++) keep[k] = true;
    }
  }
  const out: string[] = [];
  let skipped = 0;
  for (let i = 0; i < lines.length; i++) {
    if (keep[i] || lines[i]![0] === '…') {
      if (skipped > 0) {
        out.push(`… ${skipped} unchanged line${skipped === 1 ? '' : 's'}`);
        skipped = 0;
      }
      out.push(lines[i]!);
    } else {
      skipped++;
    }
  }
  if (skipped > 0) out.push(`… ${skipped} unchanged line${skipped === 1 ? '' : 's'}`);
  return out.join('\n');
}
