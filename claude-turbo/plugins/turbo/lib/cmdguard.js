'use strict';
// Structural command guard used by the PreToolUse hook (Bash | PowerShell) and the tests.
//
// Catastrophic commands are denied; risky-but-sometimes-legit ones escalate to the user; everything
// else passes silently. Deletes are analyzed structurally (command + flags + targets, quote- and
// escape-aware, resolved against the project root and the directory the command has cd'ed into),
// so `rm -rf build` inside the project is silent, `rm -rf "../other proj"` asks, and `rm -rf ~`,
// `Remove-Item C:\ -Recurse`, `rd /s /q C:\Users`, `(cd ~ && rm -rf *)` and `bash -c "rm -rf ~"` deny.
//
// Anything the guard cannot resolve (a shell variable, a substitution, an unknown working
// directory, targets that arrive through a pipe, an encoded command) asks instead of guessing.

const os = require('os');
const path = require('path');
const fsx = require('./fsx');

// ---------------------------------------------------------------------------
// Pattern rules (run on the command with comments removed; DENY additionally with quoted text blanked)

// Commands must appear in command position (start of a segment, or after sudo/then/do/exec/time/nohup),
// so the same words inside a commit message do not trigger the guard.
const CP = String.raw`(?:^|[;&|(\`]\s*|\b(?:sudo|doas|then|do|exec|time|nohup|env|nice|timeout)\s+)`;
const cp = (body, flags = '') => new RegExp(CP + body, flags);
const SEG = String.raw`[^\n;&|]`; // "the rest of this segment"
const BIN = String.raw`(?:\S*[\\/])?`; // optional path prefix before a command name (/bin/rm, .\rm)

const DENY = [
  { re: cp(String.raw`${BIN}rm\s+${SEG}*--no-preserve-root`, 'i'), why: 'rm --no-preserve-root' },
  { re: cp(String.raw`${BIN}mkfs(\.\w+)?\b`), why: 'formatting a filesystem' },
  { re: cp(String.raw`${BIN}dd\b${SEG}*\bof=/dev/(sd|hd|nvme|disk|mmcblk)`), why: 'raw write to a block device' },
  { re: />\s*\/dev\/(sd[a-z]+\d*|hd[a-z]+\d*|nvme\d+n\d+(p\d+)?|mmcblk\d+(p\d+)?|disk\d+(s\d+)?)(?=\s|$|[;&|)])/, why: 'redirect into a block device' },
  { re: /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/, why: 'fork bomb' },
  { re: cp(String.raw`(chmod|chown|chgrp)\s+(-[a-zA-Z]*R[a-zA-Z]*|--recursive)\s+${SEG}*\s(/|/\*|/(etc|usr|bin|sbin|lib|lib64|var|boot|home|Users|root|System|Library)/?|~|\$HOME|\$\{HOME\})(?=\s|$)`), why: 'recursive permission change of a system or home directory' },
  { re: cp(String.raw`format(\.com)?\s+[A-Za-z]:`, 'i'), why: 'formatting a Windows drive' },
  { re: cp(String.raw`(Format-Volume|Clear-Disk|Remove-Partition|Initialize-Disk)\b`, 'i'), why: 'disk-level destructive cmdlet' },
  { re: cp(String.raw`diskpart\b`, 'i'), why: 'diskpart' },
  { re: cp(String.raw`find\s+(?:/|~|\$HOME|[A-Za-z]:[\\/]?)\s${SEG}*-(delete|exec(?:dir)?\s+${BIN}rm)\b`), why: 'find -delete from a filesystem root or home' },
];

