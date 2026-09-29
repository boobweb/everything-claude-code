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
//   junk        Thumbs.db, .DS_Store, Office lock files (~$x.docx), stale *.tmp/*.part/*.crdownload
//               (desktop.ini is never junk: Windows keeps a folder's icon and display name in it)
//   ai          Claude Code leftovers: transcripts of projects that no longer exist, old CLI logs, stale plugin data
//   heavy       node_modules, virtualenvs, build caches untouched for a long time (report only, regenerable)
//   archives    an archive next to a folder of the same name (report only: probably already extracted)
//
// Options: --min-size <bytes> (duplicates, default 1024)  --older-than <days> (junk/ai/heavy age, default 30)
//          --exclude <glob> (repeatable)  --max-files <n> (default 400000)  --limit <n> (items listed per category)
//          --claude-dir <dir> (default ~/.claude)  --include-heavy (also quarantine heavy items with --apply)
//          --include-projects (files inside project and app folders may be quarantined; by default a folder holding
//          .git, package.json, pyproject.toml etc., or a program (.exe, a macOS .app bundle), is a unit: nothing in it
//          is a duplicate or an empty file)
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
      case '--include-projects': a.includeProjects = true; break;
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
const SKIP_DIR_NAMES = new Set(['.git', '.hg', '.svn', '$RECYCLE.BIN', 'System Volume Information', '$Recycle.Bin', 'Recovery', 'Config.Msi', '.Trash', '.Trashes', '.Spotlight-V100', '.fseventsd', 'lost+found', '_turbo-quarantine']);
const FS_ROOT_ONLY_SKIP = new Set(['proc', 'sys', 'dev', 'run']); // kernel pseudo-filesystems: skipped only directly under / (a ~/dev folder is user data)
// A folder holding one of these is a project: its files are never duplicates of each other or of another project's, and its 0-byte files are placeholders, not clutter
const PROJECT_MARKERS = ['.git', 'package.json', 'pyproject.toml', 'setup.py', 'setup.cfg', 'requirements.txt', 'Cargo.toml', 'go.mod', 'pom.xml', 'build.gradle', 'composer.json', 'Gemfile', 'CMakeLists.txt', 'Makefile', 'CLAUDE.md', '.sln', '.csproj', 'mix.exs', 'Package.swift'];
// A folder that directly holds a program (.exe), or a macOS .app bundle, is an installed or portable app and is a unit the same way:
// its empty folders (Config, Logs, Data it fills later) and 0-byte files belong to it. Drive roots, the home folder and the folders
// installers are downloaded or saved into are never apps, or one setup.exe sitting in Downloads would hide everything around it.
const NEVER_APP_DIR_RE = /^(Downloads|Desktop|Documents|OneDrive)$/i;
// 0-byte files that are load-bearing by name or type (module markers, keep files, empty configs and stubs)
const PLACEHOLDER_NAME_RE = /^(__init__\.py|__init__\.pyi|py\.typed|\.gitkeep|\.keep|\.gitignore|\.nojekyll|\.npmignore|\.hgkeep|\.placeholder|\.htaccess|CNAME|Procfile|\.env(\..*)?|\..+)$/i;
const CODE_EXT_RE = /\.(py|pyi|js|mjs|cjs|ts|tsx|jsx|json|yml|yaml|toml|ini|cfg|conf|lock|go|rs|java|c|h|cpp|hpp|cc|cs|rb|php|sql|sh|ps1|psm1|bat|cmd|html|htm|css|scss|xml|gradle|properties)$/i;
const SYSTEM_DIR_RE = /^(Windows|Program Files|Program Files \(x86\)|ProgramData|PerfLogs|Library|System|private|usr|bin|sbin|lib|lib64|etc|var|boot|opt|snap|run)$/i;
const HEAVY_DIR_RE = /^(node_modules|\.venv|venv|__pycache__|\.pytest_cache|\.mypy_cache|\.ruff_cache|\.tox|\.gradle|\.nuxt|\.next|\.turbo|\.parcel-cache|\.cache|target|Pods|DerivedData|bower_components|\.pnpm-store)$/;
// desktop.ini is not junk: Windows keeps a folder's icon and display name in it (Downloads, Pictures, Screenshots)
const JUNK_NAME_RE = /^(Thumbs\.db|ehthumbs\.db|\.DS_Store|\._.*)$/i;
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
/** Resolve, deduplicate and drop nested roots: scanning ~ and ~/Downloads together must not list a file twice (it would pair with itself as a "duplicate"). */
function normalizeRoots(roots, log) {
  const out = [];
  for (const r0 of roots) {
    // the root keeps the form it was typed in (paths in the report and manifest must match what the user sees);
    // the real path (symlinks resolved, macOS /var -> /private/var) is only the key that detects overlap
    const abs = path.resolve(r0);
    let real = abs;
    try { real = fs.realpathSync.native(abs); } catch { /* not resolvable: compare as typed */ }
    const key = process.platform === 'win32' ? real.toLowerCase() : real;
    const within = (a, b) => a === b || a.startsWith(b.endsWith(path.sep) ? b : b + path.sep);
    const covered = out.find((o) => within(key, o.key));
    if (covered) { if (log) log(`  note: ${r0} is inside ${covered.abs}; scanning it once`); continue; }
    for (let i = out.length - 1; i >= 0; i--) if (within(out[i].key, key)) { if (log) log(`  note: ${out[i].abs} is inside ${r0}; scanning it once`); out.splice(i, 1); }
    out.push({ abs, key });
  }
  return out.map((o) => o.abs);
}

