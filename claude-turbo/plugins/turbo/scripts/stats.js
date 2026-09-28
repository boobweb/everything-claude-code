#!/usr/bin/env node
'use strict';
// Print the Turbo continuity record for a project: recent sessions (what they edited, how they
// ended) and the running counters. Used by /turbo:help; also handy from a terminal.
//   node stats.js [--root <project dir>] [--data <CLAUDE_PLUGIN_DATA dir>] [--json]

const path = require('path');
const fsx = require('../lib/fsx');

const argv = process.argv.slice(2);
const opt = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : null; };
if (opt('--data')) process.env.CLAUDE_PLUGIN_DATA = path.resolve(opt('--data'));
const project = require('../lib/project');

const root = fsx.findProjectRoot(opt('--root') ? path.resolve(opt('--root')) : process.cwd());
const p = project.load(root);
if (argv.includes('--json')) { process.stdout.write(JSON.stringify(p, null, 2) + '\n'); process.exit(0); }

const st = p.stats;
const out = [`Turbo record for ${fsx.toPosix(root)} (${project.fileFor(root)})`];
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