const ASK = [
  { re: cp(String.raw`git\s+push\b${SEG}*(\s--force\b|\s-[a-zA-Z]*f[a-zA-Z]*\b|\s--force-with-lease\b)`), why: 'force push (rewrites remote history)' },
  { re: cp(String.raw`git\s+push\b${SEG}*\s\+\S+`), why: 'force push via + refspec' },
  { re: cp(String.raw`git\s+push\b${SEG}*\s(?:(?:--delete|-d)\s+(?:\S+\s+)?|\S+\s+:)(main|master|develop|release\S*)(?=\s|$)`), why: 'deleting a primary remote branch' },
  { re: cp(String.raw`git\s+branch\s+(-D|--delete\s+--force)\s+(main|master|develop|release\S*)`), why: 'force-deleting a primary branch' },
  { re: cp(String.raw`git\s+reset\b${SEG}*\s--hard\b`), why: 'git reset --hard discards uncommitted work' },
  { re: cp(String.raw`git\s+(checkout|restore)\s+(--\s+)?(\.|\./|:/|\*)(?=\s|$)`), why: 'discarding all working tree changes' },
  { re: cp(String.raw`git\s+restore\s+${SEG}*--staged${SEG}*--worktree`), why: 'discarding staged and working changes' },
  { re: cp(String.raw`git\s+clean\s+-[a-zA-Z]*[fd][a-zA-Z]*`), why: 'git clean deletes untracked files' },
  { re: cp(String.raw`git\s+stash\s+(drop|clear)\b`), why: 'dropping stashes is unrecoverable' },
  { re: cp(String.raw`git\s+(filter-branch|filter-repo)\b`), why: 'history rewrite' },
  { re: cp(String.raw`git\s+reflog\s+expire\b`), why: 'expiring reflog removes recovery points' },
  { re: cp(String.raw`(sudo|doas)\b${SEG}*?\s${BIN}(rm|chmod|chown|dd|mkfs|mv|cp)(?=\s|$)`), why: 'privileged destructive command' },
  { re: /\b(curl|wget|iwr|irm|Invoke-WebRequest|Invoke-RestMethod)\b[^\n]*\|\s*(sudo\s+)?(sh|bash|zsh|iex|Invoke-Expression|powershell|pwsh|python\d?)\b/i, why: 'piping a download straight into an interpreter' },
  { re: /\b(iex|Invoke-Expression)\s*\(?\s*(\(\s*)?(iwr|irm|Invoke-WebRequest|Invoke-RestMethod|New-Object\s+(System\.)?Net\.WebClient|\[System\.Net\.WebClient\])/i, why: 'executing downloaded code' },
  { re: /\.DownloadString\s*\(|\.DownloadFile\s*\([^\n]*\|\s*(iex|Invoke-Expression)/i, why: 'executing downloaded code' },
  { re: cp(String.raw`(psql|mysql|mariadb|sqlite3|sqlcmd|mongosh?|clickhouse-client|duckdb|bq|snowsql)\b[^\n]*\b(DROP\s+(DATABASE|SCHEMA|TABLE)|TRUNCATE\s+TABLE)\b`, 'i'), why: 'destructive SQL' },
  { re: cp(String.raw`find\b${SEG}*\s-(delete|exec(?:dir)?\s+${BIN}rm)\b`), why: 'find -delete / -exec rm removes files in bulk' },
  { re: cp(String.raw`xargs\b${SEG}*?\s${BIN}rm\s+${SEG}*-[a-zA-Z]*[rR]`), why: 'bulk recursive delete through xargs' },
  { re: cp(String.raw`terraform\s+(destroy|apply\s+[^\n]*-auto-approve)`), why: 'infrastructure change without review' },
  { re: cp(String.raw`kubectl\s+delete\b${SEG}*(--all|\bns\b|namespace)`), why: 'bulk kubernetes delete' },
  { re: cp(String.raw`docker\s+(system|volume|image|container)\s+prune\b|docker\s+(rm|volume\s+rm)\s+${SEG}*\$\(docker\s+`), why: 'bulk docker cleanup' },
  { re: cp(String.raw`(npm|pnpm)\s+publish\b|yarn\s+(npm\s+)?publish\b|twine\s+upload\b|cargo\s+publish\b|gem\s+push\b`), why: 'publishing a package' },
  { re: cp(String.raw`gh\s+repo\s+delete\b|aws\s+s3\s+(rm\s+[^\n]*--recursive|rb\s+[^\n]*--force)|gcloud\s+[^\n]*\bdelete\b|az\s+[^\n]*\bdelete\b`), why: 'deleting remote resources' },
  { re: cp(String.raw`(shutdown|reboot|halt|poweroff|Stop-Computer|Restart-Computer)\b`, 'i'), why: 'power state change' },
  { re: cp(String.raw`reg(\.exe)?\s+delete\s+HK(LM|EY_LOCAL_MACHINE)`, 'i'), why: 'deleting machine registry keys' },
  { re: cp(String.raw`Set-ExecutionPolicy\b[^\n]*(Unrestricted|Bypass)[^\n]*(LocalMachine|-Scope\s+LocalMachine)`, 'i'), why: 'weakening machine execution policy' },
  { re: cp(String.raw`(bcdedit|netsh\s+advfirewall\s+reset|Disable-ComputerRestore|vssadmin\s+delete)\b`, 'i'), why: 'system-level change' },
  { re: cp(String.raw`schtasks\s+/delete\b|Unregister-ScheduledTask\b`, 'i'), why: 'deleting scheduled tasks' },
  { re: cp(String.raw`robocopy\b[^\n]*\s/(MIR|PURGE)\b`, 'i'), why: 'robocopy /MIR or /PURGE deletes everything in the destination that is not in the source' },
  { re: /\b(?:shutil\.rmtree|os\.removedirs|fs(?:\.promises)?\.rm(?:Sync)?|fs\.rmdirSync|rimraf(?:\.sync)?|Remove-Item)\s*\(\s*(?:['"](?:~|\/|[A-Za-z]:[\\/]{1,2})['"]?|os\.homedir\(\)|process\.env\.(?:HOME|USERPROFILE)|os\.path\.expanduser\(\s*['"]~|os\.environ\[['"](?:HOME|USERPROFILE)|Path\.home\(\))/, why: 'recursive delete of a home or root path from an interpreter one-liner' },
];

// ---------------------------------------------------------------------------
// Text preparation: shell mode, comments, quotes, segments, tokens

/** 'posix' (bash/zsh: backslash escapes, $'...' quoting) or 'ps' (PowerShell/cmd: backslash is a path separator). */
function shellMode(text, hint) {
  if (hint === 'ps') return 'ps';
  // a Windows drive path never uses backslash escapes, whatever tool carried the command (Git Bash users paste PowerShell too)
  if (/[A-Za-z]:[\\/]/.test(text)) return 'ps';
  // likewise a PowerShell / cmd command in command position
  if (/(^|[\s;&|({])(ri|remove-item|rd|del|erase|gci|get-childitem|get-item|foreach-object|where-object|set-location|push-location|set-content|out-file)(\s|$)/im.test(text)) return 'ps';
  return 'posix';
}

/**
 * Remove #-comments (a # that starts a word, up to the end of the line) and, with blankQuotes,
 * the contents of quoted strings, so pattern rules never fire on a commit message or a comment.
 */
function scrub(text, mode, { blankQuotes = false } = {}) {
  const posix = shellMode(text, mode) === 'posix';
  let out = '', q = null;
  const atBoundary = () => out === '' || /[\s;&|({]$/.test(out);
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (posix && q === '"' && c === '\\' && i + 1 < text.length) { if (!blankQuotes) out += c + text[i + 1]; i++; continue; }
      if (c === q) { q = null; out += c; continue; }
      if (!blankQuotes) out += c;
      continue;
    }
    if (posix && c === '\\' && i + 1 < text.length) { out += c + text[i + 1]; i++; continue; }
    if (c === '#' && atBoundary()) { while (i + 1 < text.length && text[i + 1] !== '\n') i++; continue; }
    if (c === '"' || c === "'") { q = c; out += c; continue; }
    out += c;
  }
  return out;
}

/**
 * Split a command line into segments on ; && || | & and newlines (never inside quotes or $(...)).
 * Subshells `( ... )` and blocks `{ ... }` become ctl segments ('open' / 'close') so the delete
 * guard can save and restore the tracked working directory around them. `#` comments are dropped.
 */
function splitSegments(cmd, mode) {
  mode = shellMode(cmd, mode);
  const posix = mode === 'posix';
  const segs = [];
  let cur = '', q = null, prevPipe = false;
  const stack = []; // 'sub' | 'expr' | 'var' | 'block' | 'lit'
  const exprDepth = () => stack.filter((k) => k === 'expr' || k === 'var' || k === 'lit').length;
  const push = (pipe) => { if (cur.trim()) segs.push({ text: cur.trim(), afterPipe: prevPipe }); cur = ''; prevPipe = pipe; };
  const ctl = (kind) => { const pipe = prevPipe; push(false); segs.push({ text: '', ctl: kind, afterPipe: kind === 'open' ? pipe : false }); if (kind === 'open') prevPipe = pipe; };
  const atBoundary = () => cur.trim() === '' || /[\s;&|(]$/.test(cur);
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (q) {
      cur += c;
      if (posix && q === '"' && c === '\\' && i + 1 < cmd.length) { cur += cmd[++i]; continue; }
      if (c === q) q = null;
      continue;
    }
    if (posix && c === '\\' && i + 1 < cmd.length) { cur += c + cmd[++i]; continue; }
    if (c === '#' && atBoundary() && exprDepth() === 0) { while (i + 1 < cmd.length && cmd[i + 1] !== '\n') i++; continue; }
    if (c === '"' || c === "'") { q = c; cur += c; continue; }
    if (c === '(') {
      if (cur.endsWith('$') || cur.endsWith('@') || exprDepth() > 0 || cur.trim() !== '') { stack.push('expr'); cur += c; } else { ctl('open'); stack.push('sub'); }
      continue;
    }
    if (c === ')') {
      const k = stack.pop();
      if (k === 'sub') ctl('close'); else cur += c;
      continue;
    }
    if (c === '{') {
      if (cur.endsWith('$') || exprDepth() > 0) { stack.push('var'); cur += c; }
      else if (cmd[i + 1] === '}') { cur += '{}'; i++; } // find -exec {} / xargs -I {} placeholder
      else if (atBoundary() || /[%&.]\s*$/.test(cur)) { ctl('open'); stack.push('block'); }
      else { stack.push('lit'); cur += c; }
      continue;
    }
    if (c === '}') {
      const k = stack.pop();
      if (k === 'block') ctl('close'); else cur += c;
      continue;
    }
    if (exprDepth() > 0) { cur += c; continue; } // inside $( ... ) or ( ... ) as an argument: one token, no splitting
    if (c === '\n' || c === ';') { push(false); continue; }
    if (c === '&') {
      if (cmd[i + 1] === '&') { push(false); i++; continue; }
      if (cmd[i + 1] === '>' || cur.endsWith('>') || cur.endsWith('|')) { cur += c; continue; } // &> and >& redirections, PowerShell |&
      push(false); continue; // background job in bash, call operator in PowerShell: a separator either way
    }
    if (c === '|') { if (cmd[i + 1] === '|') { push(false); i++; } else push(true); continue; }
    cur += c;
  }
  push(false);
  return segs;
}

/**
 * Quote-, escape- and paren-aware split of one segment into tokens (quotes removed, adjacent quoted
 * and unquoted parts joined as the shell would: $HOME"" is $HOME). A parenthesized group stays one
 * token so `(Resolve-Path ~)` is seen as a single unresolvable target.
 */
function tokens(seg, mode) {
  const posix = shellMode(seg, mode) === 'posix';
  const out = [];
  let cur = '', has = false, q = null, depth = 0;
  const flush = () => { if (has) out.push(cur); cur = ''; has = false; };
  for (let i = 0; i < seg.length; i++) {
    const c = seg[i];
    if (q) {
      if (c === q) { q = null; continue; }
      if (posix && q === '"' && c === '\\' && i + 1 < seg.length && /["\\$`]/.test(seg[i + 1])) { cur += seg[++i]; continue; }
      if (!posix && q === '"' && c === '`' && i + 1 < seg.length) { cur += seg[++i]; continue; } // PowerShell escape
      cur += c; continue;
    }
    if (c === '"' || c === "'") { q = c; has = true; if (posix && c === "'" && cur.endsWith('$')) cur = cur.slice(0, -1); continue; } // $'...' ANSI-C quoting
    if (posix && c === '\\' && i + 1 < seg.length) { cur += seg[++i]; has = true; continue; }
    if (c === '(') { depth++; cur += c; has = true; continue; }
    if (c === ')' && depth > 0) { depth--; cur += c; continue; }
    if (/\s/.test(c) && depth === 0) { flush(); continue; }
    cur += c; has = true;
  }
  flush();
  return out;
}

// ---------------------------------------------------------------------------
// Structural delete analysis

const DELETE_CMDS = /^(rm|ri|remove-item|rd|rmdir|del|erase)$/i;
const PERM_CMDS = /^(chmod|chown|chgrp)$/i;
const CD_CMDS = /^(cd|chdir|pushd|set-location|sl|push-location)$/i;
const INTERP = /^(bash|sh|zsh|dash|ksh|fish|pwsh|powershell|cmd|eval|su)$/i;
// Words that may precede a command without changing what it does; VALUE_FLAGS lists their short options that take a separate value.
const PREFIX_WORDS = /^(sudo|doas|then|do|exec|time|nohup|command|builtin|env|nice|ionice|timeout|stdbuf|chronic|caffeinate|xargs|&|\.)$/i;
const VALUE_FLAGS = { sudo: 'ugCDhprtUT', doas: 'uC', nice: 'n', ionice: 'cnpPu', timeout: 'sk', env: 'uCS', stdbuf: 'ioe', xargs: 'ILnPdaEsl' };
const HOME_MARK = /^(~|~[\\/]|\$HOME|\$\{HOME\}|\$env:USERPROFILE|\$env:HOME|%USERPROFILE%|%HOMEPATH%)([\\/]?)$/i;
const SYSTEM_DIRS = [/^[A-Za-z]:[\\/]?\*?$/, /^[A-Za-z]:[\\/](Users|Windows|Program Files( \(x86\))?|ProgramData)[\\/]?\*?$/i, /^\/(\*|home|Users|etc|usr|var|bin|sbin|lib|lib64|opt|root|boot|System|Library|Applications)?[\\/]?\*?$/, /^%(SystemRoot|ProgramFiles|windir)%/i];
// Any user's profile root (not only the current user's): C:\Users\name, /home/name, /Users/name, ~name
const USER_HOME_ROOT = /^(?:[A-Za-z]:[\\/](?:Users|home)[\\/][^\\/]+|\/(?:home|Users)\/[^/]+|~[A-Za-z_][\w.-]*)[\\/]?\*?$/i;
// Environment variables that name a home, profile or system location, in PowerShell and cmd spelling
const ENV_SYSTEM = /^(?:\$env:(?:SystemRoot|windir|SystemDrive|HOMEDRIVE|HOMEPATH|APPDATA|LOCALAPPDATA|ProgramFiles(?:\(x86\))?|ProgramData|USERPROFILE|HOME|ALLUSERSPROFILE|PUBLIC)|%(?:SystemRoot|windir|SystemDrive|HOMEDRIVE|HOMEPATH|APPDATA|LOCALAPPDATA|ProgramFiles(?:\(x86\))?|ProgramData|USERPROFILE|ALLUSERSPROFILE|PUBLIC)%|\$env:HOMEDRIVE\$env:HOMEPATH|%HOMEDRIVE%%HOMEPATH%|\$\{?HOME\}?)[\\/]?\*?$/i;
const HOME_PREFIX = /^(\$\{HOME\}|\$HOME|\$env:USERPROFILE|\$env:HOME|%USERPROFILE%)(?=[\\/]|$)/i;

/** The command name of a token: path stripped (/bin/rm, .\rm, C:\...\cmd.exe), leading backslash removed, .exe dropped, lower-cased. */
function cmdName(tok) {
  const base = String(tok || '').replace(/^\\/, '').split(/[\\/]/).pop() || '';
  return base.toLowerCase().replace(/\.exe$/, '');
}

/** True when a target still holds something the shell would expand or run: a variable, substitution, or placeholder. */
function isUnexpanded(t) {
  const e = t.replace(HOME_PREFIX, '~');
  return /[$%`()]/.test(e) || e === '{}';
}

/**
 * Drop sudo/env/nice/timeout/xargs-style prefixes (with their own options) so the real command is toks[0].
 * Options that change what runs are honored, not dropped: `env -C dir` / `--chdir` and `sudo -D dir` move the
 * tracked working directory (when ctx is given), `env -S 'cmd args'` / `--split-string` is split into tokens.
 */
function stripPrefixes(toks, ctx, mode) {
  toks = toks.slice();
  for (let guard = 0; guard < 8 && toks.length; guard++) {
    const w = cmdName(toks[0]);
    if (!PREFIX_WORDS.test(w)) break;
    toks.shift();
    const vals = VALUE_FLAGS[w] || '';
    while (toks.length) {
      const t = toks[0];
      if (t === '--') { toks.shift(); break; }
      if ((w === 'env' || w === 'sudo') && (/^-[a-zA-Z]*[CD]$/.test(t) || /^--chdir(=|$)/.test(t))) {
        const dir = t.includes('=') ? t.slice(t.indexOf('=') + 1) : toks[1];
        toks.splice(0, t.includes('=') ? 1 : 2);
        if (ctx) followCd(['cd', dir === undefined ? '-' : dir], ctx);
        continue;
      }
      if (w === 'env' && (/^-[a-zA-Z]*S$/.test(t) || /^--split-string(=|$)/.test(t))) {
        const str = t.includes('=') ? t.slice(t.indexOf('=') + 1) : toks[1];
        toks.splice(0, t.includes('=') ? 1 : 2, ...tokens(str || '', mode));
        continue;
      }
      if (/^-[a-zA-Z]$/.test(t) && vals.includes(t[1])) { toks.splice(0, 2); continue; }
      if (/^-/.test(t)) { toks.shift(); continue; }
      if (w === 'timeout' && /^\d+(\.\d+)?[smhd]?$/.test(t)) { toks.shift(); continue; }
      if (w === 'env' && /^\w+=/.test(t)) { toks.shift(); continue; }
      break;
    }
  }
  return toks;
}

// git accepts options before the subcommand (`git -C dir push --force`, `git --no-pager reset --hard`); the pattern rules
// expect the subcommand right after `git`, so these are folded away before matching.
const GIT_GLOBAL_OPTS = /\bgit\s+(?:(?:-C\s+\S+|-c\s+\S+|--(?:git-dir|work-tree|namespace|super-prefix|config-env|exec-path)(?:=\S+|\s+\S+)|--no-pager|-p|--paginate|-P|--bare|--no-replace-objects|--no-lazy-fetch|--no-optional-locks|--no-advice|--literal-pathspecs|--glob-pathspecs|--noglob-pathspecs|--icase-pathspecs)\s+)+/g;
function foldGitOptions(text) { return text.replace(GIT_GLOBAL_OPTS, 'git '); }

function classifyTarget(raw, ctx) {
  let t = raw.trim();
  if (!t) return null;
  if (HOME_MARK.test(t) || SYSTEM_DIRS.some((re) => re.test(t)) || USER_HOME_ROOT.test(t) || ENV_SYSTEM.test(t)) return 'deny';
  if (isUnexpanded(t)) return 'ask'; // $D, $(...), `...`, %VAR%, (Resolve-Path ~), {}: cannot be resolved here
  // Windows drive paths evaluated on a POSIX host (tests, WSL): pattern-based, since they cannot resolve
  if (process.platform !== 'win32' && /^[A-Za-z]:[\\/]/.test(t)) return 'ask';
  const sep = path.sep;
  const norm = (p) => (process.platform === 'win32' ? p.toLowerCase() : p).replace(/[\\/]+$/, '');
  const home = norm(os.homedir()), root = norm(ctx.root), tmp = norm(os.tmpdir());
  while (t.startsWith('./') || t.startsWith('.\\')) t = t.slice(2);
  if (/^\.git[\\/]?$/.test(t)) return 'ask';
  const dotTarget = t === '' || t === '.' || t === '*' || t === '*.*';
  const isAbs = /^([A-Za-z]:[\\/]|\/|~|\$HOME|\$\{HOME\}|\$env:USERPROFILE|%USERPROFILE%)/i.test(t);
  const hasDotDot = /(^|[\\/])\.\.([\\/]|$)/.test(t);
  const base = ctx.vcwd === undefined ? ctx.cwd : ctx.vcwd;
  if (base === null && !isAbs) return 'ask'; // the working directory is unknown (cd $VAR, cd -, pushd)
  let resolved;
  try {
    resolved = dotTarget ? path.resolve(base) : fsx.normPath(t.replace(HOME_PREFIX, '~').replace(/[\\/]\*(\.\*)?$/, ''), base);
  } catch { return 'ask'; }
  const verdict = (p, b) => {
    const r = norm(p);
    // the resolved path is judged like a typed one: `cd / && rm -rf etc` or `env -C / rm -rf etc` lands on /etc
    if (SYSTEM_DIRS.some((re) => re.test(p)) || USER_HOME_ROOT.test(p)) return 'deny';
    if (r === b.home || r === norm(path.parse(p).root) || b.home.startsWith(r + sep)) return 'deny';
    if (b.root.startsWith(r + sep)) return 'deny'; // a parent of the project
    if (r === b.root) return 'ask';
    if (r.startsWith(b.root + sep)) return (r.endsWith(sep + '.git') || r.includes(sep + '.git' + sep)) ? 'ask' : 'allow';
    if (isAbs && !hasDotDot && r.startsWith(b.tmp + sep)) return 'allow'; // an explicitly typed temp path
    return 'ask';
  };
  const lexical = verdict(resolved, { home, root, tmp });
  // A symlink inside the project may point anywhere: judge the real location too, against the real locations of
  // home, project and temp (macOS /var -> /private/var, a project reached through a linked folder), keep the worse verdict.
  const realOf = (p) => { try { return fsx.realpathDeep(p); } catch { return p; } };
  const real = realOf(resolved);
  if (norm(real) !== norm(resolved)) {
    const rv = verdict(real, { home: norm(realOf(os.homedir())), root: norm(realOf(ctx.root)), tmp: norm(realOf(os.tmpdir())) });
    const rank = { deny: 2, ask: 1, allow: 0 };
    return rank[rv] > rank[lexical] ? rv : lexical;
  }
  return lexical;
}

/** Follow cd / pushd / Set-Location so later relative targets resolve against the right directory. */
function followCd(toks, ctx) {
  let arg = null;
  for (let k = 1; k < toks.length; k++) {
    const t = toks[k];
    if (/^-(Path|LiteralPath|PSPath)$/i.test(t)) { arg = toks[k + 1] || null; break; }
    if (/^-(Path|LiteralPath|PSPath):/i.test(t)) { arg = t.replace(/^-\w+:/, ''); break; }
    if (t === '-' || t === '+') { arg = t; break; } // previous directory / directory stack: unknown from here
    if (/^(-|\/[a-zA-Z]$)/.test(t)) continue; // /d, -P, -L, -Verbose
    arg = t; break;
  }
  if (arg === null) { ctx.vcwd = /^(pushd|push-location)$/i.test(cmdName(toks[0])) ? null : os.homedir(); return; } // bare cd goes home; bare pushd swaps
  if (arg === '-' || arg === '+') { ctx.vcwd = null; return; }
  const e = arg.replace(HOME_PREFIX, '~');
  if (isUnexpanded(e)) { ctx.vcwd = null; return; }
  const base = ctx.vcwd === undefined ? ctx.cwd : ctx.vcwd;
  try { ctx.vcwd = fsx.normPath(e, base || ctx.cwd); } catch { ctx.vcwd = null; }
}

/** Where a piped delete gets its targets: look back through the pipeline for the producing stage. */
function pipelineSource(segs, i, mode) {
  const out = { targets: [], recursive: false, unknown: true };
  for (let j = i - 1; j >= 0; j--) {
    const s = segs[j];
    if (s.ctl) continue;
    const toks = stripPrefixes(tokens(s.text, mode));
    const name = cmdName(toks[0]);
    if (/^(where-object|\?|select-object|select|sort-object|sort|foreach-object|%|tee-object|tee|grep|head|tail|uniq|sed|awk|cut|tr)$/i.test(name)) { if (!s.afterPipe) break; continue; }
    const args = toks.slice(1).filter((t) => !/^(-|\/[a-zA-Z]$)/.test(t));
    if (/^(gci|ls|dir|get-childitem|get-item|gi|resolve-path|rvpa|echo|write-output|printf|cat|find)$/i.test(name)) {
      out.unknown = false;
      out.targets = name === 'find' ? args.slice(0, 1) : args;
      if (!out.targets.length && /^(gci|ls|dir|get-childitem|find)$/i.test(name)) out.targets = ['.'];
      if (toks.some((t) => /^-recurse$|^-r$|^-R$/i.test(t))) out.recursive = true;
    } else if (toks.length && !/^[a-z]+-[a-z]+$/i.test(toks[0]) && !/^[\w.-]+$/.test(toks[0])) {
      out.unknown = false; out.targets = toks; // a bare literal or variable ("$HOME" | Remove-Item)
    }
    break;
  }
  return out;
}

/** Evaluate the command string handed to an interpreter (bash -c, powershell -Command, cmd /c, eval, -EncodedCommand). */
function innerFromTokens(name, rest, ctx, depth) {
  if (depth >= 2) return null;
  const sub = (text, mode) => evaluate(text, { ...ctx, cwd: ctx.vcwd || ctx.cwd, vcwd: undefined, shell: mode }, depth + 1);
  if (name === 'eval') return sub(rest.join(' '), ctx.shell);
  if (name === 'su') { const k = rest.indexOf('-c'); return k >= 0 && rest[k + 1] ? sub(rest[k + 1], 'posix') : null; }
  if (/^(bash|sh|zsh|dash|ksh|fish)$/.test(name)) {
    for (let k = 0; k < rest.length; k++) if (/^-[a-zA-Z]*c[a-zA-Z]*$/.test(rest[k]) && rest[k + 1] !== undefined) return sub(rest[k + 1], 'posix');
    return null;
  }
  if (name === 'cmd') {
    for (let k = 0; k < rest.length; k++) if (/^\/[ck]$/i.test(rest[k])) return sub(rest.slice(k + 1).join(' '), 'ps');
    return null;
  }
  const isPrefix = (word, t, min) => t.length >= min && word.startsWith(t.toLowerCase());
  for (let k = 0; k < rest.length; k++) {
    const t = rest[k];
    if (!t.startsWith('-')) continue;
    const p = t.slice(1);
    if (isPrefix('command', p, 1)) return sub(rest.slice(k + 1).join(' '), 'ps');
    if (isPrefix('encodedcommand', p, 1) && !isPrefix('executionpolicy', p, 2)) {
      const b64 = rest[k + 1] || '';
      let decoded = '';
      if (/^[A-Za-z0-9+/=]+$/.test(b64)) decoded = Buffer.from(b64, 'base64').toString('utf16le').replace(/\0+$/, '');
      if (!decoded || /[\0-\x08\x0e-\x1f]/.test(decoded)) return { decision: 'ask', why: 'an encoded PowerShell command cannot be inspected' };
      return sub(decoded, 'ps') || null;
    }
  }
  return null;
}

/** Returns { decision: 'deny'|'ask', why } or null. */
function deleteGuard(cmd, ctx, depth = 0) {
  const mode = shellMode(cmd, ctx.shell);
  const segs = splitSegments(cmd, mode);
  ctx = { ...ctx, shell: mode, vcwd: ctx.vcwd === undefined ? ctx.cwd : ctx.vcwd };
  const saved = [];
  let worst = null;
  const note = (r) => { if (!r) return null; if (r.decision === 'deny') return r; worst = worst || r; return null; };
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    if (seg.ctl === 'open') { saved.push(ctx.vcwd); continue; }
    if (seg.ctl === 'close') { if (saved.length) ctx.vcwd = saved.pop(); continue; }
    const toks = stripPrefixes(tokens(seg.text, mode), ctx, mode);
    if (!toks.length) continue;
    const name = cmdName(toks[0]);
    if (CD_CMDS.test(name)) { followCd(toks, ctx); continue; }
    if (INTERP.test(name)) { const r = note(innerFromTokens(name, toks.slice(1), ctx, depth)); if (r) return r; continue; }
    const isPerm = PERM_CMDS.test(name);
    if (!DELETE_CMDS.test(name) && !isPerm) continue;
    const rest = toks.slice(1);
    const flags = rest.filter((t) => /^(-|\/[a-zA-Z]$)/.test(t));
    const isCmd = name === 'rd' || name === 'rmdir' || name === 'del' || name === 'erase';
    // --recursive, -r/-R alone or in a short POSIX bundle (-rf, -Rf, -rfv), PowerShell -Recurse and its prefixes (-Rec), cmd /s;
    // long PowerShell switches that merely contain an r (-Force, -Verbose, -ErrorAction) are not recursion
    let recursive = flags.some((f) => /^--recursive$/i.test(f) || /^-rec(u(r(s(e)?)?)?)?(:\$?true)?$/i.test(f) || (/^-[a-zA-Z]{1,4}$/.test(f) && /r/i.test(f)) || (isCmd && /^\/s$/i.test(f)));
    let targets = [];
    for (let k = 0; k < rest.length; k++) {
      const t = rest[k];
      if (/^-(Path|LiteralPath|Include)$/i.test(t)) { if (rest[k + 1]) targets.push(...rest[k + 1].split(',')); k++; continue; }
      if (/^-(Path|LiteralPath):/i.test(t)) { targets.push(t.replace(/^-\w+:/, '')); continue; }
      if (/^(-|\/[a-zA-Z]$)/.test(t)) continue;
      targets.push(...(t.includes(',') && !/[\\/]/.test(t) ? t.split(',') : [t]));
    }
    if (isPerm) targets.shift(); // the mode / owner argument
    // Pipeline: `Get-ChildItem X -Recurse | Remove-Item -Force`, `echo ~ | xargs rm -rf`, `... | % { Remove-Item $_ -Recurse }`
    const piped = seg.afterPipe || (saved.length && segs.slice(0, i).reverse().find((s) => s.ctl === 'open') || {}).afterPipe;
    let unresolvedPipe = false;
    if (piped && (!targets.length || targets.every(isUnexpanded))) {
      const src = pipelineSource(segs, i, mode);
      if (src.recursive) recursive = true;
      if (!src.unknown && src.targets.length) targets = src.targets; else unresolvedPipe = true;
    }
    if (!recursive) continue;
    if (unresolvedPipe) return { decision: 'ask', why: 'recursive delete of targets that arrive through a pipe (cannot be resolved here)' };
    for (const t of targets) {
      const c = classifyTarget(t, ctx);
      if (c === 'deny') return { decision: 'deny', why: `${isPerm ? 'recursive permission change' : 'recursive delete'} of a home, system or drive-level path (${t})` };
      if (c === 'ask') worst = worst || { decision: 'ask', why: `${isPerm ? 'recursive permission change' : 'recursive delete'} of ${t === '.' || t === '*' || t === '*.*' ? 'the current directory' : t.startsWith('..') ? 'a path outside the project' : isUnexpanded(t) ? `an unresolved target (${t})` : `"${t}"`} (outside the project, the project root, or .git)` };
    }
  }
  return worst;
}

/** Inner command strings run through another interpreter, plus $(...) and `...` substitutions, which execute too. */
function innerCommands(cmd, mode) {
  const posix = shellMode(cmd, mode) === 'posix';
  const out = [];
  const dq = posix ? String.raw`"((?:[^"\\]|\\.)*)"` : String.raw`"([^"]*)"`;
  const re = new RegExp(String.raw`\b(?:bash|sh|zsh|dash|ksh)\s+-[a-zA-Z]*c[a-zA-Z]*\s+(?:${dq}|'([^']*)')|\beval\s+(?:${dq}|'([^']*)')|\b(?:powershell|pwsh)(?:\.exe)?\b[^\n;&|]*?\s-(?:c|Command)\s+(?:${dq}|'([^']*)')|\bcmd(?:\.exe)?\s+\/[cCkK]\s+(?:${dq}|'([^']*)')`, 'gi');
  let m;
  while ((m = re.exec(cmd))) {
    const inner = m[1] ?? m[2] ?? m[3] ?? m[4] ?? m[5] ?? m[6] ?? m[7] ?? m[8];
    if (inner && inner.trim()) out.push(posix ? inner.replace(/\\(["\\$`])/g, '$1') : inner);
  }
  if (posix) {
    // $( ... ) with balanced parens, and `...`
    for (let i = 0; i < cmd.length; i++) {
      if (cmd[i] === '$' && cmd[i + 1] === '(') {
        let d = 0, j = i + 1;
        for (; j < cmd.length; j++) { if (cmd[j] === '(') d++; else if (cmd[j] === ')' && --d === 0) break; }
        const inner = cmd.slice(i + 2, j).trim();
        if (inner) out.push(inner);
        i = j;
      } else if (cmd[i] === '`') {
        const j = cmd.indexOf('`', i + 1);
        if (j < 0) break;
        const inner = cmd.slice(i + 1, j).trim();
        if (inner) out.push(inner);
        i = j;
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Truncation guard: a shell redirect or truncate over a large existing file loses its content as surely as a bad Write

const TRUNC_MIN = 48 * 1024;

function truncateGuard(cmd, ctx, mode) {
  const segs = splitSegments(cmd, mode);
  let vcwd = ctx.cwd;
  for (const seg of segs) {
    if (seg.ctl) continue;
    const toks = tokens(seg.text, mode);
    if (!toks.length) continue;
    const c = { cwd: ctx.cwd, vcwd };
    if (CD_CMDS.test(cmdName(toks[0]))) { followCd(toks, c); vcwd = c.vcwd; continue; }
    const targets = [];
    for (let k = 0; k < toks.length; k++) {
      const t = toks[k];
      if (/^(1|&)?>\|?$/.test(t) && toks[k + 1]) { targets.push(toks[++k]); continue; }
      const m = /^(?:1|&)?>\|?([^>&].*)$/.exec(t);
      if (m && !t.startsWith('>>')) targets.push(m[1]);
    }
    const name = cmdName(toks[0]);
    const args = toks.slice(1);
    if (name === 'truncate' && args.some((t, k) => (t === '-s' && /^0[kmg]?b?$/i.test(args[k + 1] || '')) || /^(-s0|--size=0)$/i.test(t))) targets.push(...args.filter((t, k) => !t.startsWith('-') && args[k - 1] !== '-s'));
    if (name === 'cp' && /^\/dev\/null$/i.test(args.find((t) => !t.startsWith('-')) || '') && args.filter((t) => !t.startsWith('-')).length === 2) targets.push(args.filter((t) => !t.startsWith('-'))[1]);
    if (/^(set-content|sc|out-file)$/i.test(name) && !args.some((t) => /^-append$/i.test(t))) {
      for (let k = 0; k < args.length; k++) {
        const t = args[k];
        if (/^-(Path|LiteralPath|FilePath)$/i.test(t)) { if (args[k + 1]) targets.push(args[k + 1]); break; }
        if (/^-(Path|LiteralPath|FilePath):/i.test(t)) { targets.push(t.replace(/^-\w+:/, '')); break; }
        if (/^-(Value|Encoding|ErrorAction|Width)$/i.test(t)) { k++; continue; }
        if (t.startsWith('-')) continue;
        targets.push(t); break;
      }
    }
    for (const t of targets) {
      if (!t || isUnexpanded(t) || /^\/dev\//.test(t) || /^\$null$/i.test(t) || t === 'nul') continue;
      let abs;
      try { abs = fsx.normPath(t.replace(HOME_PREFIX, '~'), vcwd || ctx.cwd); } catch { continue; }
      const st = fsx.statSafe(abs);
      if (st && st.isFile() && st.size >= TRUNC_MIN) return { decision: 'ask', why: `overwriting ${fsx.toPosix(abs)} (${fsx.humanSize(st.size)}) with a shell redirect replaces the whole file; use Edit for a targeted change` };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------

function evaluate(cmd, ctx, depth = 0) {
  const mode = shellMode(cmd, ctx.shell);
  const noComments = foldGitOptions(scrub(cmd, mode));
  const blanked = foldGitOptions(scrub(cmd, mode, { blankQuotes: true }));
  for (const d of DENY) if (d.re.test(blanked)) return { decision: 'deny', why: d.why };
  const del = deleteGuard(noComments, ctx, depth);
  if (del && del.decision === 'deny') return del;
  for (const a of ASK) if (a.re.test(noComments)) return { decision: 'ask', why: a.why };
  if (del) return del;
  const tr = truncateGuard(noComments, ctx, mode);
  if (tr) return tr;
  if (depth < 2) for (const inner of innerCommands(noComments, mode)) { const r = evaluate(inner, { ...ctx, vcwd: undefined }, depth + 1); if (r) return r; }
  return null;
}

module.exports = { evaluate, deleteGuard, classifyTarget, splitSegments, tokens, innerCommands, truncateGuard, scrub, shellMode, cmdName, stripPrefixes, foldGitOptions, DENY, ASK };
