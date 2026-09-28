# Turbo for Claude Code

A drop-in plugin that makes Claude Code **faster, smarter and safer in every project** you open. Nothing in it is tied to a specific app or codebase.

- **Faster**: an indexed code server so Claude stops reading huge files whole. `repo_map`, `file_outline`, `find_symbol`, `read_range` (long lines folded), ripgrep-backed `search`, `syntax_check`, `file_stats`. A 20MB single-file app costs the same to navigate as a 20KB one.
- **Smarter**: a session brief on every start (stack, git state, layout, large files, your last handoff note), plus skills for orienting, surgical patching, debugging, verification, smoke testing, performance, release and handoff, and three subagents (verifier, reviewer, smoke-tester).
- **Safer**: hooks that syntax-check every file Claude edits (JS, HTML inline scripts, JSON, Python, CSS, PowerShell, shell, TypeScript, YAML/XML basics) and re-verify at the end of the turn, a guard against rewriting or truncating large files, and a guard that denies catastrophic shell commands and asks before risky ones.

Requirements: Claude Code 2.1.2xx or newer, Node.js 18+ (the plugin is plain Node, zero dependencies). Windows, macOS and Linux.

## Install (Windows)

1. Unzip this folder anywhere (Downloads is fine; the installer copies it to `%USERPROFILE%\.claude\turbo-kit`).
2. Open PowerShell in the folder and run:
   ```powershell
   .\install.ps1
   ```
   If PowerShell refuses to run scripts: `powershell -ExecutionPolicy Bypass -File .\install.ps1`
3. Start Claude Code in any project and type `/turbo:help`.

macOS / Linux: `./install.sh` (same options).

Optional: `.\install.ps1 -WithPlaywright` also installs the headless Chromium used by `/turbo:smoke` (about 300MB). Without it, the smoke skill tells you the one-line install command when you first need it.

What the installer does: copies the kit, runs the server self-test, registers the folder as a local plugin marketplace (`turbo-local`), installs the `turbo` plugin at user scope (all projects), and adds a small permission allowlist to `~/.claude/settings.json` (backups written next to it) so Claude does not stop to ask about Turbo's read-only tools and common check commands (`node --check`, `npm test`, `npm run lint/build`, `pytest`), with matching `Bash(...)` and `PowerShell(...)` rules so it works with or without Git Bash. Skip that with `-NoPermissions`.

## What you get

| Piece | Where | What it does |
|---|---|---|
| MCP server `code` | `/mcp` shows `plugin:turbo:code` | 7 tools prefixed `mcp__plugin_turbo_code__` for indexed, bounded reads of files and repos |
| SessionStart hook | automatic | Injects a compact project brief (facts only) so Claude starts oriented |
| PostToolUse hook | after every Edit/Write | Syntax/integrity check of the edited file; failures reported with `file:line:col` |
| PreToolUse hook (Write) | before Writes | Asks before replacing a >2MB file, shrinking a file >40%, or writing "... rest unchanged" placeholders |
| PreToolUse hook (Bash/PowerShell) | before commands | Analyzes deletes structurally (`rm`, `Remove-Item`, `rd`, `del`, pipelines, `bash -c`, `cd` tracking): denies recursive deletes of home, drive roots and system folders, disk formatting and fork bombs; asks before deleting outside the project, the project root or `.git`; asks on force pushes, `reset --hard`, `git clean`, download-to-shell pipes, `DROP TABLE` through a database client, publishing and remote-resource deletes. In-project cleanups (`rm -rf node_modules dist`) pass silently |
| Stop hook | end of every turn | Re-checks every file edited this session (plus git-modified files); keeps Claude working if something is broken (loop-safe) |
| Skills | `/turbo:*` | `map`, `patch`, `debug`, `verify`, `smoke`, `handoff`, `perf`, `release`, `setup`, `help` |
| Subagents | `turbo:verifier`, `turbo:reviewer`, `turbo:smoke-tester` | Independent verification, regression review, browser boot test |
| Smoke test | `plugins/turbo/scripts/smoke.js` | Headless Chromium: loads a folder or URL, waits for the app to become interactive, collects exceptions/console errors/failed requests, screenshot, exit code |

## Verify it is working

Inside Claude Code: `/mcp` lists `plugin:turbo:code` (connected); `/hooks` shows five Turbo hooks; `/turbo:help` prints the overview. From a terminal: `node "%USERPROFILE%\.claude\turbo-kit\plugins\turbo\mcp\server.js" --selftest`.

Run the test suite (builds a throwaway fixture project, exercises every tool and hook, takes about 20s): `node tests\run-tests.js`

## Update

Unzip the new kit and run the installer again; it refreshes the installed copy (the plugin loads in place from `~/.claude/turbo-kit`). Restart Claude Code or run `/reload-plugins` afterwards.

## Uninstall

`node "%USERPROFILE%\.claude\turbo-kit\install.js" --uninstall` (removes the plugin, the marketplace entry and only the permission rules this installer added; leaves the folder for you to delete).

## Troubleshooting

- **`/turbo:*` skills missing**: run `claude plugin list`; `turbo@turbo-local` should be enabled. If not: `claude plugin install turbo@turbo-local`.
- **MCP server not listed**: `node <kit>\plugins\turbo\mcp\server.js --selftest` must print OK; make sure `node` is on PATH for the shell Claude Code was launched from. If the environment variable `CLAUDE_CODE_SKIP_PLUGIN_MCP_SERVERS` is set, plugin servers are disabled by design.
- **Hooks not firing**: hooks from settings and plugins are held until you accept the workspace trust dialog in a new folder. `claude --debug` shows each hook's input/output. `TURBO_DEBUG=1` makes the hooks print timing to stderr.
- **A hook flags a file you intentionally left broken**: tell Claude it is intentional; the Stop check blocks at most once per turn.
- **Turbo tools refuse a path**: by design they read only inside the session's working directories (the folder Claude Code was started in plus `--add-dir` folders); Claude falls back to the Read tool for anything else.
- **PowerShell parse check**: uses `pwsh` or `powershell` if present; Python checks use `py -3`/`python`; TypeScript checks use the project's own `typescript` package. Missing tools are skipped, never reported as errors.
- **Playwright missing** (smoke exit code 3): `npm install -g playwright && npx playwright install chromium`.

## Layout

```
claude-turbo/
├── install.ps1 / install.sh / install.js   installer (copy, self-test, register, permissions)
├── .claude-plugin/marketplace.json          local marketplace "turbo-local"
├── plugins/turbo/                           the plugin
│   ├── .claude-plugin/plugin.json           manifest
│   ├── .mcp.json                            MCP server "code" (node, alwaysLoad)
│   ├── hooks/hooks.json                     5 hooks (exec-form node, cross-platform)
│   ├── mcp/server.js                        zero-dependency MCP stdio server
│   ├── scripts/                             hook scripts + smoke.js
│   ├── lib/                                 shared: indexing, folding, checks, git, stack, hook I/O
│   ├── skills/                              10 skills
│   └── agents/                              3 subagents
└── tests/                                   fixture builder, MCP client, test suite
```

MIT licensed. Built for Brendan Bunzel.
