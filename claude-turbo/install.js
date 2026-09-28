#!/usr/bin/env node
'use strict';
// Turbo installer: registers this folder as a local Claude Code plugin marketplace,
// installs the "turbo" plugin at user scope (so it is active in every project), and
// optionally adds a small permission allowlist so Claude stops asking about safe,
// read-only Turbo tools and common check commands.
//
//   node install.js                 install / update
//   node install.js --no-permissions   skip the settings.json allowlist
//   node install.js --in-place      use this folder directly instead of copying to ~/.claude/turbo-kit
//   node install.js --with-playwright  also install Playwright + Chromium for /turbo:smoke
//   node install.js --uninstall     remove plugin, marketplace and the allowlist entries added here
//   node install.js --dry-run       show what would happen

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const args = new Set(process.argv.slice(2));
const DRY = args.has('--dry-run');
const WIN = process.platform === 'win32';
const HOME = os.homedir();
const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(HOME, '.claude');
const KIT_SRC = __dirname;
const KIT_DEST = args.has('--in-place') ? KIT_SRC : path.join(CLAUDE_DIR, 'turbo-kit');
const MARKETPLACE = 'turbo-local';
const PLUGIN = 'turbo';
const STATE_FILE = path.join(CLAUDE_DIR, 'turbo-kit.installed.json');

// The same rules are emitted for the Bash tool and for the PowerShell tool (Windows without Git
// Bash routes every shell command through the PowerShell tool, where Bash(...) rules never match).
const TOOLS = ['repo_map', 'file_outline', 'find_symbol', 'read_range', 'search', 'syntax_check', 'file_stats'];
const CHECK_CMDS = ['node --check *', 'npm test *', 'npm run test *', 'npm run lint *', 'npm run build *', 'pytest *', 'python -m pytest *', 'python -m py_compile *', 'py -m py_compile *'];
const RISKY_CMDS = ['git push --force *', 'git push -f *', 'git reset --hard *', 'git clean *'];
const both = (cmds) => cmds.flatMap((c) => [`Bash(${c})`, `PowerShell(${c})`]);
const ALLOW_RULES = ['mcp__plugin_turbo_code', ...TOOLS.map((t) => `mcp__plugin_turbo_code__${t}`), ...both(CHECK_CMDS)];
const ASK_RULES = both(RISKY_CMDS);

const log = (...a) => console.log(...a);
const step = (s) => log(`\n== ${s}`);
const die = (msg, code = 1) => { console.error(`\nERROR: ${msg}`); process.exit(code); };

