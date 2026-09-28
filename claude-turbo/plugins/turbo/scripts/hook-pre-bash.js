#!/usr/bin/env node
'use strict';
// PreToolUse hook (Bash | PowerShell): a narrow safety net for destructive commands.
// Catastrophic commands are denied; risky-but-sometimes-legit ones escalate to the user.
// Everything else passes through with zero output so it never slows Claude down.
//
// Deletes are analyzed structurally (command + flags + targets, quote-aware, resolved against
// the project root) instead of by pattern alone, so `rm -rf build` inside the project is silent,
// `rm -rf "../other proj"` asks, and `rm -rf ~`, `Remove-Item C:\ -Recurse`, `rd /s /q C:\Users` deny.

const os = require('os');
const path = require('path');
const fsx = require('../lib/fsx');
const io = require('../lib/hookio');
const options = require('../lib/options');

// Commands must appear in command position (start of a segment, or after sudo/then/do/exec/time/nohup),
// so the same words inside an echo string or a commit message do not trigger the guard.
const CP = String.raw`(?:^|[;&|(\`]\s*|\b(?:sudo|then|do|exec|time|nohup)\s+)`;
const cp = (body, flags = '') => new RegExp(CP + body, flags);

const DENY = [
  { re: cp(String.raw`rm\s+[^\n;&|]*--no-preserve-root`, 'i'), why: 'rm --no-preserve-root' },
  { re: cp(String.raw`mkfs(\.\w+)?\b`), why: 'formatting a filesystem' },
  { re: cp(String.raw`dd\b[^\n;&|]*\bof=/dev/(sd|hd|nvme|disk|mmcblk)`), why: 'raw write to a block device' },
  { re: />\s*\/dev\/(sd|hd|nvme|disk)\w*/, why: 'redirect into a block device' },
  { re: /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/, why: 'fork bomb' },
  { re: cp(String.raw`(chmod|chown)\s+(-[a-zA-Z]*R[a-zA-Z]*|--recursive)\s+[^\n;&|]*\s/(?=\s|$)`), why: 'recursive permission change of /' },
  { re: cp(String.raw`format(\.com)?\s+[A-Za-z]:`, 'i'), why: 'formatting a Windows drive' },
  { re: cp(String.raw`(Format-Volume|Clear-Disk|Remove-Partition|Initialize-Disk)\b`, 'i'), why: 'disk-level destructive cmdlet' },
  { re: cp(String.raw`diskpart\b`, 'i'), why: 'diskpart' },
  { re: cp(String.raw`find\s+(?:/|~|\$HOME|[A-Za-z]:[\\/]?)\s[^\n;&|]*-(delete|exec\s+rm)\b`), why: 'find -delete from a filesystem root or home' },
];

