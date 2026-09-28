#!/usr/bin/env node
'use strict';
// Turbo tidy: find what is cluttering a folder or a whole drive and, only on request, move it out
// of the way. Zero dependencies. Never deletes: --apply moves items into a quarantine folder with
// a manifest, and --undo puts every one of them back.
//
//   node tidy.js <root> [<root>...]                report only (default)
//   node tidy.js <root> --json                     machine-readable report
//   node tidy.js <root> --apply [--only cats]      quarantine the findings (duplicates,empty,junk,ai by default)
//   node tidy.js --undo <quarantine dir>           restore everything listed in that manifest
//
// Categories:
//   duplicates  byte-identical files (size, then head hash, then full hash); one copy is kept
//   empty       zero-byte files and directories with nothing in them
//   junk        Thumbs.db, .DS_Store, desktop.ini, Office lock files (~$x.docx), stale *.tmp/*.part/*.crdownload
//   ai          Claude Code leftovers: transcripts of projects that no longer exist, old CLI logs, stale plugin data
//   heavy       node_modules, virtualenvs, build caches untouched for a long time (report only, regenerable)
//   archives    an archive next to a folder of the same name (report only: probably already extracted)
//
// Options: --min-size <bytes> (duplicates, default 1024)  --older-than <days> (junk/ai/heavy age, default 30)
//          --exclude <glob> (repeatable)  --max-files <n> (default 400000)  --limit <n> (items listed per category)
//          --claude-dir <dir> (default ~/.claude)  --include-heavy (also quarantine heavy items with --apply)
//          --all (do not skip system folders)  --quiet

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

// ---------------------------------------------------------------------------
// arguments
function parseArgs(argv) {
  const a = { roots: [], exclude: [], minSize: 1024, olderThan: 30, maxFiles: 400000, limit: 25, only: null };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const next = () => argv[++i];
    switch (k) {
      case '--apply': a.apply = true; break;
      case '--undo': a.undo = next(); break;
      case '--json': a.json = true; break;
      case '--quiet': a.quiet = true; break;
      case '--all': a.all = true; break;
      case '--include-heavy': a.includeHeavy = true; break;
      case '--only': a.only = String(next()).split(',').map((s) => s.trim()).filter(Boolean); break;
      case '--min-size': a.minSize = Number(next()); break;
      case '--older-than': a.olderThan = Number(next()); break;
      case '--max-files': a.maxFiles = Number(next()); break;
      case '--limit': a.limit = Number(next()); break;
      case '--exclude': a.exclude.push(next()); break;
      case '--claude-dir': a.claudeDir = next(); break;
      case '--quarantine': a.quarantine = next(); break;
      case '-h': case '--help': a.help = true; break;
      default:
        if (k.startsWith('-')) { console.error(`Unknown option: ${k}`); process.exit(2); }
        a.roots.push(k);
    }
  }
  return a;
}

// ---------------------------------------------------------------------------
// what to skip
const SKIP_DIR_NAMES = new Set(['.git', '.hg', '.svn', '$RECYCLE.BIN', 'System Volume Information', '$Recycle.Bin', 'Recovery', 'Config.Msi', '.Trash', '.Trashes', '.Spotlight-V100', '.fseventsd', 'lost+found', 'proc', 'sys', 'dev', '_turbo-quarantine']);
const SYSTEM_DIR_RE = /^(Windows|Program Files|Program Files \(x86\)|ProgramData|PerfLogs|Library|System|private|usr|bin|sbin|lib|lib64|etc|var|boot|opt|snap|run)$/i;
const HEAVY_DIR_RE = /^(node_modules|\.venv|venv|__pycache__|\.pytest_cache|\.mypy_cache|\.ruff_cache|\.tox|\.gradle|\.nuxt|\.next|\.turbo|\.parcel-cache|\.cache|target|Pods|DerivedData|bower_components|\.pnpm-store)$/;
const JUNK_NAME_RE = /^(Thumbs\.db|ehthumbs\.db|\.DS_Store|desktop\.ini|\._.*)$/i;
const OFFICE_LOCK_RE = /^~\$.+\.(docx?|xlsx?|pptx?|dotx?|xlsm|pptm)$/i;
const STALE_TEMP_RE = /\.(tmp|temp|part|crdownload|download|partial|swp|swo)$/i;
const ARCHIVE_RE = /\.(zip|7z|rar|tar|tgz|tar\.gz|tar\.bz2|tar\.xz)$/i;
const COPY_NAME_RE = /( - Copy(\s*\(\d+\))?| copy(\s*\d+)?|\s*\(\d+\))(\.[^.]+)?$/i;

