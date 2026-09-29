'use strict';
// Hook plumbing: read the JSON payload Claude Code pipes on stdin, write a JSON reply,
// keep per-session state, and never crash the host (a broken hook must not break Claude).

const fs = require('fs');
const path = require('path');
const fsx = require('./fsx');

function readStdinJSON(timeoutMs = 5000) {
  return new Promise((resolve) => {
    let data = '';
    let done = false;
    const finish = () => { if (done) return; done = true; try { resolve(data.trim() ? JSON.parse(data) : {}); } catch { resolve({ _raw: data }); } };
    // give up only when nothing arrives at all; once data flows, wait for the stream to end (max 30 s)
    let timer = setTimeout(finish, timeoutMs);
    try {
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', (c) => { data += c; clearTimeout(timer); timer = setTimeout(finish, 30000); });
      process.stdin.on('end', () => { clearTimeout(timer); finish(); });
      process.stdin.on('error', () => { clearTimeout(timer); finish(); });
      if (process.stdin.isTTY) { clearTimeout(timer); finish(); }
    } catch { clearTimeout(timer); finish(); }
  });
}

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function log(...a) {
  if (process.env.TURBO_DEBUG) process.stderr.write(`[turbo] ${a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')}\n`);
}

/** Run a hook main() safely: any unexpected error exits 0 silently (fail open). */
function exitAfterFlush(code) {
  // stdout to a pipe is asynchronous on POSIX: make sure the JSON reply is fully written first
  process.stdout.write('', () => process.exit(code));
  setTimeout(() => process.exit(code), 2000).unref();
}

function main(fn) {
  const t0 = Date.now();
  readStdinJSON().then(async (input) => {
    try {
      const code = await fn(input || {});
      log(`done in ${Date.now() - t0}ms`);
      exitAfterFlush(typeof code === 'number' ? code : 0);
    } catch (e) {
      process.stderr.write(`[turbo hook] internal error (ignored): ${e && e.stack || e}\n`);
      exitAfterFlush(0);
    }
  });
}

// ---------- per-session state (edited files, verification results) ----------
function sessionsDir() {
  const d = path.join(fsx.dataDir(), 'sessions');
  try { fs.mkdirSync(d, { recursive: true }); } catch { /* ignore */ }
  return d;
}

function sessionFile(sessionId) {
  const id = String(sessionId || 'unknown').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80);
  return path.join(sessionsDir(), `${id}.json`);
}

function loadSession(sessionId) {
  try { return JSON.parse(fs.readFileSync(sessionFile(sessionId), 'utf8')); } catch { return { edited: {}, created: Date.now() }; }
}

function saveSession(sessionId, state) {
  try {
    state.updated = Date.now();
    fs.writeFileSync(sessionFile(sessionId), JSON.stringify(state));
    if (Math.random() < 0.05) pruneSessions();
  } catch { /* ignore */ }
}

function pruneSessions(maxAgeMs = 7 * 24 * 3600 * 1000) {
  try {
    const d = sessionsDir();
    const now = Date.now();
    for (const f of fs.readdirSync(d)) {
      const p = path.join(d, f);
      const st = fsx.statSafe(p);
      if (st && now - st.mtimeMs > maxAgeMs) fs.unlinkSync(p);
    }
  } catch { /* ignore */ }
}

/** Resolve the file path from a tool_input for Edit/Write/MultiEdit/NotebookEdit. */
function editedPath(input) {
  const ti = (input && input.tool_input) || {};
  const p = ti.file_path || ti.filePath || ti.path || ti.notebook_path;
  if (!p) return null;
  return fsx.normPath(p, input.cwd || process.cwd());
}

module.exports = { readStdinJSON, emit, log, main, loadSession, saveSession, editedPath, sessionFile };
