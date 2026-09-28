# Turbo architecture

How the kit is put together, what each piece is responsible for, and the decisions behind it. Read this before changing anything under `plugins/turbo/`.

## Shape

```
claude-turbo/                          local marketplace "turbo-local" (.claude-plugin/marketplace.json)
├── install.js / install.ps1 / install.sh    copies the kit to ~/.claude/turbo-kit, self-tests, registers, adds permissions
├── plugins/turbo/                     the plugin
│   ├── .claude-plugin/plugin.json     manifest: version, userConfig (brief, stop_check, guard_level), experimental.evals
│   ├── .mcp.json                      MCP server "code": node mcp/server.js (stdio, alwaysLoad)
│   ├── hooks/hooks.json               SessionStart, PostToolUse(Edit|Write|MultiEdit), PreToolUse(Write), PreToolUse(Bash|PowerShell), Stop
│   ├── mcp/server.js                  JSON-RPC over stdio, 7 tools, no framework
│   ├── lib/                           everything shared (see below)
│   ├── scripts/                       hook-*.js (one per hook), smoke.js, stats.js, tidy.js
│   ├── skills/<name>/SKILL.md         11 skills, invoked as /turbo:<name>
│   ├── agents/*.md                    3 subagents (verifier, reviewer, smoke-tester)
│   ├── vendor/acorn/                  acorn 8.x, MIT, vendored (the only third-party code)
│   └── evals/                         claude plugin eval cases, fixtures, published results
├── tests/                             run-tests.js + fixture.js + mcp-client.js + parsers.js + guards.js + tidy.js
└── .github/workflows/test.yml         ubuntu/windows/macos matrix (a copy at the ECC repo root actually runs there)
```

Everything is CommonJS, Node 18 or newer, no `npm install` anywhere. Hooks and the server are separate processes started by Claude Code with `node`, so the same code runs identically on Windows without a shell.

## lib/: the shared layer

| module | responsibility |
|---|---|
| `fsx.js` | path normalization (backslashes, `~`, Git Bash `/c/`), bounded directory walk with `.gitignore` support, binary detection, size and line helpers, `dataDir()` (= `CLAUDE_PLUGIN_DATA`, else a temp folder), `findProjectRoot()` |
| `lang.js` | language detection by extension, `outline()` entry point, HTML script/style block location with line numbers, regex heuristics for ~30 languages, Markdown/JSON/CSS outlines, `symbolEnd()` bracket/indent matching for languages without a parser |
| `js-ast.js` | acorn: parse as module or script, walk the AST into symbols with exact `line`/`endLine`, bare `sig` (parameter list) and `mods` (async, static, *, global); `checkJS()` syntax errors with line and column |
| `py-ast.js` | one Python interpreter run outlines up to 40 files at a time through the stdlib `ast` module; results cached by mtime; returns `{error}` for syntax errors |
| `ts-ast.js` | uses the project's own `typescript` package when `require.resolve` finds it (from the file's directory, cwd, or `NODE_PATH`); never bundled (8MB+); same symbol shape |
| `check.js` | per-file-type syntax checks: JS/HTML inline scripts (acorn, then node), JSON (exact error position), Python (`ast.parse`), CSS (brace balance), PowerShell (the real parser via `pwsh`/`powershell`), shell (`bash -n`, Git Bash only on Windows), TypeScript (`transpileModule` diagnostics), YAML tabs, XML tag balance |
| `proc.js` | bounded `spawnSync`, and which `python`/`powershell`/`bash` to use, probed once and cached on disk for a day (a PowerShell start costs 1 to 2 s on Windows) |
| `fold.js` | classify and fold long lines (base64 data URIs, minified code), blob maps with owner labels |
| `git.js` / `stack.js` | read-only git snapshot with timeouts; stack detection from manifest files |
| `hookio.js` | stdin JSON, stdout JSON reply, fail-open `main()`, per-session state file under `dataDir()/sessions/` |
| `options.js` | user options from `CLAUDE_PLUGIN_OPTION_<KEY>` with defaults, tolerant booleans, normalized choices |
| `project.js` | the per-project continuity record under `dataDir()/projects/<sha1 of root>.json`: last 6 sessions (files edited, last known state, clean/unclean end) and counters |