function globToRe(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') { if (glob[i + 1] === '*') { re += '.*'; i++; if (glob[i + 1] === '/') i++; } else re += '[^/\\\\]*'; }
    else if (c === '?') re += '[^/\\\\]';
    else if ('.+^${}()|[]\\'.includes(c)) re += '\\' + c;
    else re += c;
  }
  return new RegExp(`(^|[\\\\/])${re}$`, 'i');
}

// ---------------------------------------------------------------------------
// scanning
function scan(roots, opts, log) {
  const files = [];          // { abs, size, mtimeMs, name, root }
  const emptyDirs = [];      // abs
  const heavy = [];          // { abs, size, files, mtimeMs }
  const excludes = opts.exclude.map(globToRe);
  const t0 = Date.now();
  let visitedDirs = 0, truncated = false, lastReport = 0;
  const now = Date.now();

  function walk(dir, root, depth) {
    if (files.length >= opts.maxFiles) { truncated = true; return { empty: false, size: 0, count: 0, newest: 0 }; }
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return { empty: false, size: 0, count: 0, newest: 0 }; }
    visitedDirs++;
    if (!opts.quiet && Date.now() - lastReport > 2000) { lastReport = Date.now(); log(`  scanning… ${files.length.toLocaleString('en-US')} files, ${visitedDirs.toLocaleString('en-US')} folders, ${Math.round((Date.now() - t0) / 1000)}s`); }
    let size = 0, count = 0, newest = 0, hasAnything = false;
    for (const e of entries) {
      const abs = path.join(dir, e.name);
      if (excludes.some((re) => re.test(abs))) { hasAnything = true; continue; }
      if (e.isSymbolicLink()) { hasAnything = true; continue; }
      if (e.isDirectory()) {
        // skipped, system and heavy folders count as content; a folder holding only empty folders is itself empty
        if (SKIP_DIR_NAMES.has(e.name)) { hasAnything = true; continue; }
        if (!opts.all && depth <= 1 && SYSTEM_DIR_RE.test(e.name)) { hasAnything = true; continue; }
        if (HEAVY_DIR_RE.test(e.name)) {
          hasAnything = true;
          const h = measure(abs);
          heavy.push({ abs, size: h.size, files: h.count, mtimeMs: h.newest });
          continue; // never index inside: full of legitimate duplicates and not user data
        }
        const sub = walk(abs, root, depth + 1);
        if (sub.empty) emptyDirs.push(abs); else hasAnything = true;
        size += sub.size; count += sub.count; newest = Math.max(newest, sub.newest);
        continue;
      }
      if (!e.isFile()) { hasAnything = true; continue; }
      let st;
      try { st = fs.statSync(abs); } catch { continue; }
      hasAnything = true;
      files.push({ abs, size: st.size, mtimeMs: st.mtimeMs, name: e.name, root });
      size += st.size; count++; newest = Math.max(newest, st.mtimeMs);
      if (files.length >= opts.maxFiles) { truncated = true; break; }
    }
    return { empty: !hasAnything, size, count, newest };
  }

  function measure(dir, budget = { n: 0 }) {
    let size = 0, count = 0, newest = 0;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return { size, count, newest }; }
    for (const e of entries) {
      if (budget.n++ > 200000) break;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) { const s = measure(abs, budget); size += s.size; count += s.count; newest = Math.max(newest, s.newest); }
      else if (e.isFile()) { try { const st = fs.statSync(abs); size += st.size; count++; newest = Math.max(newest, st.mtimeMs); } catch { /* ignore */ } }
    }
    return { size, count, newest };
  }

  for (const root of roots) {
    const r = walk(root, root, 0);
    if (r.empty) emptyDirs.push(root);
  }
  void now;
  return { files, emptyDirs, heavy, truncated, visitedDirs, elapsedMs: Date.now() - t0 };
}