const ASK = [
  { re: cp(String.raw`git\s+push\b[^\n;&|]*(\s--force\b|\s-f\b|\s--force-with-lease\b)`), why: 'force push (rewrites remote history)' },
  { re: cp(String.raw`git\s+push\b[^\n;&|]*\s\+\S+`), why: 'force push via + refspec' },
  { re: cp(String.raw`git\s+branch\s+(-D|--delete\s+--force)\s+(main|master|develop|release\S*)`), why: 'force-deleting a primary branch' },
  { re: cp(String.raw`git\s+reset\s+--hard\b`), why: 'git reset --hard discards uncommitted work' },
  { re: cp(String.raw`git\s+(checkout|restore)\s+(--\s+)?\.(?=\s|$)`), why: 'discarding all working tree changes' },
  { re: cp(String.raw`git\s+restore\s+[^\n;&|]*--staged[^\n;&|]*--worktree`), why: 'discarding staged and working changes' },
  { re: cp(String.raw`git\s+clean\s+-[a-zA-Z]*[fd][a-zA-Z]*`), why: 'git clean deletes untracked files' },
  { re: cp(String.raw`git\s+stash\s+(drop|clear)\b`), why: 'dropping stashes is unrecoverable' },
  { re: cp(String.raw`git\s+(filter-branch|filter-repo)\b`), why: 'history rewrite' },
  { re: cp(String.raw`git\s+reflog\s+expire\b`), why: 'expiring reflog removes recovery points' },
  { re: cp(String.raw`sudo\s+(rm|chmod|chown|dd|mkfs|mv|cp)\b`), why: 'privileged destructive command' },
  { re: /\b(curl|wget|iwr|irm|Invoke-WebRequest|Invoke-RestMethod)\b[^\n]*\|\s*(sudo\s+)?(sh|bash|zsh|iex|Invoke-Expression|powershell|pwsh|python\d?)\b/i, why: 'piping a download straight into an interpreter' },
  { re: /\b(iex|Invoke-Expression)\s*\(?\s*(\(\s*)?(iwr|irm|Invoke-WebRequest|Invoke-RestMethod|New-Object\s+(System\.)?Net\.WebClient|\[System\.Net\.WebClient\])/i, why: 'executing downloaded code' },
  { re: /\.DownloadString\s*\(|\.DownloadFile\s*\([^\n]*\|\s*(iex|Invoke-Expression)/i, why: 'executing downloaded code' },
  { re: cp(String.raw`(psql|mysql|mariadb|sqlite3|sqlcmd|mongosh?|clickhouse-client|duckdb|bq|snowsql)\b[^\n]*\b(DROP\s+(DATABASE|SCHEMA|TABLE)|TRUNCATE\s+TABLE)\b`, 'i'), why: 'destructive SQL' },
  { re: cp(String.raw`find\b[^\n;&|]*\s-(delete|exec\s+rm)\b`), why: 'find -delete / -exec rm removes files in bulk' },
  { re: cp(String.raw`xargs\s+(-[^\s]+\s+)*rm\s+[^\n;&|]*-[a-zA-Z]*[rR]`), why: 'bulk recursive delete through xargs' },
  { re: cp(String.raw`terraform\s+(destroy|apply\s+[^\n]*-auto-approve)`), why: 'infrastructure change without review' },
  { re: cp(String.raw`kubectl\s+delete\b[^\n;&|]*(--all|\bns\b|namespace)`), why: 'bulk kubernetes delete' },
  { re: cp(String.raw`docker\s+(system|volume|image|container)\s+prune\b|docker\s+(rm|volume\s+rm)\s+[^\n;&|]*\$\(docker\s+`), why: 'bulk docker cleanup' },
  { re: cp(String.raw`(npm|pnpm)\s+publish\b|yarn\s+(npm\s+)?publish\b|twine\s+upload\b|cargo\s+publish\b|gem\s+push\b`), why: 'publishing a package' },
  { re: cp(String.raw`gh\s+repo\s+delete\b|aws\s+s3\s+(rm\s+[^\n]*--recursive|rb\s+[^\n]*--force)|gcloud\s+[^\n]*\bdelete\b|az\s+[^\n]*\bdelete\b`), why: 'deleting remote resources' },
  { re: cp(String.raw`(shutdown|reboot|halt|poweroff|Stop-Computer|Restart-Computer)\b`, 'i'), why: 'power state change' },
  { re: cp(String.raw`reg(\.exe)?\s+delete\s+HK(LM|EY_LOCAL_MACHINE)`, 'i'), why: 'deleting machine registry keys' },
  { re: cp(String.raw`Set-ExecutionPolicy\b[^\n]*(Unrestricted|Bypass)[^\n]*(LocalMachine|-Scope\s+LocalMachine)`, 'i'), why: 'weakening machine execution policy' },
  { re: cp(String.raw`(bcdedit|netsh\s+advfirewall\s+reset|Disable-ComputerRestore|vssadmin\s+delete)\b`, 'i'), why: 'system-level change' },
  { re: cp(String.raw`schtasks\s+/delete\b|Unregister-ScheduledTask\b`, 'i'), why: 'deleting scheduled tasks' },
];

// ---------------------------------------------------------------------------
// Structural delete analysis

const DELETE_CMDS = /^(rm|ri|remove-item|rd|rmdir|del|erase)$/i;
const PREFIX_WORDS = /^(sudo|then|do|exec|time|nohup|command|builtin)$/i;

function tokens(seg) {
  // quote-aware split; keeps quoted strings as single tokens (quotes removed). Backslash-space is an
  // escaped space only in POSIX shells; a segment that contains a Windows path (X:\) never uses it.
  const out = [];
  const posix = !/[A-Za-z]:[\\/]/.test(seg) && !/^\s*(ri|remove-item|rd|rmdir|del|erase|gci|dir|get-childitem)\b/i.test(seg);
  const re = posix ? /"([^"]*)"|'([^']*)'|((?:\\ |[^\s])+)/g : /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(seg))) out.push(m[1] != null ? m[1] : m[2] != null ? m[2] : (posix ? m[3].replace(/\\ /g, ' ') : m[3]));
  return out;
}

function splitSegments(cmd) {
  // split on ; && || | newline (not inside quotes)
  const segs = [];
  let cur = '', q = null, prevPipe = false;
  const push = (pipe) => { if (cur.trim()) segs.push({ text: cur.trim(), afterPipe: prevPipe }); cur = ''; prevPipe = pipe; };
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (q) { cur += c; if (c === q) q = null; continue; }
    if (c === '"' || c === "'") { q = c; cur += c; continue; }
    if (c === '\n' || c === ';') { push(false); continue; }
    if (c === '&' && cmd[i + 1] === '&') { push(false); i++; continue; }
    if (c === '|') { if (cmd[i + 1] === '|') { push(false); i++; } else push(true); continue; }
    cur += c;
  }
  push(false);
  return segs;
}

const HOME_MARK = /^(~|~[\\/]|\$HOME|\$\{HOME\}|\$env:USERPROFILE|\$env:HOME|%USERPROFILE%|%HOMEPATH%)([\\/]?)$/i;
const SYSTEM_DIRS = [/^[A-Za-z]:[\\/]?\*?$/, /^[A-Za-z]:[\\/](Users|Windows|Program Files( \(x86\))?|ProgramData)[\\/]?\*?$/i, /^\/(\*|home|Users|etc|usr|var|bin|sbin|lib|lib64|opt|root|boot|System|Library|Applications)?[\\/]?\*?$/, /^%(SystemRoot|ProgramFiles|windir)%/i];
// Any user's profile root (not only the current user's): C:\Users\name, /home/name, /Users/name
const USER_HOME_ROOT = /^(?:[A-Za-z]:[\\/](?:Users|home)[\\/][^\\/]+|\/(?:home|Users)\/[^/]+)[\\/]?\*?$/i;

function classifyTarget(raw, ctx) {
  let t = raw.trim();
  if (!t) return null;
  if (HOME_MARK.test(t) || SYSTEM_DIRS.some((re) => re.test(t)) || USER_HOME_ROOT.test(t)) return 'deny';
  // Windows drive paths evaluated on a POSIX host (tests, WSL): pattern-based, since they cannot resolve
  if (process.platform !== 'win32' && /^[A-Za-z]:[\\/]/.test(t)) return 'ask';
  const sep = path.sep;
  const norm = (p) => (process.platform === 'win32' ? p.toLowerCase() : p).replace(/[\\/]+$/, '');
  const home = norm(os.homedir()), root = norm(ctx.root), tmp = norm(os.tmpdir());
  while (t.startsWith('./') || t.startsWith('.\\')) t = t.slice(2);
  if (/^\.git[\\/]?$/.test(t)) return 'ask';
  const dotTarget = t === '' || t === '.' || t === '*';
  const isAbs = /^([A-Za-z]:[\\/]|\/|~|\$HOME|\$\{HOME\}|\$env:USERPROFILE|%USERPROFILE%)/i.test(t);
  const hasDotDot = /(^|[\\/])\.\.([\\/]|$)/.test(t);
  let resolved;
  try {
    resolved = dotTarget ? path.resolve(ctx.vcwd || ctx.cwd) : fsx.normPath(t.replace(/^\$\{HOME\}|^\$HOME|^\$env:USERPROFILE|^%USERPROFILE%/i, '~').replace(/[\\/]\*$/, ''), ctx.vcwd || ctx.cwd);
  } catch { return 'ask'; }
  const r = norm(resolved);
  if (r === home || r === norm(path.parse(resolved).root) || home.startsWith(r + sep)) return 'deny';
  if (root.startsWith(r + sep)) return 'deny'; // a parent of the project
  if (r === root) return 'ask';
  if (r.startsWith(root + sep)) return (r.endsWith(sep + '.git') || r.includes(sep + '.git' + sep)) ? 'ask' : 'allow';
  if (isAbs && !hasDotDot && r.startsWith(tmp + sep)) return 'allow'; // an explicitly typed temp path
  return 'ask';
}

/** Returns { decision: 'deny'|'ask', why } or null. */
function deleteGuard(cmd, ctx) {
  const segs = splitSegments(cmd);
  ctx = { ...ctx, vcwd: ctx.cwd };
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    let toks = tokens(seg.text);
    while (toks.length && PREFIX_WORDS.test(toks[0])) toks.shift();
    if (toks.length >= 2 && /^(cd|pushd|Set-Location|sl|chdir)$/i.test(toks[0])) { // follow directory changes for later relative targets
      try { ctx.vcwd = fsx.normPath(toks[1].replace(/^\$HOME|^\$env:USERPROFILE/i, '~'), ctx.vcwd); } catch { /* ignore */ }
      continue;
    }
    if (!toks.length || !DELETE_CMDS.test(toks[0])) continue;
    const name = toks[0].toLowerCase();
    const rest = toks.slice(1);
    const flags = rest.filter((t) => /^(-|\/[a-zA-Z]$)/.test(t));
    const isCmd = name === 'rd' || name === 'rmdir' || name === 'del' || name === 'erase';
    let recursive = flags.some((f) => /^--recursive$|^-recurse$|^-r$|^-[a-zA-Z]*[rR][a-zA-Z]*$/i.test(f) || (isCmd && /^\/s$/i.test(f)));
    let targets = [];
    for (let k = 0; k < rest.length; k++) {
      const t = rest[k];
      if (/^-(Path|LiteralPath|Include)$/i.test(t)) { if (rest[k + 1]) targets.push(...rest[k + 1].split(',')); k++; continue; }
      if (/^-(Path|LiteralPath):/i.test(t)) { targets.push(t.replace(/^-\w+:/, '')); continue; }
      if (/^(-|\/[a-zA-Z]$)/.test(t)) continue;
      targets.push(...(t.includes(',') && !/[\\/]/.test(t) ? t.split(',') : [t]));
    }
    // Pipeline: `Get-ChildItem X -Recurse | Remove-Item -Force` -> targets and recursion come from the source
    if (seg.afterPipe && i > 0 && /^(gci|ls|dir|get-childitem)\b/i.test(segs[i - 1].text)) {
      const src = tokens(segs[i - 1].text).slice(1);
      if (src.some((t) => /^-recurse$|^-r$/i.test(t))) recursive = true;
      targets.push(...src.filter((t) => !t.startsWith('-')));
      if (!targets.length) targets.push('.');
    }
    if (!recursive) continue;
    let worst = null;
    for (const t of targets) {
      const c = classifyTarget(t, ctx);
      if (c === 'deny') return { decision: 'deny', why: `recursive delete of a home, system or drive-level path (${t})` };
      if (c === 'ask') worst = worst || { decision: 'ask', why: `recursive delete of ${t === '.' || t === '*' ? 'the current directory' : t.startsWith('..') ? 'a path outside the project' : `"${t}"`} (outside the project, the project root, or .git)` };
    }
    if (worst) return worst;
  }
  return null;
}

