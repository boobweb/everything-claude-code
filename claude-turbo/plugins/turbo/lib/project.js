'use strict';
// Per-project continuity record, kept under CLAUDE_PLUGIN_DATA/projects/<key>.json:
// what recent sessions edited and whether they ended clean, plus running counters of what
// the hooks caught (broken edits, guarded commands, held writes, stop-time blocks).
// Everything here is best effort: a missing or corrupt record is treated as empty and no
// hook ever fails because of it.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const fsx = require('./fsx');

const MAX_SESSIONS = 6;
const STAT_KEYS = ['sessions', 'brokenEditsCaught', 'commandsDenied', 'commandsAsked', 'writesAsked', 'stopBlocks'];

function keyFor(root) {
  const norm = (process.platform === 'win32' ? String(root).toLowerCase() : String(root)).replace(/[\\/]+$/, '');
  return crypto.createHash('sha1').update(norm).digest('hex').slice(0, 16);
}

function fileFor(root) {
  const d = path.join(fsx.dataDir(), 'projects');
  try { fs.mkdirSync(d, { recursive: true }); } catch { /* ignore */ }
  return path.join(d, `${keyFor(root)}.json`);
}

function normalize(p, root) {
  p = p && typeof p === 'object' && !Array.isArray(p) ? p : {};
  p.root = p.root || fsx.toPosix(root);
  p.sessions = p.sessions && typeof p.sessions === 'object' ? p.sessions : {};
  const stats = {};
  for (const k of STAT_KEYS) stats[k] = Number((p.stats || {})[k]) || 0;
  p.stats = stats;
  return p;
}

function load(root) {
  try { return normalize(JSON.parse(fs.readFileSync(fileFor(root), 'utf8')), root); } catch { return normalize({}, root); }
}

function save(root, p) {
  try { fs.writeFileSync(fileFor(root), JSON.stringify(p)); } catch { /* ignore */ }
}

/** Read-modify-write. fn(record, session) may mutate both; `session` is the entry for sessionId (created on demand). */
function update(root, sessionId, fn) {
  const p = load(root);
  let s = null;
  if (sessionId) {
    s = p.sessions[sessionId] || (p.sessions[sessionId] = { startedAt: Date.now(), edited: {}, clean: null });
    s.updatedAt = Date.now();
  }
  try { fn(p, s); } catch { /* keep the record consistent even if the caller throws */ }
  const ids = Object.keys(p.sessions).sort((a, b) => (p.sessions[b].updatedAt || 0) - (p.sessions[a].updatedAt || 0));
  for (const id of ids.slice(MAX_SESSIONS)) delete p.sessions[id];
  save(root, p);
  return p;
}

function startSession(root, sessionId) {
  return update(root, sessionId, (p, s) => { if (s && !s.counted) { s.counted = true; p.stats.sessions++; } });
}

function recordEdit(root, sessionId, absFile, ok) {
  return update(root, sessionId, (p, s) => {
    if (s) s.edited[fsx.relDisplay(absFile, root)] = { ok: !!ok, ts: Date.now() };
    if (!ok) p.stats.brokenEditsCaught++;
  });
}

/** kind: 'commandsDenied' | 'commandsAsked' | 'writesAsked' */
function recordGuard(root, sessionId, kind) {
  return update(root, sessionId, (p) => { if (STAT_KEYS.includes(kind)) p.stats[kind]++; });
}

function recordStop(root, sessionId, brokenRel) {
  return update(root, sessionId, (p, s) => {
    if (s) { s.endedAt = Date.now(); s.clean = brokenRel.length === 0; s.broken = brokenRel.slice(0, 10); }
    if (brokenRel.length) p.stats.stopBlocks++;
  });
}

/** The most recent session other than `sessionId` that edited something. */
function lastSession(p, sessionId) {
  const c = Object.entries(p.sessions)
    .filter(([id, s]) => id !== sessionId && s && Object.keys(s.edited || {}).length)
    .sort((a, b) => (b[1].updatedAt || 0) - (a[1].updatedAt || 0));
  return c.length ? { id: c[0][0], ...c[0][1] } : null;
}

function ago(ts) {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 90) return `${s}s`;
  if (s < 5400) return `${Math.round(s / 60)}m`;
  if (s < 172800) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

/** One or two sentences for the session brief: what the last session left, what Turbo has caught here. */
function describe(p, sessionId) {
  const parts = [];
  const last = lastSession(p, sessionId);
  if (last) {
    const files = Object.keys(last.edited);
    const shown = files.slice(0, 6).join(', ') + (files.length > 6 ? ` +${files.length - 6} more` : '');
    let end;
    if (last.clean === true) end = 'ended clean';
    else if (last.clean === false) end = `ended with ${plural(last.broken.length, 'broken file')}: ${last.broken.join(', ')}`;
    else {
      const bad = files.filter((f) => last.edited[f].ok === false);
      end = bad.length ? `no Stop check ran; last known broken: ${bad.join(', ')}` : 'no Stop check ran (session closed early), last checks were clean';
    }
    parts.push(`Last session (${ago(last.updatedAt || last.startedAt)} ago) edited ${shown}; ${end}.`);
  }
  const st = p.stats;
  const caught = [];
  if (st.brokenEditsCaught) caught.push(`${plural(st.brokenEditsCaught, 'broken edit')} caught`);
  if (st.commandsDenied + st.commandsAsked) caught.push(`${plural(st.commandsDenied + st.commandsAsked, 'command')} guarded`);
  if (st.writesAsked) caught.push(`${plural(st.writesAsked, 'risky write')} held`);
  if (caught.length) parts.push(`Turbo in this project (${plural(st.sessions, 'session')}): ${caught.join(', ')}.`);
  return parts.join(' ');
}

module.exports = { keyFor, fileFor, load, save, update, startSession, recordEdit, recordGuard, recordStop, lastSession, describe, STAT_KEYS };