const sameDir = (a, b) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);
/** True when dir is an installed or portable program: it directly holds an .exe, or it is a macOS *.app bundle. */
function isAppFolder(dir, entries) {
  if (path.parse(dir).root === dir || sameDir(dir, os.homedir()) || NEVER_APP_DIR_RE.test(path.basename(dir))) return false;
  if (/\.app$/i.test(dir)) return entries.some((e) => e.name === 'Contents' && e.isDirectory());
  return entries.some((e) => e.isFile() && /\.exe$/i.test(e.name));
}

function scan(roots, opts, log) {
  const files = [];          // { abs, size, mtimeMs, name, root, project? }
  const emptyDirs = [];      // abs
  const heavy = [];          // { abs, size, files, mtimeMs }
  const projects = [];       // abs of every project folder seen
  const apps = [];           // abs of every app folder seen (a program's own folder, treated like a project)
  const excludes = opts.exclude.map(globToRe);
  const seen = new Set();
  const t0 = Date.now();
  let visitedDirs = 0, truncated = false, lastReport = 0;
  const now = Date.now();

  function walk(dir, root, depth, project) {
    if (files.length >= opts.maxFiles) { truncated = true; return { empty: false, size: 0, count: 0, newest: 0 }; }
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return { empty: false, size: 0, count: 0, newest: 0 }; }
    visitedDirs++;
    if (!opts.quiet && Date.now() - lastReport > 2000) { lastReport = Date.now(); log(`  scanning… ${files.length.toLocaleString('en-US')} files, ${visitedDirs.toLocaleString('en-US')} folders, ${Math.round((Date.now() - t0) / 1000)}s`); }
    if (!project && entries.some((e) => PROJECT_MARKERS.some((m) => m.startsWith('.') && m.length > 4 && !m.startsWith('.git') ? e.name.toLowerCase().endsWith(m) : e.name === m))) { project = dir; projects.push(dir); }
    else if (!project && isAppFolder(dir, entries)) { project = dir; apps.push(dir); }
    const isFsRoot = path.parse(dir).root === dir;
    let size = 0, count = 0, newest = 0, hasAnything = false;
    for (const e of entries) {
      const abs = path.join(dir, e.name);
      if (excludes.some((re) => re.test(abs))) { hasAnything = true; continue; }
      if (e.isSymbolicLink()) { hasAnything = true; continue; }
      if (e.isDirectory()) {
        // skipped, system and heavy folders count as content; a folder holding only empty folders is itself empty
        if (SKIP_DIR_NAMES.has(e.name) || (isFsRoot && FS_ROOT_ONLY_SKIP.has(e.name))) { hasAnything = true; continue; }
        if (!opts.all && depth <= 1 && SYSTEM_DIR_RE.test(e.name)) { hasAnything = true; continue; }
        if (HEAVY_DIR_RE.test(e.name)) {
          hasAnything = true;
          const h = measure(abs);
          heavy.push({ abs, size: h.size, files: h.count, mtimeMs: h.newest });
          continue; // never index inside: full of legitimate duplicates and not user data
        }
        const sub = walk(abs, root, depth + 1, project);
        if (sub.empty) { if (!project || opts.includeProjects) emptyDirs.push(abs); } else hasAnything = true;
        size += sub.size; count += sub.count; newest = Math.max(newest, sub.newest);
        continue;
      }
      if (!e.isFile()) { hasAnything = true; continue; }
      let st;
      try { st = fs.statSync(abs); } catch { continue; }
      hasAnything = true;
      const key = process.platform === 'win32' ? abs.toLowerCase() : abs;
      if (seen.has(key)) continue;
      seen.add(key);
      files.push({ abs, size: st.size, mtimeMs: st.mtimeMs, name: e.name, root, project: project || null });
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
    const r = walk(root, root, 0, null);
    if (r.empty) emptyDirs.push(root);
  }
  void now;
  return { files, emptyDirs, heavy, projects, apps, truncated, visitedDirs, elapsedMs: Date.now() - t0 };
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
  // lower is better: a file inside a project is kept over a loose copy; an original is not named like a copy, sits in a shorter path, is older
  let s = 0;
  if (f.project) s -= 1000;
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
  let hashed = 0, hashedBytes = 0, protectedGroups = 0;
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
        // a copy that lives inside a project folder is part of that project (its own jquery.min.js, its own assets): never an "extra"
        const extra = fg.slice(1).filter((f) => opts.includeProjects || !f.project);
        if (!extra.length) { protectedGroups++; continue; }
        groups.push({ size: fg[0].size, keep: fg[0].abs, extra: extra.map((f) => f.abs), reclaim: fg[0].size * extra.length });
      }
    }
  }
  groups.sort((a, b) => b.reclaim - a.reclaim);
  groups.protectedGroups = protectedGroups;
  if (!opts.quiet) log(`  hashed ${hashed.toLocaleString('en-US')} candidate files (${human(hashedBytes)})${protectedGroups ? `; ${protectedGroups} identical-file group(s) inside project folders left alone` : ''}`);
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
      // several project paths can share one slug (separators and hyphens both become '-'), so every transcript's own
      // cwd is checked: the folder goes only when all of them point at deleted folders; otherwise only the orphans do
      const recs = transcriptCwds(dir);
      const known = recs.filter((r) => r.cwd);
      const orphans = known.filter((r) => !fs.existsSync(r.cwd));
      if (!orphans.length) continue;
      const gone = [...new Set(orphans.map((r) => r.cwd))].join(', ');
      if (known.length === recs.length && orphans.length === recs.length) out.push({ abs: dir, size: dirSize(dir), why: `session transcripts of a project folder that no longer exists (${gone})` });
      else {
        const live = [...new Set(known.filter((r) => fs.existsSync(r.cwd)).map((r) => r.cwd))];
        const files = orphans.map((r) => r.file);
        out.push({ abs: dir, files, size: files.reduce((n, f) => { try { return n + fs.statSync(f).size; } catch { return n; } }, 0), why: `${files.length} transcript(s) of a deleted project (${gone}) in a folder shared with ${live.length ? `a live project (${live.join(', ')})` : 'transcripts whose project is unknown'}; only those files move` });
      }
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
  // duplicate skills: a personal skill under ~/.claude/skills that is byte-identical to one a plugin already provides.
  // Only the personal copy is ever a candidate: ~/.claude/plugins is Claude Code's own storage (cache + marketplace
  // checkouts legitimately hold the same skill twice) and is never touched.
  const personal = path.join(claudeDir, 'skills');
  const skillDirs = [];
  for (const base of [personal, path.join(claudeDir, 'plugins')]) {
    try { walkSkills(base, skillDirs, 0); } catch { /* ignore */ }
  }
  const isPersonal = (d) => d === personal || d.startsWith(personal + path.sep);
  const byName = new Map();
  for (const d of skillDirs) { const l = byName.get(path.basename(d)); if (l) l.push(d); else byName.set(path.basename(d), [d]); }
  for (const [name, dirs] of byName) {
    if (dirs.length < 2) continue;
    const sigs = new Map();
    for (const d of dirs) { const sig = dirSignature(d); const l = sigs.get(sig); if (l) l.push(d); else sigs.set(sig, [d]); }
    for (const [, same] of sigs) {
      if (same.length < 2) continue;
      const keep = same.find((d) => !isPersonal(d)) || same[0];
      const candidates = same.filter((d) => d !== keep && isPersonal(d));
      if (candidates.length) out.push({ abs: candidates[0], size: dirSize(candidates[0]), why: `skill "${name}" is byte-identical to ${keep}`, extra: candidates.slice(1) });
    }
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
/** The cwd a transcript records (from its first 256 KB), or null. */
function transcriptFileCwd(file) {
  try {
    const fd = fs.openSync(file, 'r');
    let head;
    try { const buf = Buffer.alloc(256 * 1024); const got = fs.readSync(fd, buf, 0, buf.length, 0); head = buf.subarray(0, got).toString('utf8'); } finally { fs.closeSync(fd); }
    const m = /"cwd"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(head);
    if (m) { try { return JSON.parse(`"${m[1]}"`); } catch { return m[1]; } }
  } catch { /* unreadable */ }
  return null;
}

/** Every transcript in a project folder with the cwd it records: [{ file, cwd|null }]. */
function transcriptCwds(dir) {
  let names;
  try { names = fs.readdirSync(dir).filter((n) => n.endsWith('.jsonl')).slice(0, 500); } catch { return []; }
  return names.map((n) => { const file = path.join(dir, n); return { file, cwd: transcriptFileCwd(file) }; });
}

/** The first recorded cwd in a project folder, or null (kept for callers that only need one). */
function transcriptCwd(dir) {
  const hit = transcriptCwds(dir).find((r) => r.cwd);
  return hit ? hit.cwd : null;
}

/** Real path of p even when its leaf does not exist: the deepest existing ancestor is resolved. */
function realDeep(p) {
  let cur = path.resolve(p);
  const tail = [];
  for (let i = 0; i < 64; i++) {
    try { const real = fs.realpathSync.native(cur); return tail.length ? path.join(real, ...[...tail].reverse()) : real; } catch { /* keep walking up */ }
    const parent = path.dirname(cur);
    if (parent === cur) return path.resolve(p);
    tail.push(path.basename(cur));
    cur = parent;
  }
  return path.resolve(p);
}

// ---------------------------------------------------------------------------
// apply / undo
function human(n) {
  if (n < 1024) return `${n}B`;
  if (n < 1048576) return `${(n / 1024).toFixed(1)}KB`;
  if (n < 1073741824) return `${(n / 1048576).toFixed(1)}MB`;
  return `${(n / 1073741824).toFixed(2)}GB`;
}

function treeStats(dir) {
  let files = 0, bytes = 0;
  const rec = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) rec(p); else if (e.isFile()) { files++; bytes += fs.statSync(p).size; } } };
  rec(dir);
  return { files, bytes };
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
    const a = st.isDirectory() ? treeStats(src) : { files: 1, bytes: st.size };
    const b = st.isDirectory() ? treeStats(final) : { files: 1, bytes: fs.statSync(final).size };
    if (a.files !== b.files || a.bytes !== b.bytes) { fs.rmSync(final, { recursive: true, force: true }); throw new Error(`copy verification failed for ${src} (${a.files} files/${a.bytes} bytes vs ${b.files}/${b.bytes}); source left in place`); }
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
  const claudeDir = opts.claudeDir ? path.resolve(opts.claudeDir) : path.join(os.homedir(), '.claude');
  const manifest = { createdAt: new Date().toISOString(), roots: report.roots, claudeDir, moved: [], removedEmptyDirs: [], errors: [] };
  const manifestPath = path.join(qRoot, 'manifest.json');
  const logPath = path.join(qRoot, 'moves.log'); // one JSON line per move, appended before the manifest is rewritten: --undo reads both
  const save = () => fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  const rootOf = (p) => report.roots.find((r) => p === r || p.startsWith(r + path.sep)) || report.roots[0];
  const pluginStore = path.join(opts.claudeDir ? path.resolve(opts.claudeDir) : path.join(os.homedir(), '.claude'), 'plugins');
  const move = (src, category) => {
    if (src === pluginStore || src.startsWith(pluginStore + path.sep)) { manifest.errors.push({ path: src, error: 'refused: inside Claude Code plugin storage' }); return; }
    try {
      const dest = moveInto(src, qRoot, rootOf(src));
      const entry = { from: src, to: dest, category };
      manifest.moved.push(entry);
      fs.appendFileSync(logPath, JSON.stringify(entry) + '\n');
      if (manifest.moved.length <= 200 || manifest.moved.length % 25 === 0) save();
    } catch (e) { manifest.errors.push({ path: src, error: String(e.message || e) }); }
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
    else if (a.files) { for (const f of a.files) move(f, 'ai'); }
    else { move(a.abs, 'ai'); for (const x of a.extra || []) move(x, 'ai'); }
  }
  if (cats.has('heavy')) for (const h of report.heavy) move(h.abs, 'heavy');
  save();
  log(`quarantined ${manifest.moved.length} item(s) and removed ${manifest.removedEmptyDirs.length} empty folder(s) -> ${qRoot}${manifest.errors.length ? ` (${manifest.errors.length} errors, see manifest.json)` : ''}`);
  log(`undo with: node "${__filename}" --undo "${qRoot}"`);
  return { qRoot, manifest };
}

