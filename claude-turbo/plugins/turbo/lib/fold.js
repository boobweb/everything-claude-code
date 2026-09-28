'use strict';
// Folding of huge lines (base64 data URIs, minified bundles, embedded blobs) so the
// model never has to read megabytes of noise to see one function.

const DATA_URI_RE = /data:([\w.+-]+\/[\w.+-]+)?(?:;[\w=-]+)*;base64,/i;
const B64_RUN_RE = /[A-Za-z0-9+/]{240,}={0,2}/;

function classify(line) {
  const m = DATA_URI_RE.exec(line);
  if (m) return `base64 data URI${m[1] ? ` (${m[1]})` : ''}`;
  if (B64_RUN_RE.test(line)) return 'base64-like blob';
  if (/["'][^"']{400,}["']/.test(line)) return 'long string literal';
  const semis = (line.match(/;/g) || []).length;
  const braces = (line.match(/[{}]/g) || []).length;
  if (semis + braces > line.length / 40) return 'minified code';
  return 'long line';
}

/**
 * Fold a single line if it is longer than `over` chars.
 * Returns the (possibly) folded string plus metadata.
 */
function foldLine(line, { over = 400, keep = 120 } = {}) {
  if (line.length <= over) return { text: line, folded: false };
  const kind = classify(line);
  const head = line.slice(0, keep);
  const tailKeep = kind === 'minified code' || kind === 'long line' ? 40 : 16;
  const tail = line.slice(-tailKeep);
  return {
    text: `${head} …[folded ${(line.length - keep - tailKeep).toLocaleString('en-US')} chars: ${kind}]… ${tail}`,
    folded: true,
    kind,
    length: line.length,
  };
}

/**
 * Format a range of lines with numbers, folding long ones.
 * lines: array of strings; startLine: 1-based number of lines[0].
 */
function formatLines(lines, startLine, opts = {}) {
  const width = String(startLine + lines.length - 1).length;
  const out = [];
  let foldedCount = 0;
  let foldedChars = 0;
  for (let i = 0; i < lines.length; i++) {
    const f = opts.fold === false ? { text: lines[i], folded: false } : foldLine(lines[i], opts);
    if (f.folded) { foldedCount++; foldedChars += f.length; }
    out.push(`${String(startLine + i).padStart(width)}│ ${f.text}`);
  }
  return { text: out.join('\n'), foldedCount, foldedChars };
}

/**
 * Scan a whole text for blob lines. Returns summary and a list of the biggest blob ranges.
 */
function blobMap(text, { threshold = 1000, maxItems = 25 } = {}) {
  const items = [];
  let total = 0;
  let lineNo = 1;
  let pos = 0;
  const len = text.length;
  while (pos <= len) {
    let nl = text.indexOf('\n', pos);
    if (nl === -1) nl = len;
    const l = nl - pos;
    if (l >= threshold) {
      const line = text.slice(pos, nl);
      const kind = classify(line);
      total += l;
      // Try to name the blob: look for a nearby identifier like `const X =` or `"key":` or src=/href=
      const ctx = text.slice(Math.max(0, pos - 200), pos + Math.min(160, l));
      let label = null;
      const m1 = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=[^\n]*$/.exec(text.slice(Math.max(0, pos - 200), pos + 60));
      const m2 = /["']?([A-Za-z_$][\w$-]{1,40})["']?\s*:\s*["']?data:/.exec(ctx);
      const m3 = /(src|href|url)\s*[=(]\s*["']?data:/i.exec(ctx);
      if (m1) label = m1[1]; else if (m2) label = m2[1]; else if (m3) label = m3[1].toLowerCase();
      items.push({ line: lineNo, length: l, kind, label });
    }
    lineNo++;
    pos = nl + 1;
    if (nl === len) break;
  }
  items.sort((a, b) => b.length - a.length);
  return {
    blobLines: items.length,
    blobChars: total,
    pct: len ? Math.round((total / len) * 100) : 0,
    items: items.slice(0, maxItems).sort((a, b) => a.line - b.line),
  };
}

module.exports = { foldLine, formatLines, blobMap, classify, DATA_URI_RE };
