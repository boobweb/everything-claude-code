#!/usr/bin/env node
'use strict';
// PreToolUse hook (Bash | PowerShell): a narrow safety net for destructive commands.
// Catastrophic commands are denied; risky-but-sometimes-legit ones escalate to the user.
// Everything else passes through with zero output so it never slows Claude down.
// The analysis itself lives in lib/cmdguard.js (structural, quote- and cd-aware; see there).

const fsx = require('../lib/fsx');
const io = require('../lib/hookio');
const options = require('../lib/options');
const project = require('../lib/project');
const guard = require('../lib/cmdguard');

async function main(input) {
  const level = options.guardLevel();
  if (level === 'off') return 0;
  const cmd = String((input.tool_input && (input.tool_input.command || input.tool_input.script)) || '');
  if (!cmd.trim()) return 0;
  const norm = cmd.replace(/\\\r?\n/g, ' ').replace(/`\r?\n/g, ' ');
  const cwd = input.cwd && fsx.isDir(input.cwd) ? input.cwd : process.cwd();
  // the PowerShell tool never uses backslash escapes; the Bash tool does (also on Windows with Git Bash)
  const shell = input.tool_name === 'PowerShell' ? 'ps' : input.tool_name === 'Bash' ? 'posix' : undefined;
  const ctx = { cwd, root: fsx.findProjectRoot(cwd), shell };
  const r = guard.evaluate(norm, ctx);
  if (!r) return 0;
  if (r.decision === 'deny') {
    const reason = `Turbo guard blocked this command: ${r.why}. If this is truly required, the user must run it manually.`;
    io.emit({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } });
    project.recordGuard(ctx.root, input.session_id, 'commandsDenied');
  } else if (level === 'strict') {
    const reason = `Turbo guard: ${r.why}. Confirm before running.`;
    io.emit({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: reason, additionalContext: `${reason} If the user declines, do not retry the same command; choose a narrower, in-project alternative.` } });
    project.recordGuard(ctx.root, input.session_id, 'commandsAsked');
  }
  return 0;
}

// Only act as a hook when executed directly; tests require() the guard functions.
if (require.main === module) io.main(main);

module.exports = { ...guard, main };
