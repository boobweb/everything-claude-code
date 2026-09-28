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
- **Tests.** 289 checks on a bare machine, more with optional tools (was 143): parser units, guard and path units with per-platform expectations, tidy, options, continuity record, strict-YAML frontmatter.
- **Packaging.** `package.js` builds the distributable zip with no dependencies; CI uploads it as an artifact.

### Changed
- The session brief drops git status, recent commits, layout and cwd (Claude Code already shows them) and keeps the stack, check commands, large files with blob share, continuity, the handoff note and one toolkit line: 600 to 900 characters instead of about 2,500.
- MCP tool descriptions and server instructions cut to one sentence each; `repo_map` hides scalar state and accessors.
- Stop check budget 40 s to 12 s, enforced per file (spawned checkers get the remaining budget as their timeout; in-process checks run first); hook timeouts 90/60/20 s to 20/30/15 s.
- Explicit module kind is strict: `.mjs` and `<script type=module>` parse only as modules, `.cjs` and classic `<script>` only as scripts; plain `.js` auto-detects.
- The command guard denies recursive deletes of any user profile root (`C:\Users\name`, `/home/name`, `/Users/name`), not only the current user's.
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
