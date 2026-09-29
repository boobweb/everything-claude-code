#!/usr/bin/env node
'use strict';
// Turbo "code" MCP server: indexed, bounded access to files and repos so Claude Code
// never has to read a 20MB file (or 400 files) to find one function.
//
// Zero dependencies: implements the MCP stdio transport (newline-delimited JSON-RPC 2.0)
// directly. Protocol: initialize -> notifications/initialized -> tools/list -> tools/call.

const fs = require('fs');
const path = require('path');
const url = require('url');
const { spawnSync } = require('child_process');
const fsx = require('../lib/fsx');
const lang = require('../lib/lang');
const fold = require('../lib/fold');
const check = require('../lib/check');
const stack = require('../lib/stack');
const git = require('../lib/git');

const SERVER_NAME = 'turbo-code';
const VERSION = (() => { try { return require('../.claude-plugin/plugin.json').version; } catch { return '0.0.0'; } })();
const SUPPORTED_PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const DEFAULT_MAX_CHARS = 12000;
const MAX_FILE_BYTES = 64 * 1024 * 1024;

const INSTRUCTIONS = [
  'Indexed, bounded access to files and repos: repo_map first in an unfamiliar project; for files over ~100KB or with embedded blobs use file_outline, then find_symbol or read_range on exact lines instead of reading the whole file.',
  'Paths may be relative to the project root; line numbers are 1-based and match Read/Edit.',
].join(' ');

// ---------------------------------------------------------------------------
// State
let roots = [];
let clientSupportsRoots = false;
const outlineCache = new Map(); // abs -> { mtimeMs, size, outline, text? }
let cacheBytes = 0;
const CACHE_LIMIT = 96 * 1024 * 1024;
let nextOutId = 1;

function projectRoot(explicit) {
  if (explicit) return fsx.normPath(explicit, process.cwd());
  if (process.env.CLAUDE_PROJECT_DIR && fsx.isDir(process.env.CLAUDE_PROJECT_DIR)) return path.resolve(process.env.CLAUDE_PROJECT_DIR);
  if (roots[0] && fsx.isDir(roots[0])) return roots[0];
  return fsx.findProjectRoot(process.cwd());
}

/** Directories this server may read: the session's roots (launch dir + added dirs), the project dir, the cwd. */
function allowedRoots() {
  const set = new Set();
  for (const r of roots) if (fsx.isDir(r)) set.add(path.resolve(r));
  if (process.env.CLAUDE_PROJECT_DIR && fsx.isDir(process.env.CLAUDE_PROJECT_DIR)) set.add(path.resolve(process.env.CLAUDE_PROJECT_DIR));
  if (!set.size) set.add(fsx.findProjectRoot(process.cwd()));
  return [...set];
}
/**
 * A path is inside the allowed roots only when both its lexical form and its real location (symlinks
 * resolved, macOS /tmp -> /private/tmp included) fall under a root: `src/link -> /etc` must not open /etc.
 */
function insideAllowed(abs) {
  const norm = (p) => (process.platform === 'win32' ? p.toLowerCase() : p).replace(/[\\/]+$/, '');
  const within = (p, r) => p === r || p.startsWith(r + path.sep);
  const lexical = norm(path.resolve(abs));
  let real;
  try { real = norm(fsx.realpathDeep(abs)); } catch { return false; }
  const roots = allowedRoots();
  const lexOk = roots.some((r) => within(lexical, norm(r)) || within(lexical, norm(fsx.realpathDeep(r))));
  const realOk = roots.some((r) => within(real, norm(fsx.realpathDeep(r))));
  return lexOk && realOk;
}
function assertInside(abs) {
  if (!insideAllowed(abs)) throw new Error(`Outside the project: ${fsx.toPosix(abs)}. Turbo tools read only inside the working directories (${allowedRoots().map(fsx.toPosix).join(', ')}); use the Read tool for other files.`);
  return abs;
}

function resolveFile(p, root) {
  if (!p) throw new Error('path is required');
  const abs = fsx.normPath(p, root);
  if (!fsx.isFile(abs)) {
    // Try relative to cwd and to each root as a fallback
    for (const base of [process.cwd(), ...roots]) {
      const alt = fsx.normPath(p, base);
      if (fsx.isFile(alt)) return assertInside(alt);
    }
    if (!insideAllowed(abs)) assertInside(abs);
    throw new Error(`File not found: ${fsx.toPosix(abs)}`);
  }
  return assertInside(abs);
}

function readFileText(abs) {
  const st = fsx.statSafe(abs);
  if (st.size > MAX_FILE_BYTES) throw new Error(`File too large to index (${fsx.humanSize(st.size)} > ${fsx.humanSize(MAX_FILE_BYTES)})`);
  const r = fsx.readText(abs);
  if (r.binary) throw new Error('Binary file');
  return { text: r.text, size: st.size, mtimeMs: st.mtimeMs };
}

function getOutline(abs, maxSymbols = 400) {
  const st = fsx.statSafe(abs);
  if (!st) throw new Error(`File not found: ${fsx.toPosix(abs)}`);
  const c = outlineCache.get(abs);
  if (c && c.mtimeMs === st.mtimeMs && c.size === st.size && c.maxSymbols >= maxSymbols) return c;
  const { text } = readFileText(abs);
  const o = lang.outline(text, abs, { maxSymbols });
  const lines = fsx.countLines(text);
  const entry = { mtimeMs: st.mtimeMs, size: st.size, maxSymbols, outline: o, lines, text };
  // keep the text only for files under 4MB to bound memory; bigger files are re-read on demand
  if (st.size > 4 * 1024 * 1024) delete entry.text;
  const prev = outlineCache.get(abs);
  if (prev) { cacheBytes -= prev.text ? prev.size : 0; outlineCache.delete(abs); }
  outlineCache.set(abs, entry);
  cacheBytes += entry.text ? st.size : 0;
  while ((cacheBytes > CACHE_LIMIT || outlineCache.size > 400) && outlineCache.size > 1) {
    const [k, v] = outlineCache.entries().next().value;
    outlineCache.delete(k);
    cacheBytes -= v.text ? v.size : 0;
  }
  return entry;
}

