#!/usr/bin/env node
'use strict';
// PreToolUse hook (Write): protect large existing files from accidental truncation or
// whole-file rewrites. A Write that replaces a big file with something much smaller is
// almost always a mistake (partial content, "..." placeholders, lost sections), so the
// hook escalates to the user instead of letting it through silently.

const fsx = require('../lib/fsx');
const io = require('../lib/hookio');
const options = require('../lib/options');
const project = require('../lib/project');

const BIG = 2 * 1024 * 1024;      // a Write over a file this large always asks
const SHRINK_MIN = 48 * 1024;     // shrink check applies to files at least this large
const SHRINK_RATIO = 0.6;         // new size below 60% of old size -> ask

io.main(async (input) => {
  if (options.guardLevel() !== 'strict') return 0; // this guard only ever asks; deny-only and off skip it
  const ti = input.tool_input || {};
  const file = io.editedPath(input);
  if (!file) return 0;
  const st = fsx.statSafe(file);
  if (!st || !st.isFile()) return 0; // creating a new file is fine
  const oldSize = st.size;
  // content is always a string from Claude Code; anything else (missing, array) would write nothing useful: size 0
  const content = typeof ti.content === 'string' ? ti.content : '';
  const newSize = Buffer.byteLength(content, 'utf8');
  // Linear-time: anchored per line, no nested optional whitespace groups.
  const placeholder = /^[ \t]*(?:\/\/|#|<!--|\/\*)?[ \t]*(?:\.\.\.|…)[ \t]*(?:rest of|remaining|unchanged|same as before|existing code|other code|previous code)/im.test(content);

  let reason = null;
  if (oldSize >= BIG) {
    reason = `Turbo guard: Write would replace ${fsx.toPosix(file)} (${fsx.humanSize(oldSize)}) wholesale with ${fsx.humanSize(newSize)}. Whole-file rewrites of large files lose content easily; the Edit tool (exact old/new strings) is the safe way to change it. Approve only if a full rewrite is really intended.`;
  } else if (oldSize >= SHRINK_MIN && newSize < oldSize * SHRINK_RATIO) {
    reason = `Turbo guard: Write would shrink ${fsx.toPosix(file)} from ${fsx.humanSize(oldSize)} to ${fsx.humanSize(newSize)} (${Math.round((1 - newSize / oldSize) * 100)}% smaller). That usually means content is missing. Approve if the shrink is intentional; otherwise use Edit for targeted changes.`;
  } else if (placeholder) {
    reason = `Turbo guard: the new content for ${fsx.toPosix(file)} contains a "... rest of ..." style placeholder, which would delete the real code it stands for. Write the full content or use Edit for the specific section.`;
  }
  if (!reason) return 0;
  // permissionDecisionReason is shown to the user; additionalContext carries the same guidance to Claude.
  io.emit({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: reason, additionalContext: reason } });
  const cwd = input.cwd && fsx.isDir(input.cwd) ? input.cwd : process.cwd();
  project.recordGuard(fsx.findProjectRoot(cwd), input.session_id, 'writesAsked');
  return 0;
});