/** Inner command strings run through another interpreter: bash -c "...", eval "...", powershell -Command "..." */
function innerCommands(cmd) {
  const out = [];
  const re = /\b(?:bash|sh|zsh|dash|ksh)\s+-c\s+("([^"]*)"|'([^']*)')|\beval\s+("([^"]*)"|'([^']*)')|\b(?:powershell|pwsh)(?:\.exe)?\b[^\n;&|]*?\s-(?:c|Command|EncodedCommand)\s+("([^"]*)"|'([^']*)')|\bcmd(?:\.exe)?\s+\/[cCkK]\s+("([^"]*)"|'([^']*)')/gi;
  let m;
  while ((m = re.exec(cmd))) {
    const inner = m[2] ?? m[3] ?? m[5] ?? m[6] ?? m[8] ?? m[9] ?? m[11] ?? m[12];
    if (inner && inner.trim()) out.push(inner);
  }
  return out;
}

function evaluate(cmd, ctx, depth = 0) {
  for (const d of DENY) if (d.re.test(cmd)) return { decision: 'deny', why: d.why };
  const del = deleteGuard(cmd, ctx);
  if (del && del.decision === 'deny') return del;
  for (const a of ASK) if (a.re.test(cmd)) return { decision: 'ask', why: a.why };
  if (del) return del;
  if (depth < 2) for (const inner of innerCommands(cmd)) { const r = evaluate(inner, ctx, depth + 1); if (r) return r; }
  return null;
}

async function main(input) {
  const level = options.guardLevel();
  if (level === 'off') return 0;
  const cmd = String((input.tool_input && (input.tool_input.command || input.tool_input.script)) || '');
  if (!cmd.trim()) return 0;
  const norm = cmd.replace(/\\\r?\n/g, ' ').replace(/`\r?\n/g, ' ');
  const cwd = input.cwd && fsx.isDir(input.cwd) ? input.cwd : process.cwd();
  const ctx = { cwd, root: fsx.findProjectRoot(cwd) };
  const r = evaluate(norm, ctx);
  if (!r) return 0;
  if (r.decision === 'deny') {
    const reason = `Turbo guard blocked this command: ${r.why}. If this is truly required, the user must run it manually.`;
    io.emit({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } });
  } else if (level === 'strict') {
    const reason = `Turbo guard: ${r.why}. Confirm before running.`;
    io.emit({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: reason, additionalContext: `${reason} If the user declines, do not retry the same command; choose a narrower, in-project alternative.` } });
  }
  return 0;
}

// Only act as a hook when executed directly; tests require() the guard functions.
if (require.main === module) io.main(main);

module.exports = { evaluate, deleteGuard, classifyTarget, splitSegments, tokens, innerCommands, main };