const MAX_CHARS_LIMIT = 200000; // no single tool result may exceed this, whatever max_chars says
function cap(text, maxChars) {
  const m = Math.min(MAX_CHARS_LIMIT, Math.max(500, Number(maxChars) || DEFAULT_MAX_CHARS));
  if (text.length <= m) return text;
  return text.slice(0, m) + `\n…[output truncated at ${m.toLocaleString('en-US')} chars; narrow the request (path, filter, line range)${m < MAX_CHARS_LIMIT ? ' or raise max_chars' : ''}]`;
}

/**
 * Reject patterns whose backtracking can be exponential: a quantified group that itself contains a
 * quantifier or an alternation ((a+)+, (a|aa)+, (a?){30}), or a quantified class followed by a quantifier.
 * Conservative on purpose: literal search and rg (the usual engine) are unaffected.
 */
function unsafeRegex(pattern) {
  const group = String.raw`\((?:[^()\\]|\\.)*(?:[+*?{]|\|)(?:[^()\\]|\\.)*\)`;
  return new RegExp(`${group}\\s*[+*?{]`).test(pattern) || /\[[^\]]*\][+*]\)?[+*{]/.test(pattern) || /\)\{\d+,?\d*\}[+*]/.test(pattern);
}

const CALLABLE = new Set(['function', 'method', 'constructor', 'getter', 'setter']);

/** Compact one-token form used by repo_map: name(params) for callables, "kind name sig" otherwise. */
function fmtSym(s, withLine = true) {
  const sig = CALLABLE.has(s.kind) ? `(${s.sig || ''})` : s.sig ? ` ${s.sig}` : '';
  const kind = ['function', 'method', 'id', 'key', 'value'].includes(s.kind) ? '' : `${s.kind} `;
  return `${withLine ? `L${s.line} ` : ''}${kind}${s.name}${sig}`;
}

/** Full form used by file_outline: "name(params) mods" or "name  sig", with "export" folded into mods. */
function fmtSymFull(s) {
  const mods = [s.exported ? 'export' : '', s.mods || ''].filter(Boolean).join(' ');
  if (CALLABLE.has(s.kind)) return `${s.name}(${s.sig || ''})${mods ? `  ${mods}` : ''}`;
  const tail = [s.sig || '', mods].filter(Boolean).join('  ');
  return `${s.name}${tail ? `  ${tail}` : ''}`;
}

/** "L12" or "L12-40" when the parser knows the exact end line. */
function lineRange(s) {
  return s.endLine && s.endLine > s.line ? `L${s.line}-${s.endLine}` : `L${s.line}`;
}

function parserLabel(o) {
  if (!o.parser || o.parser === 'heuristic') return 'heuristic (regex)';
  if (o.parser === 'acorn') return `acorn${o.sourceType ? `, ${o.sourceType}` : ''}`;
  return o.parser;
}

// ---------------------------------------------------------------------------
// Tools

const ENTRY_NAMES = /^(index|main|app|server|cli|start|bootstrap|entry|game|engine|core|package\.json|readme(\.md)?|claude\.md|makefile|dockerfile|pyproject\.toml|go\.mod|cargo\.toml|setup\.py|manage\.py|__init__\.py|__main__\.py)(\.|$)/i;
// repo_map shows a file's main symbols (functions, classes, data, boot code); scalar state and
// accessors belong in file_outline, not in the one-screen map.
const MAP_SKIP_KINDS = new Set(['state', 'const', 'getter', 'setter', 'static']);