// ---------------------------------------------------------------------------
// duplicates: size -> head hash -> full hash
function hashPart(abs, bytes) {
  const fd = fs.openSync(abs, 'r');
  try {
    const buf = Buffer.alloc(bytes);
    const n = fs.readSync(fd, buf, 0, bytes, 0);
    return crypto.createHash('sha256').update(buf.subarray(0, n)).digest('hex');
  } finally { fs.closeSync(fd); }
}

function hashFull(abs) {
  const h = crypto.createHash('sha256');
  const fd = fs.openSync(abs, 'r');
  try {
    const buf = Buffer.alloc(1 << 20);
    let n;
    while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) h.update(buf.subarray(0, n));
    return h.digest('hex');
  } finally { fs.closeSync(fd); }
}

function keepScore(f) {
  // lower is better: an original is not named like a copy, sits in a shorter path, is older
  let s = 0;
  if (COPY_NAME_RE.test(f.name)) s += 100;
  if (/[\\/](Downloads|Desktop|tmp|temp)[\\/]/i.test(f.abs)) s += 10;
  s += f.abs.split(/[\\/]/).length;
  s += f.mtimeMs / 1e15; // tie-break: older first
  return s;
}

function findDuplicates(files, opts, log) {
  const bySize = new Map();
  for (const f of files) if (f.size >= opts.minSize) { const g = bySize.get(f.size); if (g) g.push(f); else bySize.set(f.size, [f]); }
  const groups = [];
  let hashed = 0, hashedBytes = 0;
  for (const [, g] of bySize) {
    if (g.length < 2) continue;
    const byHead = new Map();
    for (const f of g) {
      let h; try { h = hashPart(f.abs, 64 * 1024); } catch { continue; }
      const l = byHead.get(h); if (l) l.push(f); else byHead.set(h, [f]);
    }
    for (const [, hg] of byHead) {
      if (hg.length < 2) continue;
      const byFull = new Map();
      for (const f of hg) {
        let h;
        try { h = f.size <= 64 * 1024 ? 'head' : hashFull(f.abs); hashed++; hashedBytes += f.size; } catch { continue; }
        const l = byFull.get(h); if (l) l.push(f); else byFull.set(h, [f]);
      }
      for (const [, fg] of byFull) {
        if (fg.length < 2) continue;
        fg.sort((a, b) => keepScore(a) - keepScore(b));
        groups.push({ size: fg[0].size, keep: fg[0].abs, extra: fg.slice(1).map((f) => f.abs), reclaim: fg[0].size * (fg.length - 1) });
      }
    }
  }
  groups.sort((a, b) => b.reclaim - a.reclaim);
  if (!opts.quiet) log(`  hashed ${hashed.toLocaleString('en-US')} candidate files (${human(hashedBytes)})`);
  return groups;
}

// ---------------------------------------------------------------------------
// junk, archives, AI leftovers
function findJunk(files, opts) {
  const cutoff = Date.now() - opts.olderThan * 86400000;
  const out = [];
  for (const f of files) {
    if (JUNK_NAME_RE.test(f.name)) out.push({ abs: f.abs, size: f.size, why: 'system thumbnail/metadata file' });
    else if (OFFICE_LOCK_RE.test(f.name)) out.push({ abs: f.abs, size: f.size, why: 'Office lock file left behind' });
    else if (STALE_TEMP_RE.test(f.name) && f.mtimeMs < cutoff) out.push({ abs: f.abs, size: f.size, why: `temporary/partial download older than ${opts.olderThan} days` });
  }
  return out.sort((a, b) => b.size - a.size);
}

function findArchives(files) {
  const dirs = new Set();
  for (const f of files) dirs.add(path.dirname(f.abs));
  const out = [];
  for (const f of files) {
    if (!ARCHIVE_RE.test(f.name)) continue;
    const base = f.name.replace(ARCHIVE_RE, '');
    const sibling = path.join(path.dirname(f.abs), base);
    let st; try { st = fs.statSync(sibling); } catch { continue; }
    if (st.isDirectory()) out.push({ abs: f.abs, size: f.size, folder: sibling });
  }
  void dirs;
  return out.sort((a, b) => b.size - a.size);
}