// cmd.exe quoting: wrap in double quotes; embedded quotes are doubled (cmd does not understand \").
function q(a) { return /[\s"]/.test(a) ? `"${a.replace(/"/g, '""')}"` : a; }

function run(cmd, cmdArgs, { timeout = 120000, quiet = false, cwd, always = false } = {}) {
  const shown = `${cmd} ${cmdArgs.join(' ')}`;
  if (DRY && !always) { log(`   [dry-run] ${shown}`); return { status: 0, stdout: '', stderr: '' }; }
  // On Windows a shell is needed only to resolve bare names and npm .cmd shims (claude, npm, npx);
  // real executables (node.exe, claude.exe) are spawned directly so paths with spaces stay intact.
  const useShell = WIN && !/\.exe$/i.test(cmd) && cmd !== process.execPath;
  const file = useShell ? q(cmd) : cmd;
  const r = spawnSync(file, useShell ? cmdArgs.map(q) : cmdArgs, { encoding: 'utf8', timeout, shell: useShell, windowsHide: true, cwd, env: { ...process.env, CLAUDE_CODE_SKIP_PLUGIN_MCP_SERVERS: undefined } });
  if (!quiet) {
    const out = `${r.stdout || ''}${r.stderr || ''}`.trim();
    if (out) log(out.split('\n').map((l) => `   ${l}`).join('\n'));
  }
  return r;
}

function findClaude() {
  const candidates = ['claude'];
  if (WIN) candidates.push(path.join(HOME, '.local', 'bin', 'claude.exe'), path.join(process.env.APPDATA || '', 'npm', 'claude.cmd'), path.join(process.env.LOCALAPPDATA || '', 'Programs', 'claude', 'claude.exe'));
  else candidates.push(path.join(HOME, '.local', 'bin', 'claude'), '/usr/local/bin/claude', '/opt/homebrew/bin/claude');
  for (const c of candidates) {
    if (c !== 'claude' && !fs.existsSync(c)) continue;
    const r = run(c, ['--version'], { timeout: 30000, quiet: true, always: true });
    if (r.status === 0 && /\d+\.\d+/.test(r.stdout || '')) return { cmd: c, version: (r.stdout || '').trim().split('\n')[0] };
  }
  return null;
}

function readJSON(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return fallback; throw e; }
}

function copyKit() {
  const src = path.resolve(KIT_SRC), dest = path.resolve(KIT_DEST);
  const same = (a, b) => (WIN ? a.toLowerCase() === b.toLowerCase() : a === b);
  const inside = (a, b) => (WIN ? a.toLowerCase() : a).startsWith((WIN ? b.toLowerCase() : b) + path.sep);
  if (same(src, dest) || inside(dest, src)) { log(`   using kit in place: ${src}`); return src; }
  log(`   copying kit to ${dest}`);
  if (DRY) return dest;
  fs.mkdirSync(dest, { recursive: true });
  fs.cpSync(src, dest, { recursive: true, force: true, filter: (p) => !/[\\/](\.git|node_modules)([\\/]|$)/.test(p) });
  return dest;
}

function backupSettings(settingsPath) {
  if (!fs.existsSync(settingsPath)) return;
  const original = `${settingsPath}.turbo-original.bak`;
  if (!fs.existsSync(original)) fs.copyFileSync(settingsPath, original); // first-ever state, kept forever
  fs.copyFileSync(settingsPath, `${settingsPath}.turbo-last.bak`);        // state before the latest run
}

function mergePermissions(settingsPath) {
  let settings;
  try { settings = readJSON(settingsPath, {}); } catch (e) { log(`   skipped: ${settingsPath} is not valid JSON (${e.message}); fix it and re-run, or use --no-permissions`); return { added: [], askAdded: [] }; }
  if (typeof settings !== 'object' || settings === null || Array.isArray(settings)) { log('   skipped: settings.json is not an object'); return { added: [], askAdded: [] }; }
  settings.permissions = settings.permissions || {};
  settings.permissions.allow = Array.isArray(settings.permissions.allow) ? settings.permissions.allow : [];
  settings.permissions.ask = Array.isArray(settings.permissions.ask) ? settings.permissions.ask : [];
  const deny = new Set(Array.isArray(settings.permissions.deny) ? settings.permissions.deny : []);
  const added = [], askAdded = [];
  for (const r of ALLOW_RULES) if (!settings.permissions.allow.includes(r) && !deny.has(r)) { settings.permissions.allow.push(r); added.push(r); }
  for (const r of ASK_RULES) if (!settings.permissions.ask.includes(r) && !settings.permissions.allow.includes(r) && !deny.has(r)) { settings.permissions.ask.push(r); askAdded.push(r); }
  if (!added.length && !askAdded.length) { log('   allowlist already present, nothing to add'); return { added, askAdded }; }
  if (!DRY) {
    backupSettings(settingsPath);
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
  }
  log(`   allow += ${added.length} rule(s): ${added.join(', ')}`);
  if (askAdded.length) log(`   ask   += ${askAdded.length} rule(s): ${askAdded.join(', ')}`);
  log(`   (backups: settings.json.turbo-original.bak and settings.json.turbo-last.bak next to it)`);
  return { added, askAdded };
}

function removePermissions(settingsPath, state) {
  let settings;
  try { settings = readJSON(settingsPath, null); } catch { return; }
  if (!settings || !settings.permissions) return;
  const rm = (list, rules) => Array.isArray(list) ? list.filter((r) => !rules.includes(r)) : list;
  settings.permissions.allow = rm(settings.permissions.allow, state.allowAdded || []);
  settings.permissions.ask = rm(settings.permissions.ask, state.askAdded || []);
  if (!DRY) fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
  log(`   removed ${(state.allowAdded || []).length} allow and ${(state.askAdded || []).length} ask rule(s) that this installer had added`);
}

function registerViaSettings(settingsPath) {
  // Fallback when the `claude plugin` CLI is unavailable: declare the marketplace and enable the plugin in settings.
  let settings;
  try { settings = readJSON(settingsPath, {}); } catch (e) { die(`${settingsPath} is not valid JSON: ${e.message}`); }
  settings.extraKnownMarketplaces = settings.extraKnownMarketplaces || {};
  settings.extraKnownMarketplaces[MARKETPLACE] = { source: { source: 'directory', path: KIT_DEST } };
  settings.enabledPlugins = settings.enabledPlugins || {};
  settings.enabledPlugins[`${PLUGIN}@${MARKETPLACE}`] = true;
  if (!DRY) {
    backupSettings(settingsPath);
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
  }
  log(`   wrote extraKnownMarketplaces.${MARKETPLACE} and enabledPlugins["${PLUGIN}@${MARKETPLACE}"] to ${settingsPath}`);
}

function main() {
  log('Turbo for Claude Code — installer');
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 18) die(`Node.js 18 or newer is required (found ${process.version}). Install the LTS from https://nodejs.org and re-run.`);
  const settingsPath = path.join(CLAUDE_DIR, 'settings.json');

  if (args.has('--uninstall')) {
    step('Uninstall');
    const claude = findClaude();
    const state = readJSON(STATE_FILE, {});
    if (claude) {
      run(claude.cmd, ['plugin', 'uninstall', PLUGIN]);
      run(claude.cmd, ['plugin', 'marketplace', 'remove', MARKETPLACE]);
    } else log('   claude CLI not found; removing settings entries only');
    try {
      const s = readJSON(settingsPath, null);
      if (s) {
        if (s.extraKnownMarketplaces) delete s.extraKnownMarketplaces[MARKETPLACE];
        if (s.enabledPlugins) delete s.enabledPlugins[`${PLUGIN}@${MARKETPLACE}`];
        if (!DRY) fs.writeFileSync(settingsPath, JSON.stringify(s, null, 2) + '\n');
      }
    } catch { /* ignore */ }
    removePermissions(settingsPath, state);
    if (!DRY) { try { fs.unlinkSync(STATE_FILE); } catch { /* ignore */ } }
    log(`\nDone. The kit folder ${KIT_DEST} was left in place; delete it if you no longer need it.`);
    return;
  }

  step('1/5 Checking Claude Code');
  const claude = findClaude();
  if (claude) log(`   found ${claude.cmd} (${claude.version})`);
  else log('   claude CLI not found on PATH; will register the plugin through settings.json instead (Claude Code picks it up at next start)');

  step('2/5 Placing the kit');
  const kitDir = copyKit();
  const pluginDir = path.join(kitDir, 'plugins', PLUGIN);
  if (!DRY && !fs.existsSync(path.join(pluginDir, '.claude-plugin', 'plugin.json'))) die(`plugin manifest missing at ${pluginDir}`);

  step('3/5 Self-test');
  const st = run(process.execPath, [path.join(pluginDir, 'mcp', 'server.js'), '--selftest'], { timeout: 60000 });
  if (!DRY && st.status !== 0) die('the Turbo MCP server self-test failed (see output above)');

  step('4/5 Registering the plugin (user scope, all projects)');
  let registered = false;
  if (claude) {
    const v = run(claude.cmd, ['plugin', 'validate', pluginDir], { quiet: true });
    if (v.status !== 0) log(`   warning: plugin validate exit ${v.status}: ${(v.stdout + v.stderr).trim().split('\n').slice(-3).join(' | ')}`);
    // A plugin from a directory marketplace loads in place, so a re-run only needs the marketplace
    // refreshed; a previous installation is kept (uninstalling would also delete its data dir).
    const listed = run(claude.cmd, ['plugin', 'list'], { quiet: true });
    const already = new RegExp(`\\b${PLUGIN}@${MARKETPLACE}\\b`).test(listed.stdout || '');
    let add;
    if (already) {
      log('   previous installation found, refreshing it');
      add = run(claude.cmd, ['plugin', 'marketplace', 'update', MARKETPLACE]);
      if (add.status !== 0) add = run(claude.cmd, ['plugin', 'marketplace', 'add', kitDir]);
    } else {
      add = run(claude.cmd, ['plugin', 'marketplace', 'add', kitDir]);
      if (add.status !== 0 && /already|exists/i.test(`${add.stdout}${add.stderr}`)) add = run(claude.cmd, ['plugin', 'marketplace', 'update', MARKETPLACE]);
    }
    if (add.status === 0) {
      let inst = already ? run(claude.cmd, ['plugin', 'update', PLUGIN]) : run(claude.cmd, ['plugin', 'install', `${PLUGIN}@${MARKETPLACE}`, '--scope', 'user']);
      if (inst.status !== 0 && /already installed|already at the latest|up to date/i.test(`${inst.stdout}${inst.stderr}`)) inst = { status: 0 };
      if (inst.status !== 0 && already) inst = run(claude.cmd, ['plugin', 'install', `${PLUGIN}@${MARKETPLACE}`, '--scope', 'user']);
      registered = inst.status === 0 || DRY;
      if (!registered) log(`   plugin install failed (exit ${inst.status})`);
    } else log(`   marketplace add failed (exit ${add.status})`);
  }
  if (!registered) {
    log('   falling back to settings.json registration');
    registerViaSettings(settingsPath);
    registered = true;
  }

  step('5/5 Permissions');
  let perms = { added: [], askAdded: [] };
  if (args.has('--no-permissions')) log('   skipped (--no-permissions)');
  else perms = mergePermissions(settingsPath);

  if (args.has('--with-playwright')) {
    step('Optional: Playwright for /turbo:smoke');
    run(WIN ? 'npm.cmd' : 'npm', ['install', '-g', 'playwright'], { timeout: 600000 });
    run(WIN ? 'npx.cmd' : 'npx', ['playwright', 'install', 'chromium'], { timeout: 900000 });
  }

  if (!DRY) {
    const prev = readJSON(STATE_FILE, {});
    const union = (a, b) => [...new Set([...(a || []), ...(b || [])])];
    fs.writeFileSync(STATE_FILE, JSON.stringify({ installedAt: new Date().toISOString(), kit: kitDir, allowAdded: union(prev.allowAdded, perms.added), askAdded: union(prev.askAdded, perms.askAdded) }, null, 2));
  }

  if (claude && !DRY) {
    const ls = run(claude.cmd, ['plugin', 'list'], { quiet: true });
    const line = (ls.stdout || '').split('\n').find((l) => /turbo/.test(l));
    log(`\n   plugin list: ${line ? line.trim() : '(turbo not shown yet; it appears after the next Claude Code start)'}`);
  }

  log(`
${DRY ? 'Dry run complete (nothing was changed).' : 'Installed.'}

Next:
  1. Open a terminal in any project and run: claude
  2. Type /turbo:help to see what is available, or /turbo:map to get oriented in that project.
  3. Hooks run automatically: syntax checks after every edit, a stop-time verification, and guards for
     risky writes and commands. The MCP server "code" is listed by /mcp as plugin:turbo:code.

Update later: run this installer again from the new kit folder (it refreshes the installed copy).
Uninstall:    node "${path.join(kitDir, 'install.js')}" --uninstall
`);
}

try { main(); } catch (e) { die(e && e.stack || String(e)); }