function toolRepoMap(a) {
  const root = projectRoot(a.root);
  if (!fsx.isDir(root)) throw new Error(`Not a directory: ${fsx.toPosix(root)}`);
  assertInside(root);
  const maxFiles = Math.min(400, Math.max(5, Number(a.max_files) || 60));
  const withSymbols = a.symbols !== false;
  const filter = a.filter ? fsx.makeGlobMatcher(a.filter) : null;
  const substr = a.filter && !/[*?{}[\]]/.test(a.filter) ? String(a.filter).toLowerCase() : null;
  const w = fsx.walk(root, { maxEntries: 8000, timeBudgetMs: 3500, maxDepth: 14 });
  const files = w.files.filter((f) => {
    if (fsx.BINARY_EXT.has(f.ext) || fsx.LOCKFILES.has(f.name)) return false;
    if (/\.min\.(js|css)$|\.map$|\.d\.ts$/.test(f.name)) return false;
    if (filter && !(filter(f.rel) || (substr && f.rel.toLowerCase().includes(substr)))) return false;
    return true;
  });
  // ranking
  const scored = files.map((f) => {
    let s = 0;
    if (ENTRY_NAMES.test(f.name)) s += 40;
    s += Math.max(0, 30 - f.depth * 8);
    const isCode = lang.CODE_LANGS.has(lang.detectLang(f.name) || '');
    if (isCode) s += 15 + Math.min(25, Math.log2(1 + f.size / 1024) * 2.5);
    else if (/\.(md|json|ya?ml|toml)$/i.test(f.name)) s += 8;
    if (/test|spec|__tests__|fixture|mock/i.test(f.rel)) s -= 10;
    if (/\.(txt|log|csv)$/i.test(f.name)) s -= 15;
    return { f, s };
  }).sort((x, y) => y.s - x.s);
  const shown = scored.slice(0, maxFiles).map((x) => x.f).sort((x, y) => x.rel.localeCompare(y.rel));

  const st = stack.detect(root);
  const g = git.info(root, { maxFiles: 6, commits: 3 });
  const extCounts = new Map();
  for (const f of w.files) extCounts.set(f.ext || '(none)', (extCounts.get(f.ext || '(none)') || 0) + 1);
  const topExt = [...extCounts.entries()].sort((a2, b2) => b2[1] - a2[1]).slice(0, 8).map(([e, n]) => `${e}:${n}`).join(' ');

  const out = [];
  out.push(`# Repo map: ${fsx.toPosix(root)}`);
  out.push(`${w.files.length}${w.truncated ? '+' : ''} files scanned in ${w.elapsedMs}ms (ignoring node_modules, build output, VCS, binaries); showing ${shown.length}${files.length > shown.length ? ` of ${files.length} candidates (raise max_files or pass filter)` : ''}. Types: ${topExt}`);
  out.push(`Stack: ${st.summary}${st.commands.length ? ` | checks: ${st.commands.join(', ')}` : ''}${g ? ` | git ${g.branch || '?'}${g.total ? `, ${g.total} changed` : ', clean'}` : ''}`);
  out.push('');
  let bytesRead = 0;
  const maxChars = Number(a.max_chars) || DEFAULT_MAX_CHARS;
  const perFileSyms = shown.length > 40 ? 6 : shown.length > 20 ? 10 : 16;
  // one python process outlines every .py file shown (instead of one process per file)
  if (withSymbols) lang.primePython(shown.filter((f) => lang.detectLang(f.name) === 'python').map((f) => f.abs));
  for (let i = 0; i < shown.length; i++) {
    const f = shown[i];
    let line = `${f.rel} (${fsx.humanSize(f.size)}`;
    const l = lang.detectLang(f.name);
    const canOutline = withSymbols && l && l !== 'text' && f.size <= 32 * 1024 * 1024 && bytesRead + f.size < 160 * 1024 * 1024;
    if (canOutline) {
      try {
        const e = getOutline(f.abs, 300);
        bytesRead += f.size;
        line += `, ${e.lines.toLocaleString('en-US')} lines)`;
        const syms = e.outline.symbols || [];
        const blob = f.size > 300 * 1024 && e.text ? fold.blobMap(e.text, { threshold: 1000, maxItems: 1 }) : null;
        if (blob && blob.pct >= 10) line += ` [${blob.pct}% blobs in ${blob.blobLines} lines]`;
        if (l === 'html') {
          const scripts = syms.filter((s) => s.kind === 'script').length;
          const ids = syms.filter((s) => s.kind === 'id').length;
          const code = syms.filter((s) => !['script', 'style', 'id'].includes(s.kind) && !MAP_SKIP_KINDS.has(s.kind));
          line += `: ${scripts} script block${scripts === 1 ? '' : 's'}, ${ids} ids` + (code.length ? `; js: ${code.slice(0, perFileSyms).map((s) => fmtSym(s, false)).join(', ')}${code.length > perFileSyms ? ` … +${code.length - perFileSyms}` : ''}` : '');
        } else if (syms.length) {
          const main = syms.filter((s) => (!['key', 'value'].includes(s.kind) || l === 'json') && !MAP_SKIP_KINDS.has(s.kind));
          const pick = main.slice(0, perFileSyms);
          line += `: ${pick.map((s) => fmtSym(s, false)).join(', ')}${main.length > pick.length ? ` … +${main.length - pick.length}` : ''}`;
        }
      } catch (e) {
        line += `) [${e.message}]`;
      }
    } else {
      line += ')';
    }
    out.push(line);
    if (out.join('\n').length > maxChars) { out.push(`…(+${shown.length - i - 1} files not shown; raise max_chars or use filter)`); break; }
  }
  if (files.length > shown.length) {
    const dirs = new Map();
    for (const f of files) { const d = f.rel.includes('/') ? f.rel.slice(0, f.rel.lastIndexOf('/')) : '.'; dirs.set(d, (dirs.get(d) || 0) + 1); }
    const dl = [...dirs.entries()].sort((x, y) => y[1] - x[1]).slice(0, 15).map(([d, n]) => `${d} (${n})`).join(', ');
    out.push('', `Directories by file count: ${dl}`);
  }
  out.push('', 'Next: file_outline <path> for a full symbol list with line numbers; find_symbol <name> to jump to a definition; read_range for exact lines.');
  return cap(out.join('\n'), maxChars);
}