function findAiLeftovers(opts, roots) {
  const claudeDir = opts.claudeDir ? path.resolve(opts.claudeDir) : path.join(os.homedir(), '.claude');
  const out = [];
  const cutoff = Date.now() - opts.olderThan * 86400000;
  const dirSize = (d) => { let s = 0; try { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isFile()) s += fs.statSync(p).size; else if (e.isDirectory()) s += dirSize(p); } } catch { /* ignore */ } return s; };
  // transcripts of projects whose directory no longer exists: ~/.claude/projects/<slug>/*.jsonl. The slug
  // encodes the path lossily (separators and hyphens both become '-'), so the project path is taken only
  // from the "cwd" field the transcripts record; a folder whose transcripts name no cwd is left alone.
  const projects = path.join(claudeDir, 'projects');
  try {
    for (const e of fs.readdirSync(projects, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const dir = path.join(projects, e.name);
      const cwd = transcriptCwd(dir);
      if (cwd && !fs.existsSync(cwd)) out.push({ abs: dir, size: dirSize(dir), why: `session transcripts of a project folder that no longer exists (${cwd})` });
    }
  } catch { /* no projects dir */ }
  // old CLI logs and caches
  for (const rel of [['.cache', 'claude-cli-nodejs'], ['debug'], ['shell-snapshots'], ['todos'], ['statsig'], ['file-history']]) {
    const d = path.join(rel[0] === '.cache' ? os.homedir() : claudeDir, ...rel);
    let st; try { st = fs.statSync(d); } catch { continue; }
    if (!st.isDirectory()) continue;
    let old = 0, oldBytes = 0;
    try { for (const f of fs.readdirSync(d)) { const p = path.join(d, f); try { const s = fs.statSync(p); if (s.isFile() && s.mtimeMs < cutoff) { old++; oldBytes += s.size; } } catch { /* ignore */ } } } catch { /* ignore */ }
    if (old) out.push({ abs: d, size: oldBytes, why: `${old} log/cache files older than ${opts.olderThan} days`, filesOnly: true, cutoff });
  }
  // duplicate skills: same-named skill folders with identical content under skills/ and plugins
  const skillDirs = [];
  for (const base of [path.join(claudeDir, 'skills'), path.join(claudeDir, 'plugins')]) {
    try { walkSkills(base, skillDirs, 0); } catch { /* ignore */ }
  }
  const byName = new Map();
  for (const d of skillDirs) { const l = byName.get(path.basename(d)); if (l) l.push(d); else byName.set(path.basename(d), [d]); }
  for (const [name, dirs] of byName) {
    if (dirs.length < 2) continue;
    const sigs = new Map();
    for (const d of dirs) { const sig = dirSignature(d); const l = sigs.get(sig); if (l) l.push(d); else sigs.set(sig, [d]); }
    for (const [, same] of sigs) if (same.length > 1) out.push({ abs: same[1], size: dirSize(same[1]), why: `skill "${name}" is byte-identical to ${same[0]}`, extra: same.slice(2) });
  }
  // the roots themselves may hold stray AI exports: huge single JSON/JSONL chat exports in Downloads are reported as heavy-ish
  void roots;
  return out.sort((a, b) => b.size - a.size);
}

function walkSkills(dir, out, depth) {
  if (depth > 6) return;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const p = path.join(dir, e.name);
    if (fs.existsSync(path.join(p, 'SKILL.md'))) out.push(p); else walkSkills(p, out, depth + 1);
  }
}

function dirSignature(dir) {
  const h = crypto.createHash('sha256');
  const rec = (d, rel) => {
    let entries; try { entries = fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)); } catch { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) rec(p, `${rel}/${e.name}`);
      else if (e.isFile()) { try { h.update(`${rel}/${e.name}\0`); h.update(fs.readFileSync(p)); h.update('\0'); } catch { /* ignore */ } }
    }
  };
  rec(dir, '');
  return h.digest('hex');
}

