'use strict';
// Small filesystem helpers shared by the MCP server and the hooks.
// Zero dependencies. Works on Windows, macOS and Linux.

const fs = require('fs');
const path = require('path');
const os = require('os');

const IGNORE_DIRS = new Set([
  '.git', '.hg', '.svn', 'node_modules', 'bower_components', '.pnpm-store',
  'dist', 'build', 'out', 'target', 'obj', '.next', '.nuxt', '.svelte-kit',
  '.output', '.turbo', '.cache', '.parcel-cache', 'coverage', '.nyc_output',
  '__pycache__', '.pytest_cache', '.mypy_cache', '.ruff_cache', '.tox', '.venv', 'venv',
  '.idea', '.vscode', '.vs', '.gradle', '.terraform', 'vendor', 'Pods', 'DerivedData',
  '.claude/worktrees', 'tmp', 'temp',
]);

/** Directories that look like Python virtual environments (any name) are skipped too. */
function isVirtualEnv(absDir) {
  return exists(path.join(absDir, 'pyvenv.cfg'));
}

const BINARY_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.icns', '.tif', '.tiff', '.psd', '.ai',
  '.mp3', '.wav', '.ogg', '.flac', '.m4a', '.aac', '.mp4', '.mov', '.avi', '.mkv', '.webm',
  '.zip', '.gz', '.tgz', '.bz2', '.xz', '.7z', '.rar', '.jar', '.war', '.whl', '.egg',
  '.pdf', '.doc', '.docx', '.ppt', '.pptx', '.xls', '.xlsx', '.odt',
  '.exe', '.dll', '.so', '.dylib', '.a', '.lib', '.o', '.obj', '.class', '.pyc', '.pyo', '.wasm',
  '.ttf', '.otf', '.woff', '.woff2', '.eot',
  '.db', '.sqlite', '.sqlite3', '.bin', '.dat', '.iso', '.img', '.dmg', '.pak',
  '.lock',
]);

const LOCKFILES = new Set([
  'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lockb', 'bun.lock', 'Cargo.lock',
  'poetry.lock', 'Pipfile.lock', 'composer.lock', 'Gemfile.lock', 'go.sum', 'packages.lock.json',
]);

function statSafe(p) {
  try { return fs.statSync(p); } catch { return null; }
}

function exists(p) { return statSafe(p) !== null; }

function isDir(p) { const s = statSafe(p); return !!(s && s.isDirectory()); }

function isFile(p) { const s = statSafe(p); return !!(s && s.isFile()); }

/** Normalize a path from a hook payload or tool argument into a native absolute path. */
function normPath(p, base) {
  if (!p) return p;
  let s = String(p).trim();
  // A Windows-style relative path handed to a POSIX host (backslashes, no slashes) is almost
  // certainly a path, not a filename containing backslashes.
  if (process.platform !== 'win32' && s.includes('\\') && !s.includes('/')) s = s.replace(/\\/g, '/');
  if (/^~([\\/]|$)/.test(s)) s = path.join(os.homedir(), s.slice(1)); // ~, ~/x and ~\x (PowerShell expands ~ the same way)
  // Git Bash style /c/Users/... -> C:/Users/...
  if (process.platform === 'win32') {
    const m = /^\/([a-zA-Z])\/(.*)$/.exec(s);
    if (m) s = `${m[1].toUpperCase()}:/${m[2]}`;
  }
  if (!path.isAbsolute(s)) s = path.resolve(base || process.cwd(), s);
  return path.normalize(s);
}

/** Display form: forward slashes everywhere (more compact for the model, unambiguous). */
function toPosix(p) { return String(p).replace(/\\/g, '/'); }

function relDisplay(p, root) {
  if (!root) return toPosix(p);
  const rel = path.relative(root, p);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return toPosix(p);
  return toPosix(rel);
}

function looksBinary(buf) {
  const n = Math.min(buf.length, 8000);
  let suspicious = 0;
  for (let i = 0; i < n; i++) {
    const c = buf[i];
    if (c === 0) return true;
    if (c < 7 || (c > 13 && c < 32 && c !== 27)) suspicious++;
  }
  return n > 0 && suspicious / n > 0.3;
}

function readText(p, maxBytes) {
  const s = statSafe(p);
  if (!s || !s.isFile()) throw new Error(`Not a file: ${toPosix(p)}`);
  if (maxBytes && s.size > maxBytes) {
    // Read only the head to keep memory bounded.
    const fd = fs.openSync(p, 'r');
    try {
      const buf = Buffer.alloc(maxBytes);
      const n = fs.readSync(fd, buf, 0, maxBytes, 0);
      return { text: buf.subarray(0, n).toString('utf8'), truncated: true, size: s.size };
    } finally { fs.closeSync(fd); }
  }
  const buf = fs.readFileSync(p);
  if (looksBinary(buf)) return { text: null, binary: true, size: s.size };
  return { text: buf.toString('utf8'), truncated: false, size: s.size };
}