function toolFileOutline(a) {
  const root = projectRoot(a.root);
  const abs = resolveFile(a.path, root);
  const maxSymbols = Math.min(2000, Math.max(20, Number(a.max_symbols) || 400));
  const e = getOutline(abs, maxSymbols);
  const o = e.outline;
  const out = [];
  out.push(`# ${fsx.relDisplay(abs, root)}  (${o.lang}, ${e.lines.toLocaleString('en-US')} lines, ${fsx.humanSize(e.size)})`);
  const text = e.text || readFileText(abs).text;
  if (e.size > 100 * 1024) {
    const bm = fold.blobMap(text, { threshold: 1000, maxItems: 6 });
    if (bm.blobLines) out.push(`Blobs: ${bm.blobLines} line${bm.blobLines === 1 ? '' : 's'} over 1000 chars hold ${bm.pct}% of the file (${fsx.humanSize(bm.blobChars)}); largest: ${bm.items.slice(0, 6).map((b) => `L${b.line} ${fsx.humanSize(b.length)}${b.label ? ` ${b.label}` : ''} ${b.kind}`).join('; ')}. read_range folds these automatically.`);
  }
  const syms = o.symbols || [];
  if (!syms.length) {
    out.push('No symbols detected for this file type. Use read_range to view it, or search for a pattern.');
    return cap(out.join('\n'), a.max_chars);
  }
  const groups = new Map();
  for (const s of syms) groups.set(s.kind, (groups.get(s.kind) || 0) + 1);
  const exact = syms.some((s) => s.endLine);
  out.push(`Symbols: ${syms.length}${o.truncated ? '+ (truncated; raise max_symbols)' : ''} — ${[...groups.entries()].map(([k, n]) => `${k} ${n}`).join(', ')}${o.imports ? `; ${o.imports} import/require lines` : ''}; parser: ${parserLabel(o)}${exact ? ' (line ranges are exact)' : ''}`);
  out.push('');
  const idKind = a.include_ids === false ? new Set(['id']) : new Set();
  const rows = [];
  let idsShown = 0;
  for (const s of syms) {
    if (idKind.has(s.kind)) continue;
    if (s.kind === 'id') { idsShown++; if (idsShown > (a.include_ids ? 1000 : 60)) continue; }
    rows.push([lineRange(s), s.kind, fmtSymFull(s)]);
  }
  const width = rows.reduce((w, r) => Math.max(w, r[0].length), 2);
  for (const r of rows) out.push(`${r[0].padEnd(width)}  ${r[1].padEnd(11)} ${r[2]}`);
  if (idsShown > 60 && !a.include_ids) out.push(`…(${idsShown - 60} more element ids hidden; pass include_ids: true to list all)`);
  return cap(out.join('\n'), a.max_chars);
}

function toolReadRange(a) {
  const root = projectRoot(a.root);
  const abs = resolveFile(a.path, root);
  const { text, size } = readFileText(abs);
  const lines = text.split(/\r?\n/);
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop(); // trailing newline is not a line
  const total = lines.length;
  const maxLines = Math.min(2000, Math.max(1, Number(a.max_lines) || 400));
  let start = Math.max(1, Number(a.start_line) || 1);
  let end = Number(a.end_line) ? Number(a.end_line) : start + Math.min(maxLines, 200) - 1;
  if (end < start) end = start; // end_line below start_line (or negative) means "just that line"
  if (end - start + 1 > maxLines) end = start + maxLines - 1;
  if (start > total) throw new Error(`start_line ${start} is past the end of the file (${total} lines)`);
  end = Math.min(end, total);
  const slice = lines.slice(start - 1, end);
  // fold:false expands long lines, but a line over 64 KB (a base64 blob, minified bundle) is always folded
  const HARD_FOLD = 64 * 1024;
  const f = fold.formatLines(slice, start, { fold: true, over: a.fold === false ? HARD_FOLD : Math.min(HARD_FOLD, Number(a.fold_over) || 400), keep: 120 });
  const head = `# ${fsx.relDisplay(abs, root)} lines ${start}-${end} of ${total} (${fsx.humanSize(size)})${f.foldedCount ? `; ${f.foldedCount} long line${f.foldedCount === 1 ? '' : 's'} folded (${fsx.humanSize(f.foldedChars)}; ${a.fold === false ? 'lines over 64 KB are always folded; use read_range with start_line/end_line on a smaller span' : 'pass fold:false to expand'})` : ''}`;
  return cap(`${head}\n${f.text}${end < total ? `\n…(${total - end} more lines; continue with start_line: ${end + 1})` : ''}`, a.max_chars || Math.max(DEFAULT_MAX_CHARS, maxLines * 160));
}

function findInOutline(entry, name) {
  const syms = entry.outline.symbols || [];
  const lower = name.toLowerCase();
  const exact = syms.filter((s) => s.name === name || s.name === `#${name}`);
  if (exact.length) return exact;
  const suffix = syms.filter((s) => s.name.endsWith(`.${name}`) || s.name.toLowerCase() === lower);
  if (suffix.length) return suffix;
  return syms.filter((s) => s.name.toLowerCase().includes(lower));
}

