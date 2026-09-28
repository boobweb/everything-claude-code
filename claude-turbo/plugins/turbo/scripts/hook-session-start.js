#!/usr/bin/env node
'use strict';
// SessionStart hook: a short, factual briefing with only what Claude Code does not already
// provide (it already shows cwd, platform, git branch/status and recent commits). Kept here:
// the stack and its check commands, large files with embedded blobs, what the previous session
// left behind, the handoff note, and a one-line reminder of the Turbo tools. Runs on startup,
// resume, clear and after compaction. Disable with the `brief` option.

const fs = require('fs');
const path = require('path');
const fsx = require('../lib/fsx');
const stack = require('../lib/stack');
const { blobMap } = require('../lib/fold');
const io = require('../lib/hookio');
const options = require('../lib/options');

const PLUGIN_VERSION = (() => { try { return require('../.claude-plugin/plugin.json').version; } catch { return '?'; } })();
const MAX_CHARS = 4000;

io.main(async (input) => {
  const cwd = input.cwd && fsx.isDir(input.cwd) ? input.cwd : process.cwd();
  const root = fsx.findProjectRoot(cwd);
  const source = input.source || 'startup';
  const t0 = Date.now();

  // Open the session state now so the Stop hook knows when this session began.
  if (input.session_id) { const st = io.loadSession(input.session_id); io.saveSession(input.session_id, st); }
  if (!options.brief()) { io.log('brief disabled by option'); return 0; }

  const lines = [];
  const opts = options.summary();
  lines.push(`Turbo brief (plugin v${PLUGIN_VERSION}, ${source}${opts ? `; options: ${opts}` : ''}).${fsx.toPosix(root) !== fsx.toPosix(cwd) ? ` Project root: ${fsx.toPosix(root)}.` : ''}${process.platform === 'win32' ? ' Windows: without Git Bash, shell commands run through the PowerShell tool; paths in tool payloads use backslashes.' : ''}`);

  // Stack and check commands (not something Claude Code reports on its own)
  const st = stack.detect(root);
  lines.push(`Stack: ${st.summary}.${st.commands.length ? ` Checks: ${st.commands.join(' · ')}.` : ''}${st.claude.length ? ` Claude config: ${st.claude.join(', ')}.` : ''}`);

  // Large text files, with how much of them is embedded blob data
  try {
    const w = fsx.walk(root, { maxDepth: 6, maxEntries: 4000, timeBudgetMs: 1500 });
    const big = w.files.filter((f) => !fsx.BINARY_EXT.has(f.ext) && !fsx.LOCKFILES.has(f.name) && f.size >= 150 * 1024).sort((a, b) => b.size - a.size).slice(0, 4);
    if (big.length) {
      const descs = big.map((f) => {
        let extra = '';
        if (f.size >= 700 * 1024 && f.size <= 64 * 1024 * 1024 && /\.(html?|js|mjs|cjs|css|json|md|txt|ts)$/i.test(f.name)) {
          try {
            const bm = blobMap(fs.readFileSync(f.abs, 'utf8'), { threshold: 1000, maxItems: 3 });
            if (bm.pct >= 10) extra = `, ${bm.pct}% blobs in ${bm.blobLines} line${bm.blobLines === 1 ? '' : 's'}`;
          } catch { /* ignore */ }
        }
        return `${f.rel} ${fsx.humanSize(f.size)}${extra}`;
      });
      lines.push(`Large files (use file_outline/read_range, never Read whole): ${descs.join('; ')}.`);
    }
  } catch { /* best effort */ }

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

  // One line on the toolkit (facts the model needs to pick the cheap path; skills are listed by /turbo:help)
  lines.push('Turbo tools (mcp__plugin_turbo_code__repo_map, file_outline, find_symbol, read_range, search, syntax_check, file_stats) return line-numbered outlines and bounded reads with blobs folded: use them instead of reading files over ~100KB whole. Hooks syntax-check every Edit/Write and re-verify at Stop, so manual syntax runs are redundant. /turbo:help lists skills, subagents and options.');

  const text = lines.join('\n');
  io.log(`brief ${text.length} chars in ${Date.now() - t0}ms`);
  io.emit({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: text.slice(0, MAX_CHARS) } });
  return 0;
});
