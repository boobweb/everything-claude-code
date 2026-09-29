#!/usr/bin/env node
'use strict';
// Print the Turbo continuity record for a project: recent sessions (what they edited, how they
// ended) and the running counters. Used by /turbo:help; also handy from a terminal.
//   node stats.js [--root <project dir>] [--data <CLAUDE_PLUGIN_DATA dir>] [--json]

const path = require('path');
const fsx = require('../lib/fsx');

const fs = require('fs');
const os = require('os');
const argv = process.argv.slice(2);
const opt = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : null; };

/** --data, else CLAUDE_PLUGIN_DATA, else the installed plugin's data folder (~/.claude/plugins/data/turbo*), else the temp fallback the hooks use. */
function resolveDataDir() {
  if (opt('--data')) return path.resolve(opt('--data'));
  if (process.env.CLAUDE_PLUGIN_DATA && process.env.CLAUDE_PLUGIN_DATA.trim()) return process.env.CLAUDE_PLUGIN_DATA.trim();
  const base = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'plugins', 'data');
  try {
    const hit = fs.readdirSync(base).filter((n) => /^turbo(-|$)/.test(n)).map((n) => path.join(base, n)).find((d) => fs.existsSync(path.join(d, 'projects')));
    if (hit) return hit;
  } catch { /* no plugin data dir */ }
  return null;
}
const dataDir = resolveDataDir();
if (dataDir) process.env.CLAUDE_PLUGIN_DATA = dataDir;
const project = require('../lib/project');

const root = fsx.findProjectRoot(opt('--root') ? path.resolve(opt('--root')) : process.cwd());
const p = project.load(root);
if (argv.includes('--json')) { process.stdout.write(JSON.stringify(p, null, 2) + '\n'); process.exit(0); }

const st = p.stats;
const out = [`Turbo record for ${fsx.toPosix(root)} (${project.fileFor(root)})${dataDir ? '' : '  [no plugin data directory found: showing the temp fallback the hooks use when CLAUDE_PLUGIN_DATA is unset]'}`];
out.push(`sessions: ${st.sessions}; broken edits caught: ${st.brokenEditsCaught}; commands denied: ${st.commandsDenied}, asked: ${st.commandsAsked}; risky writes held: ${st.writesAsked}; stop-time blocks: ${st.stopBlocks}`);
const sessions = Object.entries(p.sessions).sort((a, b) => (b[1].updatedAt || 0) - (a[1].updatedAt || 0));
if (!sessions.length) out.push('no sessions recorded yet');
for (const [id, s] of sessions) {
  const files = Object.keys(s.edited || {});
  const when = new Date(s.updatedAt || s.startedAt || 0).toISOString().replace('T', ' ').slice(0, 16);
  const end = s.clean === true ? 'clean' : s.clean === false ? `broken: ${(s.broken || []).join(', ')}` : 'no Stop check recorded';
  out.push(`  ${when}  ${id.slice(0, 12).padEnd(12)}  ${files.length} file${files.length === 1 ? '' : 's'} edited${files.length ? ` (${files.slice(0, 5).join(', ')}${files.length > 5 ? ', …' : ''})` : ''}; ${end}`);
}
out.push(project.describe(p, null) || '(nothing to report yet)');
process.stdout.write(out.join('\n') + '\n');
