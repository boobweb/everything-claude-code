#!/usr/bin/env node
'use strict';
// SessionStart hook: give Claude a compact, factual briefing about the project so it
// starts oriented instead of spending its first minutes (and tokens) rediscovering
// the repo. Runs on startup, resume, clear and after compaction.

const fs = require('fs');
const path = require('path');
const fsx = require('../lib/fsx');
const git = require('../lib/git');
const stack = require('../lib/stack');
const { blobMap } = require('../lib/fold');
const io = require('../lib/hookio');

const PLUGIN_VERSION = (() => { try { return require('../.claude-plugin/plugin.json').version; } catch { return '?'; } })();

io.main(async (input) => {
  const cwd = input.cwd && fsx.isDir(input.cwd) ? input.cwd : process.cwd();
  const root = fsx.findProjectRoot(cwd);
  const source = input.source || 'startup';
  const lines = [];
  const t0 = Date.now();

  // Open the session state now so the Stop hook knows when this session began.
  if (input.session_id) { const st = io.loadSession(input.session_id); io.saveSession(input.session_id, st); }

  lines.push(`Turbo session brief (plugin turbo v${PLUGIN_VERSION}, ${source}). Project root: ${fsx.toPosix(root)}${fsx.toPosix(root) !== fsx.toPosix(cwd) ? ` (cwd ${fsx.toPosix(cwd)})` : ''}. Platform: ${process.platform}${process.platform === 'win32' ? ' (Windows: file paths in tool payloads use backslashes; Bash tool may be PowerShell if Git Bash is absent)' : ''}.`);

  // Stack
  const st = stack.detect(root);
  lines.push(`Stack: ${st.summary}.${st.commands.length ? ` Likely check commands: ${st.commands.join(' · ')}.` : ''}${st.claude.length ? ` Claude config present: ${st.claude.join(', ')}.` : ' No CLAUDE.md or .claude/ config in this project yet.'}`);

  // Git
  const g = git.info(root);
  if (g) {
    const ab = g.aheadBehind ? ` (${g.aheadBehind.ahead} ahead, ${g.aheadBehind.behind} behind upstream)` : '';
    lines.push(`Git: branch ${g.branch || '?'}${ab}; working tree: ${g.statusUnavailable ? 'status unavailable (git status timed out)' : g.total === 0 ? 'clean' : `${g.total} changed (${g.staged} staged, ${g.modified} modified, ${g.untracked} untracked)`}.${g.changed.length ? ` Changed: ${g.changed.join(', ')}${g.total > g.changed.length ? `, +${g.total - g.changed.length} more` : ''}.` : ''}`);
    if (g.log.length) lines.push(`Recent commits: ${g.log.slice(0, 5).join(' | ')}`);
  } else {
    lines.push('Git: not a git repository (no checkpoints beyond Claude Code file checkpointing).');
  }

  // Layout: top-level entries with counts, plus largest source files.
  try {
    const w = fsx.walk(root, { maxDepth: 6, maxEntries: 4000, timeBudgetMs: 1500 });
    const top = new Map();
    for (const f of w.files) {
      const seg = f.rel.includes('/') ? f.rel.split('/')[0] + '/' : f.rel;
      top.set(seg, (top.get(seg) || 0) + 1);
    }
    const entries = [...top.entries()].sort((a, b) => b[1] - a[1]).slice(0, 18).map(([k, v]) => (k.endsWith('/') ? `${k} (${v})` : k));
    lines.push(`Layout${w.truncated ? ' (partial scan)' : ''}: ${entries.join(', ')}${top.size > 18 ? `, +${top.size - 18} more` : ''}.`);
    const big = w.files.filter((f) => !fsx.BINARY_EXT.has(f.ext) && !fsx.LOCKFILES.has(f.name) && f.size >= 150 * 1024).sort((a, b) => b.size - a.size).slice(0, 4);
    if (big.length) {
      const descs = big.map((f) => {
        let extra = '';
        if (f.size >= 700 * 1024 && f.size <= 64 * 1024 * 1024 && /\.(html?|js|mjs|cjs|css|json|md|txt|ts)$/i.test(f.name)) {
          try {
            const txt = fs.readFileSync(f.abs, 'utf8');
            const bm = blobMap(txt, { threshold: 1000, maxItems: 3 });
            if (bm.pct >= 10) extra = `, ${bm.pct}% embedded blobs in ${bm.blobLines} line${bm.blobLines === 1 ? '' : 's'}`;
          } catch { /* ignore */ }
        }
        return `${f.rel} ${fsx.humanSize(f.size)}${extra}`;
      });
      lines.push(`Large text files (read them through Turbo's indexed tools, not whole): ${descs.join('; ')}.`);
    }
  } catch { /* layout is best effort */ }

  // Handoff note from a previous session
  try {
    const hp = path.join(root, '.claude', 'turbo-handoff.md');
    if (fsx.isFile(hp)) {
      const txt = fs.readFileSync(hp, 'utf8').trim();
      const stat = fsx.statSafe(hp);
      const age = stat ? Math.round((Date.now() - stat.mtimeMs) / 3600000) : null;
      lines.push(`Handoff note from the previous session (.claude/turbo-handoff.md${age != null ? `, ${age < 48 ? `${age}h` : `${Math.round(age / 24)}d`} old` : ''}):\n${txt.length > 1500 ? txt.slice(0, 1500) + '\n…(truncated; the file has the rest)' : txt}`);
    }
  } catch { /* ignore */ }

  // Toolkit reminder (facts, not commands)
  lines.push([
    'Turbo toolkit facts: the MCP server "code" (tools mcp__plugin_turbo_code__repo_map, file_outline, find_symbol, read_range, search, syntax_check, file_stats) returns line-numbered outlines and bounded slices of any file, folds base64/minified blobs, and is the cheap way to navigate large files (>100KB) and unfamiliar repos.',
    'Hooks in this plugin run a syntax/integrity check automatically after every Edit or Write (JS via node --check, HTML inline scripts, JSON, Python, CSS, PowerShell, shell, TypeScript when installed) and report failures next to the tool result, so separate manual syntax runs are redundant; a Stop-time check re-verifies every file edited in the session; a guard asks before a Write that shrinks or replaces a large file and before destructive shell commands.',
    'Skills: /turbo:map (orient), /turbo:patch (surgical edits in big files), /turbo:debug (triage protocol), /turbo:verify (run the project\'s checks), /turbo:smoke (headless browser boot test for web apps), /turbo:handoff (write the next-session note), /turbo:perf, /turbo:release, /turbo:setup. Subagents: turbo:verifier (independent proof a change works), turbo:reviewer (regression review of a diff), turbo:smoke-tester.',
  ].join(' '));

  const text = lines.join('\n');
  io.log(`brief ${text.length} chars in ${Date.now() - t0}ms`);
  io.emit({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: text.slice(0, 9500) } });
  return 0;
});
