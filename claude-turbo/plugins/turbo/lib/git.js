'use strict';
// Read-only git helpers with hard timeouts. Never throw.

const { spawnSync } = require('child_process');
const path = require('path');
const fsx = require('./fsx');

function git(args, cwd, timeout = 3000) {
  try {
    const r = spawnSync('git', args, { cwd, encoding: 'utf8', timeout, windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
    if (r.error || r.status !== 0) return null;
    return r.stdout;
  } catch { return null; }
}

function isRepo(cwd) {
  let dir = path.resolve(cwd);
  for (let i = 0; i < 30; i++) {
    if (fsx.exists(path.join(dir, '.git'))) return true;
    const p = path.dirname(dir);
    if (p === dir) return false;
    dir = p;
  }
  return false;
}

/** Compact snapshot: branch, counts, changed files, last commits. */
function info(cwd, { maxFiles = 12, commits = 5 } = {}) {
  if (!isRepo(cwd)) return null;
  const branch = (git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd) || '').trim() || null;
  const status = git(['status', '--porcelain=v1', '--untracked-files=normal'], cwd, 5000);
  const changed = [];
  let untracked = 0, modified = 0, staged = 0;
  if (status != null) {
    for (const line of status.split(/\r?\n/)) {
      if (!line.trim()) continue;
      const x = line[0], y = line[1];
      const file = line.slice(3).trim();
      if (x === '?' && y === '?') { untracked++; if (changed.length < maxFiles) changed.push(`?? ${file}`); continue; }
      if (x !== ' ' && x !== '?') staged++;
      if (y !== ' ') modified++;
      if (changed.length < maxFiles) changed.push(`${x}${y} ${file}`);
    }
  }
  const total = (status || '').split(/\r?\n/).filter((l) => l.trim()).length;
  const log = git(['log', `-${commits}`, '--format=%h %s (%cr)'], cwd) || '';
  const upstream = git(['rev-list', '--left-right', '--count', 'HEAD...@{upstream}'], cwd);
  let aheadBehind = null;
  if (upstream) { const [a, b] = upstream.trim().split(/\s+/); aheadBehind = { ahead: Number(a) || 0, behind: Number(b) || 0 }; }
  return { branch, staged, modified, untracked, total, changed, statusUnavailable: status == null, log: log.trim().split(/\r?\n/).filter(Boolean), aheadBehind };
}

/** Files changed vs HEAD plus untracked (for the Stop-time verification). */
function changedFiles(cwd, limit = 60) {
  if (!isRepo(cwd)) return [];
  const out = new Set();
  // -z: NUL-separated and unquoted, so "caf\303\251.js"-style quoting never produces a path that does not exist
  const a = git(['diff', '--name-only', '-z', 'HEAD'], cwd, 5000) || git(['diff', '--name-only', '-z'], cwd, 5000) || '';
  const b = git(['ls-files', '--others', '--exclude-standard', '-z'], cwd, 5000) || '';
  const root = (git(['rev-parse', '--show-toplevel'], cwd) || cwd).trim();
  for (const l of (a + '\0' + b).split('\0')) {
    const f = l.trim();
    if (!f) continue;
    out.add(path.resolve(root, f));
    if (out.size >= limit) break;
  }
  return [...out];
}

module.exports = { info, changedFiles, isRepo, git };