function toolFindSymbol(a) {
  const root = projectRoot(a.root);
  const name = String(a.name || '').trim();
  if (!name) throw new Error('name is required');
  const maxResults = Math.min(20, Math.max(1, Number(a.max_results) || 5));
  const maxBody = Math.min(1500, Math.max(5, Number(a.max_body_lines) || 150));
  const target = a.path ? fsx.normPath(a.path, root) : root;
  assertInside(target);
  let files;
  if (fsx.isFile(target)) files = [{ abs: target, rel: fsx.relDisplay(target, root), size: fsx.statSafe(target).size, name: path.basename(target) }];
  else if (fsx.isDir(target)) {
    const w = fsx.walk(target, { maxEntries: 5000, timeBudgetMs: 3000 });
    files = w.files.filter((f) => lang.CODE_LANGS.has(lang.detectLang(f.name) || '') || /\.(md|json|ya?ml)$/i.test(f.name)).filter((f) => !fsx.LOCKFILES.has(f.name) && !/\.min\.(js|css)$/.test(f.name) && f.size <= MAX_FILE_BYTES);
    // cheap pre-filter: skip files that don't even contain the identifier text (bounded read)
    files = files.filter((f) => {
      if (f.size > 8 * 1024 * 1024) return true;
      try { return fs.readFileSync(f.abs, 'utf8').includes(name.replace(/^#/, '').split('.').pop()); } catch { return false; } // "#overlay" is stored as id="overlay"
    });
    if (files.length > 400) files = files.slice(0, 400);
  } else throw new Error(`Path not found: ${fsx.toPosix(target)}`);

  const hits = [];
  let bytes = 0;
  lang.primePython(files.filter((f) => lang.detectLang(f.name) === 'python').map((f) => f.abs));
  for (const f of files) {
    if (bytes > 200 * 1024 * 1024) break;
    let e;
    try { e = getOutline(f.abs, 1500); bytes += f.size; } catch { continue; }
    for (const s of findInOutline(e, name)) hits.push({ file: f.abs, rel: fsx.relDisplay(f.abs, root), sym: s, entry: e });
  }
  if (!hits.length) return `No symbol matching "${name}" found in ${files.length} file(s) under ${fsx.relDisplay(target, root) || '.'}. Try search with the text, or file_outline on the likely file.`;
  hits.sort((x, y) => (x.sym.name === name ? -1 : y.sym.name === name ? 1 : 0));
  const out = [`# find_symbol "${name}": ${hits.length} match${hits.length === 1 ? '' : 'es'}${hits.length > maxResults ? ` (showing ${maxResults} bodies)` : ''}`];
  for (const h of hits.slice(0, maxResults)) {
    const text = h.entry.text || readFileText(h.file).text;
    const lines = text.split(/\r?\n/);
    const l = h.entry.outline.lang;
    let end = h.sym.line;
    // exact end line from a real parser when available, else bracket/indent matching
    if (a.body !== false) end = h.sym.endLine && h.sym.endLine >= h.sym.line ? Math.min(h.sym.endLine, lines.length) : lang.symbolEnd(lines, h.sym.line, l === 'html' ? 'js' : l, Math.max(maxBody, 5000));
    const shownEnd = Math.min(end, h.sym.line + maxBody - 1);
    const f = fold.formatLines(lines.slice(h.sym.line - 1, shownEnd), h.sym.line, { over: 400, keep: 120 });
    out.push('', `## ${h.rel}:${h.sym.line}${end !== h.sym.line ? `-${end}` : ''}  ${h.sym.kind} ${fmtSymFull(h.sym)}${shownEnd < end ? `  [body truncated at ${maxBody} lines; use read_range ${shownEnd + 1}-${end}]` : ''}`);
    if (a.body !== false) out.push(f.text);
  }
  if (hits.length > maxResults) out.push('', `Other locations: ${hits.slice(maxResults, maxResults + 30).map((h) => `${h.rel}:${h.sym.line} (${h.sym.kind})`).join(', ')}`);
  return cap(out.join('\n'), a.max_chars);
}

let rgPath;
function findRg() {
  if (rgPath !== undefined) return rgPath;
  rgPath = null;
  for (const c of ['rg', 'rg.exe']) {
    try { const r = spawnSync(c, ['--version'], { encoding: 'utf8', timeout: 4000, windowsHide: true }); if (!r.error && r.status === 0) { rgPath = c; break; } } catch { /* next */ }
  }
  return rgPath;
}

function toolSearch(a) {
  const root = projectRoot(a.root);
  const pattern = String(a.pattern || '');
  if (!pattern) throw new Error('pattern is required');
  const target = a.path ? fsx.normPath(a.path, root) : root;
  assertInside(target);
  if (!fsx.exists(target)) throw new Error(`Path not found: ${fsx.toPosix(target)}`);
  const maxResults = Math.min(500, Math.max(1, Number(a.max_results) || 60));
  const context = Math.min(10, Math.max(0, Number(a.context) || 0));
  const isRegex = !!a.regex;
  const caseSensitive = !!a.case_sensitive;
  const maxLine = Math.min(2000, Math.max(80, Number(a.max_line_chars) || 240));
  const results = []; // {rel, line, text, ctx:boolean}
  let filesWithMatches = 0;
  let engine = 'js';
  const rg = findRg();
  if (rg) {
    engine = 'ripgrep';
    // let ripgrep hand us a generous slice of long lines; folding to max_line_chars happens below so output is consistent with the JS engine
    // --max-columns-preview keeps a truncated preview of very long lines instead of omitting them
    const args = ['--no-heading', '--line-number', '--null', '--color', 'never', '--no-messages', '--max-columns', '200000', '--max-columns-preview', '-m', String(maxResults)];
    if (!caseSensitive) args.push('-i');
    if (!isRegex) args.push('-F');
    if (context) args.push('-C', String(context));
    if (a.include) for (const g of fsx.expandBraces(String(a.include))) args.push('-g', g);
    if (a.exclude) for (const g of fsx.expandBraces(String(a.exclude))) args.push('-g', `!${g}`);
    args.push('-e', pattern, target);
    const r = spawnSync(rg, args, { encoding: 'utf8', timeout: 20000, windowsHide: true, maxBuffer: 96 * 1024 * 1024 });
    // exit 0 = matches, 1 = no matches, 2 = error. An error with no output (bad regex or glob, unreadable target) must not
    // be reported as "0 matches"; an error with output (an unreadable file among many) still yields the matches it found.
    if (r.error) { engine = 'js'; }
    else if (r.status !== 0 && r.status !== 1 && !(r.stdout || '').trim()) {
      const msg = ((r.stderr || '').split('\n').map((l) => l.trim()).find(Boolean) || `ripgrep exited with status ${r.status}`).replace(/^rg:\s*/, '');
      throw new Error(`search failed: ${msg}`);
    } else {
      const seen = new Set();
      const singleFile = fsx.isFile(target);
      for (const line of (r.stdout || '').split('\n')) {
        if (!line) continue;
        // with --null: "<path>\0<line>:<text>" (or "<line>-<text>" for context lines); a single-file search omits the path
        let file, rest;
        const z = line.indexOf('\0');
        if (z >= 0) { file = line.slice(0, z); rest = line.slice(z + 1); } else if (singleFile) { file = target; rest = line; } else continue;
        const m = /^(\d+)([:-])(.*)$/.exec(rest);
        if (!m) continue;
        const rel = fsx.relDisplay(file, root);
        if (!seen.has(rel)) { seen.add(rel); filesWithMatches++; }
        results.push({ rel, line: Number(m[1]), text: m[3], ctx: m[2] === '-' });
        if (results.length >= maxResults * (context ? 2 * context + 1 : 1) + 5) break;
      }
    }
  }
  if (engine === 'js') {
    if (isRegex && unsafeRegex(pattern)) throw new Error('This regex has a quantified group containing a quantifier or an alternation (nested quantifiers can hang the search engine); simplify it or search for a literal string.');
    const re = isRegex ? new RegExp(pattern, caseSensitive ? '' : 'i') : null;
    const needle = caseSensitive ? pattern : pattern.toLowerCase();
    const inc = a.include ? fsx.makeGlobMatcher(a.include) : null;
    const exc = a.exclude ? fsx.makeGlobMatcher(a.exclude) : null;
    const files = fsx.isFile(target) ? [{ abs: target, rel: fsx.relDisplay(target, root), size: fsx.statSafe(target).size, ext: path.extname(target).toLowerCase(), name: path.basename(target) }]
      : fsx.walk(target, { maxEntries: 8000, timeBudgetMs: 4000 }).files;
    let bytes = 0;
    outer: for (const f of files) {
      if (fsx.BINARY_EXT.has(f.ext) || f.size > MAX_FILE_BYTES) continue;
      if (inc && !inc(f.rel)) continue;
      if (exc && exc(f.rel)) continue;
      if (bytes > 300 * 1024 * 1024) break;
      let text;
      try { const r = fsx.readText(f.abs); if (r.binary) continue; text = r.text; bytes += f.size; } catch { continue; }
      const lines = text.split(/\r?\n/);
      let matchedHere = false;
      for (let i = 0; i < lines.length; i++) {
        const l = lines[i];
        const hit = re ? re.test(l) : (caseSensitive ? l : l.toLowerCase()).includes(needle);
        if (!hit) continue;
        if (!matchedHere) { matchedHere = true; filesWithMatches++; }
        const rel = fsx.relDisplay(f.abs, root);
        for (let c = Math.max(0, i - context); c < i; c++) results.push({ rel, line: c + 1, text: lines[c], ctx: true });
        results.push({ rel, line: i + 1, text: l, ctx: false });
        for (let c = i + 1; c <= Math.min(lines.length - 1, i + context); c++) results.push({ rel, line: c + 1, text: lines[c], ctx: true });
        if (results.filter((x) => !x.ctx).length >= maxResults) break outer;
      }
    }
  }
  const matches = results.filter((x) => !x.ctx).length;
  const out = [`# search ${isRegex ? '/' + pattern + '/' : JSON.stringify(pattern)} in ${fsx.relDisplay(target, root) || '.'} — ${matches} match${matches === 1 ? '' : 'es'} in ${filesWithMatches} file${filesWithMatches === 1 ? '' : 's'} (${engine}${caseSensitive ? '' : ', case-insensitive'}${matches >= maxResults ? `, capped at ${maxResults}` : ''})`];
  let lastRel = null;
  for (const r of results) {
    if (r.rel !== lastRel) { out.push('', `## ${r.rel}`); lastRel = r.rel; }
    const f = fold.foldLine(r.text, { over: maxLine, keep: Math.min(160, maxLine - 60) });
    out.push(`${String(r.line).padStart(6)}${r.ctx ? '-' : ':'} ${f.text}`);
  }
  if (!results.length) out.push('(no matches)');
  return cap(out.join('\n'), a.max_chars);
}

function toolSyntaxCheck(a) {
  const root = projectRoot(a.root);
  const paths = Array.isArray(a.paths) ? a.paths : a.path ? [a.path] : [];
  if (!paths.length) throw new Error('path (or paths) is required');
  const out = [];
  let failures = 0;
  for (const p of paths.slice(0, 50)) {
    const abs = resolveFile(p, root);
    const res = check.checkFile(abs, { root });
    if (!res.ok) failures++;
    out.push(check.formatResult(res, root));
  }
  out.unshift(`# syntax_check: ${paths.length} file${paths.length === 1 ? '' : 's'}, ${failures} failing`);
  return cap(out.join('\n'), a.max_chars);
}

function toolFileStats(a) {
  const root = projectRoot(a.root);
  const abs = resolveFile(a.path, root);
  const st = fsx.statSafe(abs);
  const r = fsx.readText(abs, 64 * 1024 * 1024);
  if (r.binary) return `# ${fsx.relDisplay(abs, root)}: binary file, ${fsx.humanSize(st.size)}`;
  const text = r.text;
  const lines = text.split(/\r?\n/);
  let longest = 0, longestLine = 0, trailingWs = 0;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (l.length > longest) { longest = l.length; longestLine = i + 1; }
    if (/[ \t]+$/.test(l) && l.trim()) trailingWs++;
  }
  const crlf = (text.match(/\r\n/g) || []).length;
  const lf = (text.match(/\n/g) || []).length - crlf;
  const bom = text.charCodeAt(0) === 0xfeff;
  const bm = fold.blobMap(text, { threshold: 1000, maxItems: 15 });
  const out = [`# ${fsx.relDisplay(abs, root)}`];
  out.push(`size ${fsx.humanSize(st.size)} (${st.size.toLocaleString('en-US')} bytes), ${lines.length.toLocaleString('en-US')} lines, avg ${Math.round(text.length / Math.max(1, lines.length))} chars/line, longest line ${longest.toLocaleString('en-US')} chars at L${longestLine}`);
  out.push(`line endings: ${crlf && lf ? `MIXED (${crlf} CRLF, ${lf} LF)` : crlf ? 'CRLF' : 'LF'}${bom ? ', UTF-8 BOM present' : ''}${trailingWs ? `, ${trailingWs} lines with trailing whitespace` : ''}, modified ${new Date(st.mtimeMs).toISOString()}`);
  if (bm.blobLines) {
    out.push(`blobs: ${bm.blobLines} lines over 1000 chars = ${bm.pct}% of the file (${fsx.humanSize(bm.blobChars)}); the other ${100 - bm.pct}% (${fsx.humanSize(text.length - bm.blobChars)}) is real code/markup.`);
    for (const b of bm.items) out.push(`  L${b.line}: ${fsx.humanSize(b.length)} ${b.kind}${b.label ? ` — ${b.label}` : ''}`);
  } else out.push('blobs: none (no lines over 1000 chars)');
  const l = lang.detectLang(abs);
  if (l === 'html') {
    const blocks = lang.scriptBlocks(text);
    out.push(`script blocks: ${blocks.length}` + (blocks.length ? ` — ${blocks.map((b) => `#${b.index} L${b.startLine}-${b.endLine} ${b.src ? `src=${b.src}` : `${fsx.humanSize(b.length)}${b.isModule ? ' module' : ''}${b.type && !b.isJS ? ` type=${b.type}` : ''}`}`).join('; ')}` : ''));
    const styles = (text.match(/<style\b/gi) || []).length;
    out.push(`style blocks: ${styles}; external <link rel=stylesheet>: ${(text.match(/<link\b[^>]*rel=["']?stylesheet/gi) || []).length}; <img>: ${(text.match(/<img\b/gi) || []).length}; data: URIs: ${(text.match(/data:[\w/+.-]+;base64,/gi) || []).length}`);
  }
  if (l) {
    try { const e = getOutline(abs, 400); out.push(`symbols: ${e.outline.symbols.length}${e.outline.truncated ? '+' : ''} (file_outline lists them)`); } catch { /* ignore */ }
  }
  return cap(out.join('\n'), a.max_chars);
}

// Tool descriptions are loaded into every session's context: one sentence each, defaults in the
// parameter descriptions only where the model must know them.
const TOOLS = [
  {
    name: 'repo_map',
    description: 'One-screen map of a project: ranked files with size, lines and main symbols. Use first in an unfamiliar repo.',
    inputSchema: { type: 'object', properties: {
      root: { type: 'string', description: 'Project directory (default: project root)' },
      filter: { type: 'string', description: 'Glob or substring, e.g. "src/**", "*.py"' },
      max_files: { type: 'integer', description: 'Default 60, max 400' },
      symbols: { type: 'boolean', description: 'Default true' },
      max_chars: { type: 'integer', description: 'Default 12000' },
    } },
    annotations: { readOnlyHint: true, title: 'Repo map' },
  },
  {
    name: 'file_outline',
    description: 'Symbols of one file with exact line ranges (functions, classes, methods, data, script/style blocks and ids in HTML, headings, keys) plus where embedded blobs live. Use before reading a large file.',
    inputSchema: { type: 'object', properties: {
      path: { type: 'string' },
      max_symbols: { type: 'integer', description: 'Default 400' },
      include_ids: { type: 'boolean', description: 'HTML: all element ids (default first 60)' },
      root: { type: 'string' }, max_chars: { type: 'integer' },
    }, required: ['path'] },
    annotations: { readOnlyHint: true, title: 'File outline' },
  },
  {
    name: 'read_range',
    description: 'Numbered lines of a file; long lines (base64, minified) are folded. Line numbers match Read/Edit.',
    inputSchema: { type: 'object', properties: {
      path: { type: 'string' },
      start_line: { type: 'integer', description: '1-based (default 1)' },
      end_line: { type: 'integer', description: 'Inclusive (default start+199)' },
      max_lines: { type: 'integer', description: 'Default 400, max 2000' },
      fold: { type: 'boolean', description: 'Default true' },
      fold_over: { type: 'integer', description: 'Fold lines longer than this (default 400)' },
      root: { type: 'string' }, max_chars: { type: 'integer' },
    }, required: ['path'] },
    annotations: { readOnlyHint: true, title: 'Read range' },
  },
  {
    name: 'find_symbol',
    description: 'Body of a function, class, method (Class.method), data array or heading by name, with line numbers, from one file, a directory or the whole project.',
    inputSchema: { type: 'object', properties: {
      name: { type: 'string', description: 'e.g. "render", "Store.save", "QUESTIONS", "#overlay"' },
      path: { type: 'string', description: 'File or directory (default: project root)' },
      body: { type: 'boolean', description: 'Default true' },
      max_body_lines: { type: 'integer', description: 'Default 150' },
      max_results: { type: 'integer', description: 'Default 5' },
      root: { type: 'string' }, max_chars: { type: 'integer' },
    }, required: ['name'] },
    annotations: { readOnlyHint: true, title: 'Find symbol' },
  },
  {
    name: 'search',
    description: 'Literal or regex search over the project or a path (ripgrep when available, .gitignore respected, long lines folded). Returns file:line groups.',
    inputSchema: { type: 'object', properties: {
      pattern: { type: 'string' },
      path: { type: 'string', description: 'File or directory (default: project root)' },
      regex: { type: 'boolean', description: 'Default false (literal)' },
      case_sensitive: { type: 'boolean', description: 'Default false' },
      context: { type: 'integer', description: 'Lines around each match (default 0)' },
      include: { type: 'string', description: 'Glob, e.g. "*.js"' },
      exclude: { type: 'string', description: 'Glob' },
      max_results: { type: 'integer', description: 'Default 60' },
      max_line_chars: { type: 'integer', description: 'Default 240' },
      root: { type: 'string' }, max_chars: { type: 'integer' },
    }, required: ['pattern'] },
    annotations: { readOnlyHint: true, title: 'Search' },
  },
  {
    name: 'syntax_check',
    description: 'Syntax check of JS (acorn), HTML inline scripts, JSON, Python, CSS, PowerShell, shell, TypeScript (when installed), YAML and XML. Returns file:line:col messages.',
    inputSchema: { type: 'object', properties: {
      path: { type: 'string' },
      paths: { type: 'array', items: { type: 'string' }, description: 'Several files' },
      root: { type: 'string' }, max_chars: { type: 'integer' },
    } },
    annotations: { readOnlyHint: true, title: 'Syntax check' },
  },
  {
    name: 'file_stats',
    description: 'Where the bytes are in a file: size, lines, longest line, blob lines and their owners, script/style map (HTML), line endings, BOM.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' }, root: { type: 'string' }, max_chars: { type: 'integer' } }, required: ['path'] },
    annotations: { readOnlyHint: true, title: 'File stats' },
  },
];

const HANDLERS = { repo_map: toolRepoMap, file_outline: toolFileOutline, read_range: toolReadRange, find_symbol: toolFindSymbol, search: toolSearch, syntax_check: toolSyntaxCheck, file_stats: toolFileStats };

// ---------------------------------------------------------------------------
// JSON-RPC plumbing

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}
function reply(id, result) { send({ jsonrpc: '2.0', id, result }); }
function replyError(id, code, message, data) { send({ jsonrpc: '2.0', id, error: { code, message, ...(data !== undefined ? { data } : {}) } }); }
function request(method, params) { const id = `turbo-${nextOutId++}`; send({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) }); return id; }