The symbol shape is the contract between parsers and renderers: `{ name, kind, line, endLine?, sig, mods?, exported? }`. For callable kinds `sig` is the bare parameter list and the renderer prints `name(sig)`; `mods` is appended after it. Heuristic extractors produce the same shape without `endLine`, and the server prints `L12-40` only when `endLine` is known.

## The MCP server

`mcp/server.js` implements the stdio transport itself (newline-delimited JSON-RPC 2.0, protocol versions 2025-06-18 down to 2024-11-05, `roots/list` after `initialized`). Seven read-only tools: `repo_map`, `file_outline`, `read_range`, `find_symbol`, `search`, `syntax_check`, `file_stats`. Every tool:

- resolves paths against the project root and refuses anything outside the session roots (`assertInside`), so the model cannot read `/etc/passwd` through it;
- caps output (`max_chars`, default 12,000) and tells the model how to narrow the request;
- uses the outline cache (keyed by path, mtime and size; bounded by bytes and entries) so repeated calls on the same big file cost nothing.

`search` shells out to ripgrep when present (`-e pattern`, literal unless `regex: true`, globs via `-g`) and falls back to a JS scanner that rejects regexes with nested quantifiers. `find_symbol` prefers the parser's `endLine` and falls back to bracket matching. `repo_map` primes the Python outline cache with one interpreter run for all `.py` files it will show.

## Hooks

| hook | script | what it does | budget |
|---|---|---|---|
| SessionStart | `hook-session-start.js` | opens the session state, counts the session in the project record, and (unless `brief=false`) injects: stack and check commands, large files with blob share, the continuity line, the handoff note, one toolkit line. Nothing Claude Code already shows (cwd, git status, commits, layout). Typical size 600 to 900 characters. | 15 s |
| PostToolUse Edit/Write/MultiEdit | `hook-post-edit.js` | syntax-checks the edited file; silent on success, `decision: block` with `file:line:col` on failure; records the file in the session state and the project record | 30 s |
| PreToolUse Write | `hook-pre-write.js` | asks before replacing a file over 2MB, shrinking one over 48KB by more than 40%, or writing a "... rest unchanged" placeholder; only under `guard_level=strict` | 15 s |
| PreToolUse Bash/PowerShell | `hook-pre-bash.js` | structural delete analysis plus deny/ask pattern lists; `deny` for catastrophic commands, `ask` for risky ones (skipped under `deny-only`), nothing under `off` | 15 s |
| Stop | `hook-stop.js` | re-checks every file edited this session plus git-changed files touched since the session began, skipping files already verified and untouched; in-process checks first, spawning ones (Python, PowerShell, shell) last, each spawned checker capped at the budget that is left; blocks once with a report; on the second Stop (`stop_hook_active`) it re-checks for the record but never blocks; disabled by `stop_check=false` | 12 s of checks, 20 s timeout |

All hooks are exec-form (`node` + `args`) so they need no shell and work with paths containing spaces on Windows. Every hook exits 0 on any internal error (`hookio.main`), because a broken hook must never break Claude Code.

## Syntax checking strategy

Acorn runs in-process first (milliseconds, exact line and column). When acorn rejects a file, node confirms, because acorn can trail brand-new syntax: the text is written to a temp file with an explicit kind (`.cjs` or `.mjs`) and checked with `node --check`. Never `.js`: on Node 22 and newer, `node --check some.js` exits 0 for files it auto-detects as ES modules even when they contain syntax errors or JSX, so a `.js` confirmation proves nothing (the v1 checker relied on it and was blind to errors in ESM-style `.js`). If node accepts in any allowed kind the file is fine; if it rejects too and the text looks like JSX or Flow, the file is skipped with a reason rather than reported; otherwise acorn's error is reported. Module kind is strict where the extension or the `<script>` tag decides it (`.mjs`, `.cjs`, `type=module`, classic `<script>`) and auto-detected only for plain `.js`.

## Options

