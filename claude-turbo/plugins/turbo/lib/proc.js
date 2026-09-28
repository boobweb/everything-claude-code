'use strict';
// Process helpers shared by the checkers and the AST outliners: bounded spawnSync and cached
// probes for which python / powershell / bash to use (cached on disk for a day so every hook
// process does not pay for the probes again).

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const fsx = require('./fsx');

const NODE = process.execPath; // the node that runs this script: always available

function run(cmd, args, { timeout = 15000, input, cwd } = {}) {
  try {
    const r = spawnSync(cmd, args, {
      encoding: 'utf8', timeout, input, cwd,
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, NODE_OPTIONS: '' },
    });
    return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '', error: r.error, timedOut: r.error && r.error.code === 'ETIMEDOUT' };
  } catch (e) {
    return { status: -1, stdout: '', stderr: String(e && e.message || e), error: e };
  }
}

function which(names) {
  for (const n of names) {
    const r = run(n, ['--version'], { timeout: 4000 });
    if (!r.error && r.status === 0) return n;
  }
  return null;
}

// Probe results (which python / powershell / bash to use) are cached on disk for a day so every
// hook process does not pay for the probes again (a PowerShell start alone costs 1-2 s on Windows).
const PROBE_TTL_MS = 24 * 3600 * 1000;
function probeFile() { return path.join(fsx.dataDir(), 'probes.json'); }
// A cached value is used only when it is one of the commands the probe itself could have produced:
// the cache file lives in a data directory, and a data file must never become a command to run.
const PY_CANDIDATES = process.platform === 'win32' ? [['py', ['-3']], ['python', []], ['python3', []]] : [['python3', []], ['python', []]];
const validPython = (v) => v === null || (!!v && typeof v === 'object' && PY_CANDIDATES.some(([c, pre]) => c === v.cmd && JSON.stringify(pre) === JSON.stringify(v.pre)));
const validPowershell = (v) => v === null || v === 'pwsh' || v === 'powershell';
const validBash = (v) => v === null || v === 'bash' || (process.platform === 'win32' && typeof v === 'string' && path.isAbsolute(v) && /[\\/]bash\.exe$/i.test(v) && !/\\Windows\\(System32|Sysnative|SysWOW64)\\/i.test(v) && fs.existsSync(v));
function loadProbes() {
  try {
    const p = JSON.parse(fs.readFileSync(probeFile(), 'utf8'));
    if (!p || typeof p !== 'object' || Date.now() - (p.ts || 0) >= PROBE_TTL_MS || p.node !== process.version) return {};
    if ('python' in p && !validPython(p.python)) delete p.python;
    if ('powershell' in p && !validPowershell(p.powershell)) delete p.powershell;
    if ('bash' in p && !validBash(p.bash)) delete p.bash;
    return p;
  } catch { return {}; }
}
function saveProbe(key, value) { try { const p = loadProbes(); p[key] = value; p.ts = p.ts || Date.now(); p.node = process.version; fs.writeFileSync(probeFile(), JSON.stringify(p)); } catch { /* ignore */ } }

let pyCache;
function pythonCmd() {
  if (pyCache !== undefined) return pyCache;
  const cached = loadProbes();
  if (cached.python !== undefined) { pyCache = cached.python; return pyCache; }
  pyCache = null;
  for (const [cmd, pre] of PY_CANDIDATES) {
    const r = run(cmd, [...pre, '-c', 'import sys;print(sys.version_info[0])'], { timeout: 4000 });
    if (!r.error && r.status === 0 && r.stdout.trim().startsWith('3')) { pyCache = { cmd, pre }; break; }
  }
  saveProbe('python', pyCache);
  return pyCache;
}

let psCache;
function powershellCmd() {
  if (psCache !== undefined) return psCache;
  const cached = loadProbes();
  if (cached.powershell !== undefined) { psCache = cached.powershell; return psCache; }
  psCache = null;
  for (const c of ['pwsh', 'powershell']) {
    const r = run(c, ['-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.Major'], { timeout: 6000 });
    if (!r.error && r.status === 0) { psCache = c; break; }
  }
  saveProbe('powershell', psCache);
  return psCache;
}

let bashCache;
function bashCmd() {
  if (bashCache !== undefined) return bashCache;
  const cached = loadProbes();
  if (cached.bash !== undefined) { bashCache = cached.bash; return bashCache; }
  bashCache = null;
  if (process.platform === 'win32') {
    // C:\Windows\System32\bash.exe is the WSL launcher: it cannot read Windows paths and may block. Only Git Bash qualifies.
    const w = run('where.exe', ['bash'], { timeout: 6000 });
    const hit = (w.stdout || '').split(/\r?\n/).map((l) => l.trim()).find((l) => l && !/\\Windows\\(System32|Sysnative|SysWOW64)\\/i.test(l));
    bashCache = hit || null;
  } else {
    const r = run('bash', ['-c', 'echo ok'], { timeout: 6000 });
    bashCache = !r.error && r.status === 0 ? 'bash' : null;
  }
  saveProbe('bash', bashCache);
  return bashCache;
}


module.exports = { run, which, pythonCmd, powershellCmd, bashCmd, NODE };