/** The cwd recorded in the first transcript lines of a ~/.claude/projects/<slug>/ folder, or null. */
function transcriptCwd(dir) {
  let names;
  try { names = fs.readdirSync(dir).filter((n) => n.endsWith('.jsonl')).slice(0, 5); } catch { return null; }
  for (const n of names) {
    try {
      const fd = fs.openSync(path.join(dir, n), 'r');
      let head;
      try { const buf = Buffer.alloc(256 * 1024); const got = fs.readSync(fd, buf, 0, buf.length, 0); head = buf.subarray(0, got).toString('utf8'); } finally { fs.closeSync(fd); }
      const m = /"cwd"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(head);
      if (m) { try { return JSON.parse(`"${m[1]}"`); } catch { return m[1]; } }
    } catch { /* next file */ }
  }
  return null;
}

// ---------------------------------------------------------------------------
// apply / undo
function human(n) {
  if (n < 1024) return `${n}B`;
  if (n < 1048576) return `${(n / 1024).toFixed(1)}KB`;
  if (n < 1073741824) return `${(n / 1048576).toFixed(1)}MB`;
  return `${(n / 1073741824).toFixed(2)}GB`;
}

function moveInto(src, destRoot, root) {
  const rel = path.relative(root, src);
  const inside = rel && !rel.startsWith('..') && !path.isAbsolute(rel);
  const dest = path.join(destRoot, inside ? rel : path.join('_outside', src.replace(/^[A-Za-z]:/, (m) => m[0]).replace(/[\\/:]+/g, path.sep)));
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  let final = dest, n = 1;
  while (fs.existsSync(final)) final = `${dest}.${n++}`;
  try { fs.renameSync(src, final); } catch (e) {
    if (e.code !== 'EXDEV') throw e;
    // different volume: copy, verify, then remove the source (the data is already safe in quarantine)
    const st = fs.statSync(src);
    if (st.isDirectory()) fs.cpSync(src, final, { recursive: true }); else fs.copyFileSync(src, final);
    const back = fs.statSync(final);
    if (!st.isDirectory() && back.size !== st.size) { fs.rmSync(final, { force: true }); throw new Error(`copy size mismatch for ${src}`); }
    fs.rmSync(src, { recursive: true, force: true });
  }
  return final;
}

function apply(report, opts, log) {
  const cats = new Set(opts.only || ['duplicates', 'empty', 'junk', 'ai']);
  if (opts.includeHeavy) cats.add('heavy');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const qRoot = opts.quarantine ? path.resolve(opts.quarantine) : path.join(report.roots[0], '_turbo-quarantine', stamp);
  fs.mkdirSync(qRoot, { recursive: true });
  const manifest = { createdAt: new Date().toISOString(), roots: report.roots, moved: [], removedEmptyDirs: [], errors: [] };
  const manifestPath = path.join(qRoot, 'manifest.json');
  const save = () => fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  const rootOf = (p) => report.roots.find((r) => p === r || p.startsWith(r + path.sep)) || report.roots[0];
  const move = (src, category) => {
    try { const dest = moveInto(src, qRoot, rootOf(src)); manifest.moved.push({ from: src, to: dest, category }); if (manifest.moved.length % 50 === 0) save(); }
    catch (e) { manifest.errors.push({ path: src, error: String(e.message || e) }); }
  };
  save();
  if (cats.has('duplicates')) for (const g of report.duplicates) for (const extra of g.extra) move(extra, 'duplicates');
  if (cats.has('junk')) for (const j of report.junk) move(j.abs, 'junk');
  if (cats.has('empty')) {
    for (const f of report.emptyFiles) move(f, 'empty');
    // deepest first so parents become empty after their children are gone
    for (const d of [...report.emptyDirs].sort((a, b) => b.length - a.length)) {
      if (report.roots.includes(d)) continue;
      try { fs.rmdirSync(d); manifest.removedEmptyDirs.push(d); } catch (e) { manifest.errors.push({ path: d, error: String(e.message || e) }); }
    }
  }
  if (cats.has('ai')) for (const a of report.ai) {
    if (a.filesOnly) { try { for (const f of fs.readdirSync(a.abs)) { const p = path.join(a.abs, f); try { const s = fs.statSync(p); if (s.isFile() && s.mtimeMs < a.cutoff) move(p, 'ai'); } catch { /* ignore */ } } } catch { /* ignore */ } }
    else { move(a.abs, 'ai'); for (const x of a.extra || []) move(x, 'ai'); }
  }
  if (cats.has('heavy')) for (const h of report.heavy) move(h.abs, 'heavy');
  save();
  log(`quarantined ${manifest.moved.length} item(s) and removed ${manifest.removedEmptyDirs.length} empty folder(s) -> ${qRoot}${manifest.errors.length ? ` (${manifest.errors.length} errors, see manifest.json)` : ''}`);
  log(`undo with: node "${__filename}" --undo "${qRoot}"`);
  return { qRoot, manifest };
}

