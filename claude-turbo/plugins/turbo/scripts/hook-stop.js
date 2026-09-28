#!/usr/bin/env node
'use strict';
// Stop hook: before Claude ends its turn, re-verify every file this session edited
// (plus git-modified files, which also catches edits made through shell commands).
// If anything is syntactically broken, keep Claude working with a precise report.
// Loop-safe: never blocks twice in a row (stop_hook_active) and stays under a time budget.
// The outcome (clean or not) is recorded in the project's continuity record either way.

const fsx = require('../lib/fsx');
const check = require('../lib/check');
const git = require('../lib/git');
const io = require('../lib/hookio');
const options = require('../lib/options');
const project = require('../lib/project');

// Hard cap: the user is waiting at the end of every turn. Files past the budget are skipped and
// reported as such (acorn checks are milliseconds; PowerShell/Python spawns are the slow ones).
const TIME_BUDGET_MS = 12000;
const MAX_FILES = 40;

io.main(async (input) => {
  if (!options.stopCheck()) return 0;
  const again = !!input.stop_hook_active; // second Stop after a block: re-check for the record, never block twice
  const cwd = input.cwd && fsx.isDir(input.cwd) ? input.cwd : process.cwd();
  const root = fsx.findProjectRoot(cwd);
  const sid = input.session_id || 'unknown';
  const state = io.loadSession(sid);
  const since = state.created || 0;
  const candidates = new Set(Object.keys(state.edited || {}));
  // git-modified files catch edits made through shell commands; only those touched during this session matter
  for (const f of git.changedFiles(root, 60)) { const st = fsx.statSafe(f); if (st && st.mtimeMs >= since - 1000) candidates.add(f); }
  const files = [...candidates].filter((f) => {
    if (!check.isCheckable(f) || !fsx.isFile(f)) return false;
    const prev = (state.edited || {})[f];
    const st = fsx.statSafe(f);
    // already verified OK and untouched since: nothing to re-check
    return !(prev && prev.ok && prev.verifiedAt && st && st.mtimeMs <= prev.verifiedAt);
  }).slice(0, MAX_FILES);

  const t0 = Date.now();
  const failures = [];
  const brokenRel = [];
  let checked = 0, skippedForTime = 0;
  for (const f of files) {
    if (Date.now() - t0 > TIME_BUDGET_MS) { skippedForTime++; continue; }
    const res = check.checkFile(f, { root });
    checked++;
    state.edited = state.edited || {};
    state.edited[f] = { ...(state.edited[f] || {}), ok: res.ok, skipped: res.skipped || null, errors: res.errors.length, verifiedAt: Date.now() };
    if (!res.ok) { failures.push(check.formatResult(res, root)); brokenRel.push(fsx.relDisplay(f, root)); }
  }
  // files verified earlier in this session and untouched since still count for the record
  for (const [f, prev] of Object.entries(state.edited || {})) if (prev && prev.ok === false && !brokenRel.includes(fsx.relDisplay(f, root)) && !files.includes(f) && fsx.isFile(f)) brokenRel.push(fsx.relDisplay(f, root));
  if (files.length) io.saveSession(sid, state);
  project.recordStop(root, sid, brokenRel);
  io.log(`stop-check: ${checked} files, ${failures.length} failing, ${Date.now() - t0}ms${again ? ' (stop_hook_active: record only)' : ''}`);
  if (!failures.length || again) return 0;

  const reason = [
    `Turbo stop-check: ${failures.length} file${failures.length === 1 ? ' is' : 's are'} syntactically broken at the end of this turn (checked ${checked} edited/changed file${checked === 1 ? '' : 's'}${skippedForTime ? `, ${skippedForTime} skipped for time` : ''}):`,
    ...failures,
    'Repair these before finishing. If a file is intentionally left in this state, say so explicitly to the user.',
  ].join('\n');
  io.emit({ decision: 'block', reason: reason.slice(0, 9000) });
  return 0;
});