Declared in `plugin.json` `userConfig` and delivered to hooks by Claude Code as `CLAUDE_PLUGIN_OPTION_BRIEF`, `CLAUDE_PLUGIN_OPTION_STOP_CHECK`, `CLAUDE_PLUGIN_OPTION_GUARD_LEVEL`. `options.js` treats a missing or blank variable as the default, accepts `false/0/off/no/disabled` for booleans, and normalizes `guard_level` (`Deny_Only` = `deny-only`; unknown values fall back to `strict`). The manifest does not use the `options` picker key (added to the manifest schema in Claude Code 2.1.271) on purpose: older builds reject unknown manifest keys, and the hook validates the value anyway.

## Continuity record

`lib/project.js` keeps one JSON file per project under `CLAUDE_PLUGIN_DATA/projects/`. Every hook that learns something writes to it: post-edit (file and whether it parsed), pre-bash and pre-write (guard counters), Stop (clean or the list of broken files), session-start (session counter). The brief's continuity line comes from `describe()`: the most recent other session with edits, what it touched, how it ended (or that no Stop check ran), and the running counters. Records are best effort: a corrupt or missing file is an empty record, only the 6 most recent sessions are kept, and `scripts/stats.js` prints the record for `/turbo:help`.

## Tidy

`scripts/tidy.js` is a standalone cleaner for the user's own folders, exposed as `/turbo:tidy`. Scan is read-only: bounded walk that skips VCS, system and "heavy" folders (node_modules and the like are measured, never indexed), then duplicates by size, 64KB head hash and full hash; zero-byte files and empty folders (a folder holding only empty folders counts); junk by name and age; Claude Code leftovers (transcript folders whose recorded `cwd` no longer exists, old logs, byte-identical skill folders); archives next to an extracted folder. `--apply` moves the chosen categories into `<root>/_turbo-quarantine/<timestamp>/` keeping relative paths, writes `manifest.json` as it goes (cross-volume moves copy, verify size, then remove), and `--undo` restores from the manifest. It never deletes a file.

## Evals

`plugins/turbo/evals/` holds five `claude plugin eval` cases with scaffolds that copy a fixture into the run's empty temp directory, graders (regex on answer or file, LLM rubric, tool-usage checks) and `summarize.js` for the tables in `EVALS.md`. Fixtures are generated from `tests/fixture.js` (`evals/make-fixtures.js`) so evals and tests agree on line numbers. Local runs land in `evals/results/` (git-ignored); the runs behind `EVALS.md` are kept under `evals/published/` with token counts embedded (`summarize.js --embed`), since the traces they came from live in temp directories.

## Tests and CI

`node tests/run-tests.js` builds a fixture project in a temp directory and runs about 290 checks: static checks on the kit (every js/json parses, hooks.json handlers exist, frontmatter is strict-YAML safe), parser units (exact ranges, module detection, JSX skip, Python and TypeScript exactness when available), guard and path units with per-platform expectations, tidy report/apply/undo, the MCP server end to end over stdio, every hook with real payloads, the Playwright smoke test when Playwright is installed, and `claude plugin validate` when the CLI is installed. Optional tools are skipped, never failed. The GitHub Actions matrix installs typescript, Playwright and the claude CLI so all of it runs on ubuntu, windows and macos with Node 20 and 24.

## Decisions worth knowing

- **Zero dependencies, vendored acorn.** A plugin that needs `npm install` fails on machines without a working npm, and a dependency tree is an attack surface; acorn is 150KB of MIT code and covers JavaScript completely. TypeScript is not bundled (8MB) but used when the project has it.
- **Real parsers, heuristic fallback.** Exact ranges matter for `find_symbol` and for `read_range` cost; when a file does not parse (mid-edit) the regex outline still gives the model something to navigate with, labeled `heuristic`.
- **The brief contains only what Claude Code lacks.** Every character of the brief is paid on every turn of every session. Measured overhead of the whole plugin per model call: about 3.7k tokens (skills and agents about 1.4k, tool schemas about 2k, brief about 0.2k); see `EVALS.md`. Measure it any time with the SessionStart hook on a real repo (it logs the size under `TURBO_DEBUG=1`).
- **Guards are a safety net, not a sandbox.** The command guard analyzes the command text structurally; anything it cannot classify passes. It denies only what is catastrophic on any machine and asks for the rest so the user stays in control.
- **Hooks fail open, tools fail closed.** A hook error must never block the user's work; a tool refusing a path outside the project is the right default.
