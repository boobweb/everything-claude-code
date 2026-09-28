# Turbo for Claude Code

A drop-in plugin that makes Claude Code **faster, smarter and safer in every project** you open. Nothing in it is tied to a specific app or codebase, and nothing in it needs `npm install`.

- **Faster**: an indexed code server so Claude stops reading huge files whole. `repo_map`, `file_outline` (exact line ranges from real parsers), `find_symbol`, `read_range` (long lines folded), ripgrep-backed `search`, `syntax_check`, `file_stats`. A 20MB single-file app costs the same to navigate as a 20KB one.
- **Smarter**: a short session brief with only what Claude Code does not already show (stack and check commands, large files with embedded blobs, what the last session left behind, your handoff note), 11 skills (`/turbo:map`, `patch`, `debug`, `verify`, `smoke`, `handoff`, `perf`, `release`, `setup`, `tidy`, `help`) and three subagents (verifier, reviewer, smoke-tester).
- **Safer**: hooks that syntax-check every file Claude edits (JavaScript via acorn, HTML inline scripts, JSON, Python, CSS, PowerShell, shell, TypeScript, YAML/XML basics) and re-verify at the end of the turn, a guard against rewriting or truncating large files, and a guard that denies catastrophic shell commands and asks before risky ones.
- **Measured**: with-vs-without evals on two models in [EVALS.md](EVALS.md), including where the plugin does not help.

Requirements: Claude Code 2.1.283 or newer (the version v2 was built and tested against; older 2.1.2xx builds load the plugin but may not offer the options dialog), Node.js 18 or newer (CI runs 18, 20 and 24). Windows, macOS and Linux. Optional: ripgrep (faster search), Python 3 (exact Python outlines and checks), a `typescript` package in the project (TypeScript outlines and checks), Playwright (`/turbo:smoke`).

## Install (Windows)

1. Unzip the kit anywhere (Downloads is fine; the installer copies it to `$env:USERPROFILE\.claude\turbo-kit`).
2. Open PowerShell in the folder and run:
   ```powershell
   .\install.ps1
   ```
   If PowerShell refuses to run scripts: `powershell -ExecutionPolicy Bypass -File .\install.ps1`
3. Start Claude Code in any project and type `/turbo:help`.

macOS / Linux: `./install.sh` (same options).

Optional: `.\install.ps1 -WithPlaywright` also installs the headless Chromium used by `/turbo:smoke` (about 300MB). Without it, the smoke skill tells you the one-line install command when you first need it.

What the installer does: copies the kit, runs the server self-test, registers the folder as a local plugin marketplace (`turbo-local`), installs the `turbo` plugin at user scope (all projects), and edits `~/.claude/settings.json` (backups written next to it): an `allow` list for Turbo's read-only tools and common check commands (`node --check`, `npm test`, `npm run lint/build`, `pytest`) and an `ask` list for `git push --force`, `git reset --hard` and `git clean`, each with matching `Bash(...)` and `PowerShell(...)` rules so it works with or without Git Bash. Skip that with `-NoPermissions`. Other switches: `-InPlace` (use the folder where it is instead of copying), `-DryRun` (show what would happen), `-Uninstall`.

## What you get

