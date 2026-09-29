'use strict';
// User options declared in plugin.json (userConfig). Claude Code hands them to hooks and the MCP
// server as environment variables named CLAUDE_PLUGIN_OPTION_<KEY>. A missing or blank variable
// means "use the default", so the plugin behaves exactly like v1 until the user changes something.

const DEFAULTS = Object.freeze({
  brief: true,            // SessionStart briefing on/off
  stop_check: true,       // Stop-time re-verification on/off
  guard_level: 'strict',  // strict (deny + ask) | deny-only (catastrophic commands only) | off
});
const GUARD_LEVELS = ['strict', 'deny-only', 'off'];

function raw(name) {
  const keys = [...new Set([name, name.toUpperCase(), name.replace(/-/g, '_').toUpperCase(), name.replace(/_/g, '-').toUpperCase()])];
  for (const k of keys) {
    const v = process.env[`CLAUDE_PLUGIN_OPTION_${k}`];
    if (v != null && String(v).trim() !== '') return String(v).trim();
  }
  return null;
}

function bool(name, def) {
  const v = raw(name);
  if (v == null) return def;
  return !/^(false|0|off|no|disabled?)$/i.test(v);
}

function choice(name, def, allowed) {
  const v = raw(name);
  if (v == null) return def;
  const s = v.toLowerCase().replace(/_/g, '-');
  return allowed.includes(s) ? s : def;
}

function brief() { return bool('brief', DEFAULTS.brief); }
function stopCheck() { return bool('stop_check', DEFAULTS.stop_check); }
function guardLevel() { return choice('guard_level', DEFAULTS.guard_level, GUARD_LEVELS); }

/** Compact description of every non-default option, for the brief and /turbo:help. */
function summary() {
  const parts = [];
  if (!brief()) parts.push('brief off');
  if (!stopCheck()) parts.push('stop check off');
  if (guardLevel() !== 'strict') parts.push(`guards ${guardLevel()}`);
  return parts.join(', ');
}

module.exports = { DEFAULTS, GUARD_LEVELS, raw, bool, choice, brief, stopCheck, guardLevel, summary };
