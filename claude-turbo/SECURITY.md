# Security

What Turbo protects, what it does not, how it was attacked, and what to do if you find a hole.

## Threat model

Turbo runs on a developer's machine with that developer's rights, inside Claude Code. The actor it defends against is not a hostile human: it is a model that means well and gets a command, a path or a Write wrong. The kit therefore has two jobs:

1. **Contain the model's reach.** The MCP tools read only inside the session's working directories. The hooks never grant anything; they can only deny or ask.
2. **Stop the accidents that cannot be undone.** Recursive deletes of a home, drive or system path; force pushes; truncating a large file; piping a download into a shell.

Out of scope: a malicious user of the machine (the plugin runs as them), sandboxing (Claude Code's permission system and the OS do that), and secrets (Turbo stores none; its data directory holds parse results, probe results and session records).

## What the guards enforce

**Command guard** (`lib/cmdguard.js`, PreToolUse on Bash and PowerShell). Denies are unconditional; asks are skipped under `guard_level=deny-only`; nothing runs under `off`.

- *Deny*: recursive delete or recursive permission change of a home directory (any user's, `~name`, `$HOME`, `%USERPROFILE%`, `$env:APPDATA`, `%HOMEDRIVE%%HOMEPATH%` and the like), a drive root, a system directory, or a parent of the project; `mkfs`, `dd`/redirect to a block device, `format`, `diskpart`, disk cmdlets, `--no-preserve-root`, `find / -delete`, fork bombs.
- *Ask*: recursive delete of the project root, `.git`, anything outside the project, or a target the guard cannot resolve (a variable, a `$(...)` substitution, a `%VAR%`, a parenthesized expression, a working directory it lost track of, targets arriving through a pipe, an encoded command); force pushes and other history rewrites; `git clean`, `reset --hard`, `checkout -- .`; bulk `find -delete`, `xargs rm -r`, `robocopy /MIR`; downloads piped into interpreters; destructive SQL, cloud and container cleanups; `shutil.rmtree('/')`-style one-liners; a shell redirect, `truncate` or `Set-Content` that would overwrite an existing file over 48 KB.
- The analysis is structural: segments split on `;`, `&&`, `||`, `|`, `&` and newlines; subshells and blocks tracked; quotes, `\"` escapes, `$'...'` and PowerShell backtick escapes understood; `cd`/`pushd`/`Set-Location` followed (bare `cd` goes home); prefixes such as `sudo -u root`, `env`, `nice`, `timeout 30`, `xargs -I {}` stripped; `/bin/rm`, `\rm`, `cmd.exe` matched by basename; `bash -c`, `powershell -Command`, `cmd /c`, `eval` and `-EncodedCommand` (decoded) evaluated recursively (two levels); a symlink inside the project is judged by where it really points.
- Pattern rules run on the command with comments removed, and the deny list additionally with quoted text blanked, so a commit message or grep pattern cannot trigger a hard deny.

**Write guard** (`scripts/hook-pre-write.js`, PreToolUse on Write, strict only): asks before a Write replaces a file over 2 MB, shrinks a file over 48 KB by more than 40 %, writes a "... rest unchanged" placeholder, or carries no string content.

**MCP server** (`mcp/server.js`): every path must be inside a session root both lexically (no `..` escape) and after `realpath` (no symlink escape); output is capped at 200,000 characters per call whatever `max_chars` says; lines over 64 KB are folded even with `fold:false`; the JS search fallback rejects regexes with nested quantifiers (ripgrep, the usual engine, is linear-time). The tools are read-only.

**Data on disk**: `CLAUDE_PLUGIN_DATA` when Claude Code provides it, otherwise a private per-user directory (`~/.cache/claude-turbo` or `%LOCALAPPDATA%\claude-turbo`, mode 0700, ownership checked) and never a world-shared temp path. Cached probe results (`probes.json`) are used only when they name one of the fixed candidate commands (`python3`, `py -3`, `pwsh`, ...); anything else is ignored and re-probed, so a tampered data file can never become a command to run.

**Installer**: the user-scope `allow` list holds the seven MCP tools and no shell command at all. Test and build runners (`npm test`, `npm run build`, `pytest`) execute whatever a cloned repository says, and even `node --check` is not read-only (`node --check -r ./x.js y.js` runs `x.js` as a preload; verified on Node 24), so syntax checks go through Turbo's `syntax_check` tool and project runners belong in that project's `.claude/settings.json`. Updating replaces the installed kit tree (files a release removed do not linger and keep loading). Requiring `install.js` from another script installs nothing.

**Smoke server** (`scripts/smoke.js`): the static server used by `/turbo:smoke` serves only paths inside the served folder, judged with `path.relative` after URL decoding, so `/%2e%2e%2f...` cannot reach a sibling folder whose name starts with the root's name.

**tidy**: never deletes; `--apply` moves into a quarantine folder with a manifest that is rewritten after every move and an append-only `moves.log`; `--undo` restores only entries that point into that quarantine folder; overlapping roots are scanned once (a file cannot be its own duplicate); project folders and program folders (an `.exe` or a macOS `.app` bundle directly inside) are units (nothing inside them is a duplicate or an empty file unless `--include-projects`); `__init__.py`, `.gitkeep`, dotfiles and code stubs are never "empty files"; `desktop.ini` is never junk; nothing under `~/.claude/plugins` is ever moved.

## What the guards do not do

- They are a safety net, not a sandbox. A command the analysis cannot classify passes (or asks); Claude Code's own permission system remains the authority.
- Interpreters other than shells (`python -c`, `node -e`) are covered only for the obvious home/root one-liners.
- The guard cannot see the content of a file passed to `xargs` or a script run by name; it asks in those cases.
- `deny-only` and `off` exist because a user may prefer fewer prompts; they widen what passes.

## Review history

Version 2.0.0 went through three adversarial review rounds before release (product, correctness, security), followed by an automated Codex review of the pull request whose eight findings (four P1) were all fixed with regression tests: the `node --check` allow rule, the smoke server path boundary, `env -C`/`env -S`/`sudo -D` and git global options in the command guard, ripgrep errors reported as "0 matches", tidy quarantining a live project's transcripts that shared a slug folder with a deleted one, `--undo` through a planted symlink, and the installer merging updates instead of replacing the kit. The security round executed 120+ crafted commands against the guard and reported 22 findings (10 high). All 22 were fixed in `lib/cmdguard.js`, `mcp/server.js`, `lib/proc.js`, `lib/fsx.js`, `install.js`, `scripts/hook-pre-write.js` and `scripts/tidy.js`, each with a regression test that names the finding (`tests/guards.js`, `tests/tidy.js`, `tests/run-tests.js`). The suite runs 450+ checks on ubuntu, windows and macos in CI.

Findings, in short: shell variables and substitutions in delete targets resolved as if literal; subshell parentheses defeated `cd` tracking; only quoted interpreter arguments were inspected (bare `powershell -Command ...`, `-EncodedCommand`, `& { }` passed); path-qualified or prefixed delete commands (`/bin/rm`, `\rm`, `env`, `timeout`, `doas`, `sudo -u`) passed; PowerShell pipelines through `ForEach-Object`/`Get-Item` passed; `-Recurse:$true` was not recursion; backslash-escaped quotes swallowed the rest of a line; bare `cd`, `Push-Location` and `-Path` were not followed; MCP tools followed symlinks out of the project; tidy with overlapping roots quarantined the only copy of a file; tidy's defaults moved `__init__.py` and cross-project duplicates; tidy moved skills out of plugin storage; hard denies fired on commit messages; a poisoned `probes.json` in a shared temp directory yielded command execution; the installer allowed project test runners at user scope; `rm -rf symlink/` emptied a tree outside the project; a Bash redirect bypassed the Write guard; `--undo` trusted manifest paths; the manifest was flushed every 50 moves; `dev`/`sys`/`proc` were skipped at any depth; quadratic HTML regexes and an unbounded `max_chars`; recursive `chmod` of `~`, more `git push` spellings, `del /s /q *.*`, `robocopy /MIR`, interpreter one-liners.

## Reporting

Open an issue or a pull request with the exact command or path and the verdict you expected. Add the case to the `SEC` table in `tests/guards.js` (one line: command, expected verdict) so it stays fixed.