function undo(qDir, log) {
  const q = path.resolve(qDir);
  const manifestPath = path.join(q, 'manifest.json');
  const m = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  m.moved = Array.isArray(m.moved) ? m.moved : [];
  m.removedEmptyDirs = Array.isArray(m.removedEmptyDirs) ? m.removedEmptyDirs : [];
  // moves.log may hold entries a crash kept out of manifest.json
  try {
    const known = new Set(m.moved.map((it) => it.to));
    for (const line of fs.readFileSync(path.join(q, 'moves.log'), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try { const it = JSON.parse(line); if (it && it.to && !known.has(it.to)) { m.moved.push(it); known.add(it.to); } } catch { /* ignore */ }
    }
  } catch { /* no log */ }
  const inside = (p, base) => { const r = path.relative(base, p); return r !== '' && !r.startsWith('..') && !path.isAbsolute(r); };
  const isLink = (p) => { try { return fs.lstatSync(p).isSymbolicLink(); } catch { return false; } };
  // where a restore may land: the roots the run scanned and the Claude directory it inspected (both as recorded)
  const qReal = realDeep(q);
  const homes = [...(Array.isArray(m.roots) ? m.roots : []), m.claudeDir || path.join(os.homedir(), '.claude')].filter((r) => typeof r === 'string').map(realDeep);
  let restored = 0, skipped = 0;
  for (const d of [...m.removedEmptyDirs].sort((a, b) => a.length - b.length)) {
    if (typeof d !== 'string' || !homes.some((h) => inside(realDeep(d), h))) { skipped++; continue; }
    try { fs.mkdirSync(d, { recursive: true }); restored++; } catch { skipped++; }
  }
  for (const it of m.moved.slice().reverse()) {
    // Only a real file inside this quarantine folder may move, and only back under a scanned root or the Claude directory:
    // paths are judged after symlink resolution, so a link planted inside the quarantine cannot reach a victim elsewhere.
    const ok = typeof it.from === 'string' && typeof it.to === 'string'
      && inside(path.resolve(it.to), q) && inside(realDeep(it.to), qReal) && !isLink(it.to)
      && !inside(path.resolve(it.from), q) && path.resolve(it.from) !== q && !inside(realDeep(it.from), qReal)
      && homes.some((h) => inside(realDeep(it.from), h));
    if (!ok) { skipped++; log(`refused: ${it.to} -> ${it.from} is not a quarantine move`); continue; }
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
  roots = normalizeRoots(roots, opts.quiet ? null : log);
  const s = scan(roots, opts, log);
  // a 0-byte file is clutter only when it is loose data: not a module marker / keep file / dotfile, not a code or config stub, not inside a project
  const emptyFiles = s.files.filter((f) => f.size === 0 && !PLACEHOLDER_NAME_RE.test(f.name) && !CODE_EXT_RE.test(f.name) && (opts.includeProjects || !f.project)).map((f) => f.abs);
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
  const projects = { count: s.projects.length, apps: s.apps.length, files: s.files.filter((f) => f.project).length, protectedDuplicateGroups: duplicates.protectedGroups || 0, included: !!opts.includeProjects };
  return { roots, scanned: { files: s.files.length, dirs: s.visitedDirs, bytes: totalBytes, ms: s.elapsedMs, truncated: s.truncated }, projects, duplicates, emptyFiles, emptyDirs: s.emptyDirs, junk, ai, heavy, archives, reclaim };
}

function printReport(r, opts) {
  const L = [];
  L.push(`Turbo tidy report for ${r.roots.join(', ')}`);
  L.push(`scanned ${r.scanned.files.toLocaleString('en-US')} files in ${r.scanned.dirs.toLocaleString('en-US')} folders (${human(r.scanned.bytes)}) in ${(r.scanned.ms / 1000).toFixed(1)}s${r.scanned.truncated ? ` — STOPPED at --max-files ${opts.maxFiles}; scan a subfolder or raise the limit` : ''}`);
  const units = r.projects ? [r.projects.count ? `${r.projects.count} project folder(s)` : '', r.projects.apps ? `${r.projects.apps} app folder(s)` : ''].filter(Boolean).join(' and ') : '';
  if (units) L.push(`${units} (${r.projects.files.toLocaleString('en-US')} files) ${r.projects.included ? 'included' : `treated as units: nothing inside them is a duplicate or an empty file${r.projects.protectedDuplicateGroups ? ` (${r.projects.protectedDuplicateGroups} identical-file groups left alone)` : ''}; pass --include-projects to include them`}`);
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
    console.log('Usage: node tidy.js <root> [<root>...] [--json] [--apply [--only duplicates,empty,junk,ai,heavy]] [--min-size bytes] [--older-than days] [--exclude glob]... [--max-files n] [--limit n] [--claude-dir dir] [--include-heavy] [--include-projects] [--all]\n       node tidy.js --undo <quarantine dir>');
    process.exit(opts.help ? 0 : 2);
  }
  if (opts.undo) { undo(opts.undo, (m) => console.log(m)); return; }
  const roots = opts.roots.map((r) => path.resolve(r));
  for (const r of roots) { let st; try { st = fs.statSync(r); } catch { console.error(`Not found: ${r}`); process.exit(2); } if (!st.isDirectory()) { console.error(`Not a directory: ${r}`); process.exit(2); } }
  const pluginStore = path.join(opts.claudeDir ? path.resolve(opts.claudeDir) : path.join(os.homedir(), '.claude'), 'plugins');
  for (const r of roots) if (r === pluginStore || r.startsWith(pluginStore + path.sep)) { console.error(`Refusing to tidy inside Claude Code plugin storage: ${r}`); process.exit(2); }
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

module.exports = { parseArgs, scan, normalizeRoots, findDuplicates, findJunk, findArchives, findAiLeftovers, buildReport, printReport, apply, undo, transcriptCwd, transcriptCwds, human };