function humanSize(n) {
  if (n == null) return '?';
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)}KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1048576).toFixed(1)}MB`;
  return `${(n / 1073741824).toFixed(2)}GB`;
}

function countLines(text) {
  if (!text) return 0;
  let n = 1;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
  if (text.endsWith('\n')) n--;
  return n;
}

/**
 * Walk a directory tree with sane defaults for code repos.
 * opts: { maxEntries, maxDepth, timeBudgetMs, ignoreDirs, includeHidden, filter(rel) }
 * Returns { files: [{abs, rel, size, mtimeMs, ext, depth}], dirs: Map(rel -> count), truncated, elapsedMs }
 */
function walk(root, opts = {}) {
  const maxEntries = opts.maxEntries || 6000;
  const maxDepth = opts.maxDepth || 12;
  const budget = opts.timeBudgetMs || 2500;
  const ignore = new Set([...IGNORE_DIRS, ...(opts.ignoreDirs || [])]);
  const t0 = Date.now();
  const files = [];
  const dirs = new Map();
  let truncated = false;
  const gitignore = readGitignore(root);
  const stack = [{ abs: root, rel: '', depth: 0 }];
  while (stack.length) {
    if (files.length >= maxEntries || Date.now() - t0 > budget) { truncated = true; break; }
    const cur = stack.pop();
    let entries;
    try { entries = fs.readdirSync(cur.abs, { withFileTypes: true }); } catch { continue; }
    let count = 0;
    for (const e of entries) {
      const name = e.name;
      if (!opts.includeHidden && name.startsWith('.') && name !== '.claude' && name !== '.github') continue;
      const rel = cur.rel ? `${cur.rel}/${name}` : name;
      if (e.isDirectory()) {
        if (ignore.has(name) || ignore.has(rel) || gitignore.matchesDir(rel) || isVirtualEnv(path.join(cur.abs, name))) continue;
        if (cur.depth + 1 <= maxDepth) stack.push({ abs: path.join(cur.abs, name), rel, depth: cur.depth + 1 });
        continue;
      }
      if (!e.isFile()) continue;
      if (gitignore.matchesFile(rel)) continue;
      if (opts.filter && !opts.filter(rel)) continue;
      const abs = path.join(cur.abs, name);
      const st = statSafe(abs);
      if (!st) continue;
      const ext = path.extname(name).toLowerCase();
      files.push({ abs, rel, size: st.size, mtimeMs: st.mtimeMs, ext, depth: cur.depth, name });
      count++;
      if (files.length >= maxEntries) { truncated = true; break; }
    }
    dirs.set(cur.rel || '.', count);
  }
  return { files, dirs, truncated, elapsedMs: Date.now() - t0 };
}

/**
 * Small .gitignore reader: plain names, dir/ suffixes, leading '/', '*' and '**' globs, and '!'
 * negations (last matching rule wins, as in git). Nested .gitignore files are not read.
 */
function readGitignore(root) {
  const rules = [];
  try {
    const txt = fs.readFileSync(path.join(root, '.gitignore'), 'utf8');
    for (let line of txt.split(/\r?\n/)) {
      line = line.trim();
      if (!line || line.startsWith('#')) continue;
      const neg = line.startsWith('!');
      if (neg) line = line.slice(1);
      const dirOnly = line.endsWith('/');
      if (dirOnly) line = line.slice(0, -1);
      const anchored = line.startsWith('/') || (line.includes('/') && !line.startsWith('**/'));
      if (line.startsWith('/')) line = line.slice(1);
      if (!line) continue;
      rules.push({ re: globToRegExp(line), dirOnly, anchored, neg, raw: line });
    }
  } catch { /* no .gitignore */ }
  const matchRule = (r, rel, isDirectory) => {
    const base = rel.split('/').pop();
    if (r.dirOnly && !isDirectory) {
      // a directory rule also covers everything beneath a matching directory
      const parts = rel.split('/');
      for (let i = 0; i < parts.length - 1; i++) {
        const upto = parts.slice(0, i + 1).join('/');
        if (r.anchored ? r.re.test(upto) : (r.re.test(parts[i]) || r.re.test(upto))) return true;
      }
      return false;
    }
    if (r.anchored) return r.re.test(rel);
    return r.re.test(base) || r.re.test(rel);
  };
  const test = (rel, isDirectory) => {
    if (!rules.length) return false;
    let ignored = false;
    for (const r of rules) if (matchRule(r, rel, isDirectory)) ignored = !r.neg;
    return ignored;
  };
  return {
    matchesDir: (rel) => test(rel, true),
    matchesFile: (rel) => test(rel, false),
    ruleCount: rules.length,
  };
}

function globToRegExp(glob) {
  let re = '^';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') { re += '.*'; i++; if (glob[i + 1] === '/') i++; }
      else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if ('.+^${}()|[]\\'.includes(c)) re += '\\' + c;
    else re += c;
  }
  return new RegExp(re + '$');
}

/** Simple include/exclude matcher for tool args like "*.js", "src/**", "*.{js,ts}". */
function makeGlobMatcher(pattern) {
  if (!pattern) return () => true;
  const alts = expandBraces(String(pattern));
  const res = alts.map((g) => {
    const anchored = g.includes('/');
    return { re: globToRegExp(g.replace(/^\.\//, '')), anchored };
  });
  return (rel) => {
    const base = rel.split('/').pop();
    return res.some(({ re, anchored }) => (anchored ? re.test(rel) : (re.test(base) || re.test(rel))));
  };
}

function expandBraces(s, limit = 64) {
  const m = /\{([^{}]*)\}/.exec(s);
  if (!m) return [s];
  const out = [];
  for (const alt of m[1].split(',')) {
    out.push(...expandBraces(s.slice(0, m.index) + alt + s.slice(m.index + m[0].length), limit));
    if (out.length >= limit) break;
  }
  return out.slice(0, limit);
}

/**
 * Real path of `p` with symlinks resolved, even when the leaf does not exist yet: the deepest
 * existing ancestor is resolved and the remainder re-joined. Used to judge where a path really
 * points before comparing it with the project root.
 */
function realpathDeep(p) {
  let cur = path.resolve(p);
  const tail = [];
  for (let i = 0; i < 64; i++) {
    try { const real = fs.realpathSync.native(cur); return tail.length ? path.join(real, ...[...tail].reverse()) : real; } catch { /* not there yet */ }
    const parent = path.dirname(cur);
    if (parent === cur) return path.resolve(p);
    tail.push(path.basename(cur));
    cur = parent;
  }
  return path.resolve(p);
}

/** Make `d` (mode 0700) and, on POSIX, refuse it unless this user owns it: a shared temp path another user pre-created is not ours. */
function privateDir(d) {
  try { fs.mkdirSync(d, { recursive: true, mode: 0o700 }); } catch { /* ignore */ }
  if (process.platform !== 'win32' && typeof process.getuid === 'function') {
    try { const st = fs.lstatSync(d); if (!st.isDirectory() || st.uid !== process.getuid()) return null; } catch { return null; }
  }
  return d;
}

let tmpCache = null;
/** Per-user temp directory for the checkers' scratch files (never the shared /tmp/claude-turbo of old). */
function tmpDir() {
  if (tmpCache) return tmpCache;
  let user = 'user';
  try { user = os.userInfo().username.replace(/[^\w.-]/g, '_'); } catch { /* ignore */ }
  tmpCache = privateDir(path.join(os.tmpdir(), `claude-turbo-${user}`)) || fs.mkdtempSync(path.join(os.tmpdir(), 'claude-turbo-'));
  return tmpCache;
}

/**
 * Where hooks, the MCP server and the tidy/stats scripts keep state: CLAUDE_PLUGIN_DATA when Claude
 * Code provides it, else a private per-user cache directory (never a world-shared temp path).
 */
function dataDir() {
  const env = process.env.CLAUDE_PLUGIN_DATA && process.env.CLAUDE_PLUGIN_DATA.trim();
  if (env) { try { fs.mkdirSync(env, { recursive: true }); } catch { /* ignore */ } return env; }
  const base = process.platform === 'win32'
    ? path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'claude-turbo')
    : path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'claude-turbo');
  return privateDir(base) || tmpDir();
}

/** Find the project root: explicit env, else walk up from `start` looking for .git / package.json / CLAUDE.md. */
function findProjectRoot(start) {
  if (process.env.CLAUDE_PROJECT_DIR && isDir(process.env.CLAUDE_PROJECT_DIR)) return path.resolve(process.env.CLAUDE_PROJECT_DIR);
  let dir = path.resolve(start || process.cwd());
  for (let i = 0; i < 40; i++) {
    for (const marker of ['.git', 'CLAUDE.md', '.claude', 'package.json', 'pyproject.toml', 'go.mod', 'Cargo.toml']) {
      if (exists(path.join(dir, marker))) return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.resolve(start || process.cwd());
}

module.exports = {
  IGNORE_DIRS, BINARY_EXT, LOCKFILES,
  statSafe, exists, isDir, isFile, normPath, toPosix, relDisplay, looksBinary, readText,
  humanSize, countLines, walk, readGitignore, globToRegExp, makeGlobMatcher, expandBraces,
  tmpDir, dataDir, findProjectRoot, realpathDeep,
};