const pendingOut = new Map();

function handleRootsResult(result) {
  try {
    const list = (result && result.roots) || [];
    roots = list.map((r) => { try { return r.uri && r.uri.startsWith('file:') ? url.fileURLToPath(r.uri) : r.uri; } catch { return null; } }).filter(Boolean);
  } catch { /* ignore */ }
}

function handle(msg) {
  if (msg == null || typeof msg !== 'object') return;
  // Response to one of our own requests
  if (msg.id !== undefined && msg.method === undefined && pendingOut.has(msg.id)) {
    const cb = pendingOut.get(msg.id); pendingOut.delete(msg.id);
    if (msg.result !== undefined) cb(msg.result);
    return;
  }
  const { id, method } = msg;
  const params = msg.params && typeof msg.params === 'object' ? msg.params : {};
  const isNotification = id === undefined || id === null;
  try {
    switch (method) {
      case 'initialize': {
        const requested = params.protocolVersion;
        const protocolVersion = SUPPORTED_PROTOCOLS.includes(requested) ? requested : SUPPORTED_PROTOCOLS[0];
        clientSupportsRoots = !!(params.capabilities && params.capabilities.roots);
        reply(id, { protocolVersion, capabilities: { tools: { listChanged: false } }, serverInfo: { name: SERVER_NAME, version: VERSION }, instructions: INSTRUCTIONS });
        return;
      }
      case 'notifications/initialized':
        if (clientSupportsRoots) { const rid = request('roots/list'); pendingOut.set(rid, handleRootsResult); }
        return;
      case 'notifications/roots/list_changed':
        if (clientSupportsRoots) { const rid = request('roots/list'); pendingOut.set(rid, handleRootsResult); }
        return;
      case 'notifications/cancelled':
      case 'notifications/progress':
        return;
      case 'ping':
        if (!isNotification) reply(id, {});
        return;
      case 'tools/list':
        if (!isNotification) reply(id, { tools: TOOLS });
        return;
      case 'tools/call': {
        if (isNotification) return;
        const name = params.name;
        const fn = HANDLERS[name];
        if (!fn) { replyError(id, -32602, `Unknown tool: ${name}`); return; }
        const t0 = Date.now();
        try {
          const text = fn(params.arguments || {});
          reply(id, { content: [{ type: 'text', text: String(text) }], isError: false });
          if (process.env.TURBO_DEBUG) process.stderr.write(`[turbo-code] ${name} ${Date.now() - t0}ms\n`);
        } catch (e) {
          reply(id, { content: [{ type: 'text', text: `${name} failed: ${e && e.message || e}` }], isError: true });
        }
        return;
      }
      case 'resources/list': if (!isNotification) reply(id, { resources: [] }); return;
      case 'resources/templates/list': if (!isNotification) reply(id, { resourceTemplates: [] }); return;
      case 'prompts/list': if (!isNotification) reply(id, { prompts: [] }); return;
      case 'logging/setLevel': if (!isNotification) reply(id, {}); return;
      default:
        if (!isNotification) replyError(id, -32601, `Method not found: ${method}`);
    }
  } catch (e) {
    if (!isNotification) replyError(id, -32603, `Internal error: ${e && e.message || e}`);
  }
}

function serve() {
  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { replyError(null, -32700, 'Parse error'); continue; }
      if (Array.isArray(msg)) msg.forEach(handle); else handle(msg);
    }
  });
  process.stdin.on('end', () => process.exit(0));
  process.stdin.on('error', () => process.exit(0));
  process.stdout.on('error', () => process.exit(0));
}

if (require.main === module) {
  if (process.argv.includes('--selftest')) {
    const sample = 'function a(x){return x}\nclass B {\n  m() {\n    return 1;\n  }\n}\nconst Q = [\n {q:1}\n];\n';
    const o = lang.outline(sample, 'x.js');
    const ok = o.symbols.some((s) => s.name === 'a') && o.symbols.some((s) => s.name === 'B.m') && o.symbols.some((s) => s.name === 'Q');
    process.stdout.write(`turbo-code selftest ${ok ? 'OK' : 'FAILED'} (node ${process.version}, ${TOOLS.length} tools, rg ${findRg() ? 'found' : 'not found (JS fallback)'}, python ${check.pythonCmd() ? 'found' : 'not found'})\n`);
    process.exit(ok ? 0 : 1);
  }
  serve();
}

module.exports = { TOOLS, HANDLERS, handle, insideAllowed, unsafeRegex, cap };