function undo(qDir, log) {
  const manifestPath = path.join(path.resolve(qDir), 'manifest.json');
  const m = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  let restored = 0, skipped = 0;
  for (const d of [...m.removedEmptyDirs].sort((a, b) => a.length - b.length)) { try { fs.mkdirSync(d, { recursive: true }); restored++; } catch { skipped++; } }
  for (const it of m.moved.slice().reverse()) {
    if (fs.existsSync(it.from)) { skipped++; continue; }
    try { fs.mkdirSync(path.dirname(it.from), { recursive: true }); fs.renameSync(it.to, it.from); restored++; }
    catch (e) { try { fs.cpSync(it.to, it.from, { recursive: true }); fs.rmSync(it.to, { recursive: true, force: true }); restored++; } catch (e2) { skipped++; log(`could not restore ${it.from}: ${e2.message}`); void e; } }
  }
  fs.writeFileSync(manifestPath, JSON.stringify({ ...m, undoneAt: new Date().toISOString(), restored, skipped }, null, 2));
  log(`restored ${restored} item(s), ${skipped} skipped (already present or failed)`);
  return { restored, skipped };
}

// ---------------------------------------------------------------------------
// report
function buildReport(roots, opts, log) {
  const s = scan(roots, opts, log);
  const emptyFiles = s.files.filter((f) => f.size === 0).map((f) => f.abs);
  const duplicates = findDuplicates(s.files, opts, log);
  const junk = findJunk(s.files, opts);
  const archives = findArchives(s.files);
  const cutoff = Date.now() - Math.max(opts.olderThan, 90) * 86400000;
  const heavy = s.heavy.filter((h) => h.mtimeMs < cutoff).sort((a, b) => b.size - a.size);
  const ai = findAiLeftovers(opts, roots);
  const totalBytes = s.files.reduce((n, f) => n + f.size, 0);
  const reclaim = {
    duplicates: duplicates.reduce((n, g) => n + g.reclaim, 0),
    junk: junk.reduce((n, j) => n + j.size, 0),
    ai: ai.reduce((n, a) => n + a.size, 0),
    heavy: heavy.reduce((n, h) => n + h.size, 0),
    archives: archives.reduce((n, a) => n + a.size, 0),
  };
  return { roots, scanned: { files: s.files.length, dirs: s.visitedDirs, bytes: totalBytes, ms: s.elapsedMs, truncated: s.truncated }, duplicates, emptyFiles, emptyDirs: s.emptyDirs, junk, ai, heavy, archives, reclaim };
}

