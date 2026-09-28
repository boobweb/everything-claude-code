#!/usr/bin/env node
'use strict';
// PostToolUse hook (Edit | Write | MultiEdit): syntax-check the file that was just
// edited and, if it is broken, tell Claude immediately with the exact line. Records
// the file in the session state so the Stop hook can re-verify at the end.

const fsx = require('../lib/fsx');
const check = require('../lib/check');
const io = require('../lib/hookio');

io.main(async (input) => {
  const file = io.editedPath(input);
  if (!file || !check.isCheckable(file) || !fsx.isFile(file)) return 0;
  const cwd = input.cwd && fsx.isDir(input.cwd) ? input.cwd : process.cwd();
  const root = fsx.findProjectRoot(cwd);
  const res = check.checkFile(file, { root });

  const sid = input.session_id || 'unknown';
  const state = io.loadSession(sid);
  state.edited = state.edited || {};
  state.edited[file] = { ok: res.ok, skipped: res.skipped || null, errors: res.errors.length, ts: Date.now(), verifiedAt: Date.now(), tool: input.tool_name };
  io.saveSession(sid, state);

  if (res.ok) {
    io.log(`ok ${file} (${res.checker}, ${res.ms}ms)`);
    return 0; // silent on success: no context cost
  }
  const formatted = check.formatResult(res, root);
  const reason = [
    `Turbo check: the file is broken after this ${input.tool_name || 'edit'} (${res.checker}).`,
    formatted,
    'The edit was applied; fix the syntax error before doing anything else (usually the last change introduced it: an unbalanced brace/bracket, a stray or missing comma, quote or colon).',
  ].join('\n');
  io.emit({ decision: 'block', reason: reason.slice(0, 9000) });
  return 0;
});