| Piece | Where | What it does |
|---|---|---|
| MCP server `code` | `/mcp` shows `plugin:turbo:code` | 7 read-only tools prefixed `mcp__plugin_turbo_code__` for indexed, bounded reads of files and repos. JavaScript, HTML inline scripts, Python and TypeScript are parsed by real parsers, so symbol ranges are exact; other languages use heuristics |
| SessionStart hook | automatic | A brief of 600 to 900 characters (150 to 250 tokens): stack and check commands, large files (with the share of embedded base64), what the previous session edited and whether it ended clean, counters of what Turbo caught here, the handoff note, one line on the tools |
| PostToolUse hook | after every Edit/Write | Syntax/integrity check of the edited file; failures reported with `file:line:col`. JSX inside `.js` is skipped, never flagged |
| PreToolUse hook (Write) | before Writes | Asks before replacing a file over 2MB, shrinking a file over 48KB by more than 40%, or writing "... rest unchanged" placeholders |
| PreToolUse hook (Bash/PowerShell) | before commands | Analyzes deletes structurally (`rm`, `Remove-Item`, `rd`, `del`, pipelines, `bash -c`, `cd` tracking): denies recursive deletes of any user profile, drive roots and system folders, disk formatting and fork bombs; asks before deleting outside the project, the project root or `.git`; asks on force pushes, `reset --hard`, `git clean`, download-to-shell pipes, `DROP TABLE` through a database client, publishing and remote-resource deletes. In-project cleanups (`rm -rf node_modules dist`) pass silently |
| Stop hook | end of every turn | Re-checks every file edited this session (plus git-modified files), capped at 12 seconds; keeps Claude working if something is broken (blocks at most once per turn) |
| Skills | `/turbo:*` | `map`, `patch`, `debug`, `verify`, `smoke`, `handoff`, `perf`, `release`, `setup`, `tidy`, `help` |
| Subagents | `turbo:verifier`, `turbo:reviewer`, `turbo:smoke-tester` | Independent verification, regression review, browser boot test |
| Smoke test | `plugins/turbo/scripts/smoke.js` | Headless Chromium: loads a folder or URL, waits for the app to become interactive, collects exceptions/console errors/failed requests, screenshot, exit code |
| Tidy | `plugins/turbo/scripts/tidy.js`, `/turbo:tidy` | Finds duplicates, empty files and folders, junk, Claude Code leftovers and stale caches on any folder or drive; reports first, quarantines only on request, never deletes |

## Options

Set with `/plugin configure turbo` inside Claude Code (or `claude plugin install turbo@turbo-local --config key=value`):

| option | values | default | effect |
|---|---|---|---|
| `brief` | on / off | on | the SessionStart briefing |
| `stop_check` | on / off | on | the end-of-turn re-verification |
| `guard_level` | `strict`, `deny-only`, `off` | `strict` | `strict` denies catastrophic commands and asks before risky ones and large-file rewrites; `deny-only` only denies, never asks; `off` disables both guards |

The brief names any non-default option so you always know what is active.

## Continuity

Turbo keeps a small record per project under the plugin's data directory (Claude Code creates it as `~/.claude/plugins/data/turbo-turbo-local/`; `stats.js` prints the path it found): the last six sessions, which files each edited, whether it ended with everything parsing, and counters of broken edits caught, commands guarded and risky writes held. The next session's brief starts with it ("Last session (2h ago) edited src/app.js, index.html; ended clean."). Print the whole record with:

```powershell
node "$env:USERPROFILE\.claude\turbo-kit\plugins\turbo\scripts\stats.js" --root <project>
```

Claude Code deletes the plugin's data directory, record included, when the plugin is uninstalled (unless `--keep-data` is passed).

## Cleaning up a drive