function printReport(r, opts) {
  const L = [];
  L.push(`Turbo tidy report for ${r.roots.join(', ')}`);
  L.push(`scanned ${r.scanned.files.toLocaleString('en-US')} files in ${r.scanned.dirs.toLocaleString('en-US')} folders (${human(r.scanned.bytes)}) in ${(r.scanned.ms / 1000).toFixed(1)}s${r.scanned.truncated ? ` — STOPPED at --max-files ${opts.maxFiles}; scan a subfolder or raise the limit` : ''}`);
  L.push('');
  const lim = opts.limit;
  L.push(`DUPLICATES: ${r.duplicates.length} group(s), ${human(r.reclaim.duplicates)} in extra copies (the kept copy is listed first)`);
  for (const g of r.duplicates.slice(0, lim)) { L.push(`  ${human(g.size)}  keep ${g.keep}`); for (const e of g.extra) L.push(`           extra ${e}`); }
  if (r.duplicates.length > lim) L.push(`  … ${r.duplicates.length - lim} more groups (--limit to see more, --json for all)`);
  L.push(`EMPTY: ${r.emptyFiles.length} zero-byte file(s), ${r.emptyDirs.length} empty folder(s)`);
  for (const f of r.emptyFiles.slice(0, lim)) L.push(`  file    ${f}`);
  for (const d of r.emptyDirs.slice(0, lim)) L.push(`  folder  ${d}`);
  L.push(`JUNK: ${r.junk.length} item(s), ${human(r.reclaim.junk)}`);
  for (const j of r.junk.slice(0, lim)) L.push(`  ${human(j.size).padStart(8)}  ${j.abs}  (${j.why})`);
  L.push(`AI LEFTOVERS: ${r.ai.length} item(s), ${human(r.reclaim.ai)}`);
  for (const a of r.ai.slice(0, lim)) L.push(`  ${human(a.size).padStart(8)}  ${a.abs}  (${a.why})`);
  L.push(`HEAVY (regenerable, untouched ${Math.max(opts.olderThan, 90)}+ days; report only unless --include-heavy): ${r.heavy.length} folder(s), ${human(r.reclaim.heavy)}`);
  for (const h of r.heavy.slice(0, lim)) L.push(`  ${human(h.size).padStart(8)}  ${h.abs}  (${h.files.toLocaleString('en-US')} files)`);
  L.push(`ARCHIVES next to an extracted folder (report only): ${r.archives.length}, ${human(r.reclaim.archives)}`);
  for (const a of r.archives.slice(0, lim)) L.push(`  ${human(a.size).padStart(8)}  ${a.abs}  -> ${a.folder}`);
  L.push('');
  L.push(`Reclaimable now: ${human(r.reclaim.duplicates + r.reclaim.junk + r.reclaim.ai)} (duplicates + junk + AI leftovers); plus ${human(r.reclaim.heavy)} heavy and ${human(r.reclaim.archives)} archives if you choose.`);
  L.push('Nothing was changed. To quarantine (move, never delete): add --apply [--only duplicates,empty,junk,ai]. Undo any run with --undo <quarantine folder>.');
  return L.join('\n');
}

// ---------------------------------------------------------------------------
function main() {
  const opts = parseArgs(process.argv.slice(2));
  const log = (m) => { if (!opts.quiet) console.error(m); };
  if (opts.help || (!opts.roots.length && !opts.undo)) {
    console.log('Usage: node tidy.js <root> [<root>...] [--json] [--apply [--only duplicates,empty,junk,ai,heavy]] [--min-size bytes] [--older-than days] [--exclude glob]... [--max-files n] [--limit n] [--claude-dir dir] [--include-heavy] [--all]\n       node tidy.js --undo <quarantine dir>');
    process.exit(opts.help ? 0 : 2);
  }
  if (opts.undo) { undo(opts.undo, (m) => console.log(m)); return; }
  const roots = opts.roots.map((r) => path.resolve(r));
  for (const r of roots) { let st; try { st = fs.statSync(r); } catch { console.error(`Not found: ${r}`); process.exit(2); } if (!st.isDirectory()) { console.error(`Not a directory: ${r}`); process.exit(2); } }
  const report = buildReport(roots, opts, log);
  if (opts.apply) {
    const res = apply(report, opts, (m) => console.log(m));
    if (opts.json) console.log(JSON.stringify({ report, quarantine: res.qRoot, manifest: res.manifest }, null, 2));
    return;
  }
  if (opts.json) console.log(JSON.stringify(report, null, 2));
  else console.log(printReport(report, opts));
}

if (require.main === module) {
  try { main(); } catch (e) { console.error(`tidy failed: ${e && e.stack || e}`); process.exit(1); }
}

module.exports = { parseArgs, scan, findDuplicates, findJunk, findArchives, findAiLeftovers, buildReport, printReport, apply, undo, transcriptCwd, human };
