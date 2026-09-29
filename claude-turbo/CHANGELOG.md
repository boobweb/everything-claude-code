# Changelog

## 2.0.0 (2026-09-28)

Real parsers, less context, continuity, measured evals, cross-platform CI, and a cleanup tool.

### Added
- **Exact symbols.** JavaScript and HTML inline scripts are parsed with acorn (vendored, MIT), Python with the interpreter's `ast` module, TypeScript with the project's own `typescript` when present. `file_outline` prints exact `L<start>-<end>` ranges and the parser used; `find_symbol` returns the exact body; exported symbols, `async`/`static`/generator modifiers, decorators and return types are shown.
- **User options** (`/plugin configure turbo`): `brief`, `stop_check`, `guard_level` (`strict`, `deny-only`, `off`), read by the hooks from `CLAUDE_PLUGIN_OPTION_<KEY>`.
- **Continuity.** A per-project record under the plugin data directory: what the last session edited and whether it ended clean, plus counters for broken edits caught, commands guarded and risky writes held. Shown in the session brief; `scripts/stats.js` prints the full record.
- **/turbo:tidy** and `scripts/tidy.js`: finds byte-identical duplicates, empty files and folders, system junk, Claude Code leftovers (transcripts of deleted projects, old logs, duplicate skill folders), stale caches and already-extracted archives. Report by default; `--apply` quarantines with a manifest; `--undo` restores. Never deletes.
- **Evals.** Five `claude plugin eval` cases with fixtures, graders and a summarizer; results for Sonnet and Opus in `EVALS.md`.
- **CI.** GitHub Actions matrix on ubuntu, windows and macos with Node 20 and 24, with typescript, Playwright and the claude CLI installed so every code path runs.
- **Tests.** About 450 checks on a bare machine, more with optional tools (was 143): parser units, guard and path units with per-platform expectations, a 120-case security table, tidy, options, continuity record, strict-YAML frontmatter.
- **SECURITY.md**: threat model, what each guard enforces, what it does not, and the adversarial review history.
- **Packaging.** `package.js` builds the distributable zip with no dependencies; CI uploads it as an artifact.

### Changed
- The session brief drops git status, recent commits, layout and cwd (Claude Code already shows them) and keeps the stack, check commands, large files with blob share, continuity, the handoff note and one toolkit line: 600 to 900 characters instead of about 2,500.
- MCP tool descriptions and server instructions cut to one sentence each; `repo_map` hides scalar state and accessors.
- Stop check budget 40 s to 12 s, enforced per file (spawned checkers get the remaining budget as their timeout; in-process checks run first); hook timeouts 90/60/20 s to 20/30/15 s.
- Explicit module kind is strict: `.mjs` and `<script type=module>` parse only as modules, `.cjs` and classic `<script>` only as scripts; plain `.js` auto-detects.
- The command guard denies recursive deletes of any user profile root (`C:\Users\name`, `/home/name`, `/Users/name`), not only the current user's.
- The command guard moved to `lib/cmdguard.js` and was rebuilt after an adversarial security review (22 findings, all fixed with regression tests): variables, substitutions and parenthesized expressions in a delete target ask instead of resolving "inside the project"; subshells and `{ }` blocks are tracked; bare `powershell -Command ...`, `-EncodedCommand` (decoded), `& { }`, `eval`, `bash -lc` and `$'...'` are analyzed; `/bin/rm`, `\rm`, `env`, `nice`, `timeout`, `doas`, `sudo -u` prefixes are stripped; `ForEach-Object`/`Get-Item`/literal pipelines into `Remove-Item` resolve their source; `\"` escapes are understood; bare `cd`, `Push-Location` and `-Path` are followed; a symlink is judged by its real target; recursive `chmod`/`chown` of system or home paths deny; more `git push` spellings, `del /s /q *.*`, `robocopy /MIR` and `shutil.rmtree('/')` one-liners ask; a shell redirect, `truncate` or `Set-Content` over a file larger than 48 KB asks; hard denies no longer fire on commit messages, grep patterns or comments.
- The MCP server checks every path after `realpath` as well as lexically (a symlink inside the project cannot read outside it), clamps `max_chars` to 200,000, always folds lines over 64 KB, and rejects more catastrophic regexes in the JS search fallback.
- The plugin data directory without `CLAUDE_PLUGIN_DATA` is a private per-user cache directory instead of a shared temp path; cached probe commands are honored only when they are one of the fixed candidates.
- The installer's user-scope allowlist holds the MCP tools only: no shell command, not even `node --check` (it runs `-r` preloads). `npm test`, `npm run build`, `pytest` and `node --check` are printed as a suggestion for project scope instead. Updating replaces the installed kit tree instead of merging into it. Requiring `install.js` no longer runs it.
- From the Codex review of the pull request: the smoke static server judges paths with `path.relative` after decoding (an encoded `..` could reach a sibling folder); the command guard honors `env -C`/`--chdir`, `env -S`/`--split-string` and `sudo -D`, and folds git global options (`git -C dir push --force`, `git --no-pager reset --hard`) before matching; a ripgrep error (bad regex or glob) is a tool error instead of "0 matches"; tidy checks every transcript's own cwd so a slug folder shared by a deleted and a live project loses only the orphaned transcripts; `--undo` resolves symlinks and restores only under the scanned roots or the Claude directory.
- tidy: overlapping roots are scanned once; project folders are units (`--include-projects` to opt in); `__init__.py`, `.gitkeep`, dotfiles and code stubs are never empty-file candidates; only a personal skill under `~/.claude/skills` can be a duplicate-skill candidate and nothing under `~/.claude/plugins` is ever moved; the manifest is written after every move with an append-only `moves.log`; `--undo` accepts only moves that land inside the quarantine folder; cross-volume directory moves are verified before the source is removed; `dev`, `sys`, `proc` are skipped only at a filesystem root.
- Python outlines for `repo_map` and `find_symbol` run in one interpreter process instead of one per file.

### Fixed
- Syntax checking could not see errors in ESM-style `.js` files on Node 22 and newer: `node --check some.js` exits 0 for auto-detected ES modules even with syntax errors or JSX. Acorn is now the primary checker and node confirms with strict `.cjs`/`.mjs` temp files.
- Skill frontmatter contained values that are invalid YAML (`argument-hint: [file] [what to change]`, descriptions with `: `). Newer `claude plugin validate` rejects them and the skill would load with empty metadata. All values are quoted and a test parses every skill and agent frontmatter.
- Nested Python classes are qualified (`Outer.Inner.method`); TypeScript constructors are listed.

### Compatibility
- Built and tested against Claude Code 2.1.283 (options, `CLAUDE_PLUGIN_DATA`, exec-form hooks and the PowerShell tool for Windows without Git Bash); Node 18 or newer; no dependencies. The `userConfig` manifest keys avoid the newer `options` picker so older CLI builds still validate the plugin.
- The session brief now names the plugin version and any non-default option.

## 1.0.0

First release: the `code` MCP server (repo_map, file_outline, find_symbol, read_range, search, syntax_check, file_stats), five hooks (session brief, post-edit syntax check, write guard, command guard, stop-time re-check), 10 skills, 3 subagents, the Playwright smoke test, the installer, 143 automated checks.