`/turbo:tidy C:\Users\you` (or any folder) scans read-only and reports byte-identical duplicates (the copy in the shortest path that is not named like a copy is kept), zero-byte files and empty folders, `Thumbs.db`/`.DS_Store`/Office lock files/stale partial downloads, Claude Code leftovers (transcripts of projects that no longer exist, old logs, duplicated skill folders), heavy regenerable folders (`node_modules`, virtualenvs, caches untouched for months) and archives sitting next to their extracted folder. On request it moves the categories you choose into `<folder>\_turbo-quarantine\<timestamp>\` with a manifest; `--undo` puts everything back. From a terminal:

```powershell
node "$env:USERPROFILE\.claude\turbo-kit\plugins\turbo\scripts\tidy.js" C:\Users\you\Downloads
node "$env:USERPROFILE\.claude\turbo-kit\plugins\turbo\scripts\tidy.js" C:\Users\you\Downloads --apply --only duplicates,empty,junk
node "$env:USERPROFILE\.claude\turbo-kit\plugins\turbo\scripts\tidy.js" --undo "C:\Users\you\Downloads\_turbo-quarantine\2026-09-28T13-00-00"
```

(In cmd.exe write `%USERPROFILE%` instead of `$env:USERPROFILE`.)

## Verify it is working

Inside Claude Code: `/mcp` lists `plugin:turbo:code` (connected); `/hooks` shows five Turbo hooks; `/turbo:help` prints the overview. From a PowerShell terminal: `node "$env:USERPROFILE\.claude\turbo-kit\plugins\turbo\mcp\server.js" --selftest`.

Run the test suite (builds a throwaway fixture project, exercises every parser, tool, hook and the tidy script; 15 to 30 s): `node tests\run-tests.js`. It reports 289 checks on a bare machine and a few more when optional tools are present (Python, typescript, Playwright, the claude CLI); missing ones are skipped and named, never failed.

## Update

Unzip the new kit and run the installer again; it refreshes the installed copy (the plugin loads in place from `~/.claude/turbo-kit`). Restart Claude Code or run `/reload-plugins` afterwards.

## Uninstall

`node "$env:USERPROFILE\.claude\turbo-kit\install.js" --uninstall` (removes the plugin, the marketplace entry and only the permission rules this installer added; leaves the folder for you to delete).

## Troubleshooting

- **`/turbo:*` skills missing**: run `claude plugin list`; `turbo@turbo-local` should be enabled. If not: `claude plugin install turbo@turbo-local`.
- **MCP server not listed**: `node <kit>\plugins\turbo\mcp\server.js --selftest` must print OK; make sure `node` is on PATH for the shell Claude Code was launched from. If the environment variable `CLAUDE_CODE_SKIP_PLUGIN_MCP_SERVERS` is set, plugin servers are disabled by design.
- **Hooks not firing**: hooks from settings and plugins are held until you accept the workspace trust dialog in a new folder. `claude --debug` shows each hook's input/output. `TURBO_DEBUG=1` makes the hooks print timing to stderr.
- **A hook flags a file you intentionally left broken**: tell Claude it is intentional; the Stop check blocks at most once per turn. Or set `stop_check` off.
- **The command guard asks too often**: set `guard_level` to `deny-only`.
- **Turbo tools refuse a path**: by design they read only inside the session's working directories (the folder Claude Code was started in plus `--add-dir` folders); Claude falls back to the Read tool for anything else.
- **PowerShell parse check**: uses `pwsh` or `powershell` if present; Python checks use `py -3`/`python`; TypeScript checks use the project's own `typescript` package. Missing tools are skipped, never reported as errors. Which one was found is cached for a day in the plugin data directory (`probes.json`).
- **Playwright missing** (smoke exit code 3): `npm install -g playwright` then `npx playwright install chromium` (two commands; Windows PowerShell 5.1 has no `&&`).

## Development

- `node tests/run-tests.js` before every commit (`--keep` keeps the fixture directory).
- `node package.js` zips the working tree (minus `.git`, `node_modules`, `dist`, eval results and quarantine folders) into `dist/turbo-<version>.zip` for distribution.
- Evals: see `plugins/turbo/evals/README.md` and [EVALS.md](EVALS.md).
- How it all fits together: [ARCHITECTURE.md](ARCHITECTURE.md). What changed: [CHANGELOG.md](CHANGELOG.md).

## Layout

```
claude-turbo/
├── install.ps1 / install.sh / install.js   installer (copy, self-test, register, permissions)
├── package.js                               builds the distributable zip
├── .claude-plugin/marketplace.json          local marketplace "turbo-local"
├── plugins/turbo/                           the plugin
│   ├── .claude-plugin/plugin.json           manifest, userConfig options
│   ├── .mcp.json                            MCP server "code" (node, alwaysLoad)
│   ├── hooks/hooks.json                     5 hooks (exec-form node, cross-platform)
│   ├── mcp/server.js                        zero-dependency MCP stdio server
│   ├── scripts/                             hook scripts, smoke.js, stats.js, tidy.js
│   ├── lib/                                 shared: parsers, checks, folding, options, continuity record
│   ├── vendor/acorn/                        acorn (MIT), the only third-party code
│   ├── skills/                              11 skills
│   ├── agents/                              3 subagents
│   └── evals/                               claude plugin eval cases, fixtures, published results
├── tests/                                   fixture builder, MCP client, test suite
└── .github/workflows/test.yml               CI matrix (ubuntu, windows, macos)
```

MIT licensed. Built for Brendan Bunzel.
