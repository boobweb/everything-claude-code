---
name: help
description: Explain what the Turbo plugin adds to Claude Code and how to use each part. Use when the user asks what turbo does, how to use a turbo skill or tool, or how to check that the plugin is working.
allowed-tools: Read, Bash(node "${CLAUDE_PLUGIN_ROOT}/mcp/server.js" --selftest), PowerShell(node "${CLAUDE_PLUGIN_ROOT}/mcp/server.js" --selftest), Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/stats.js" *), PowerShell(node "${CLAUDE_PLUGIN_ROOT}/scripts/stats.js" *)
---

# Turbo plugin — what it does

**Speed** (MCP server `code`, tools prefixed `mcp__plugin_turbo_code__`): `repo_map` (ranked project map with symbols), `file_outline` (symbols with exact line ranges from real parsers: acorn for JavaScript and HTML inline scripts, Python's `ast`, the project's `typescript`; regex heuristics for other languages), `find_symbol` (jump to a function/class/array body), `read_range` (numbered lines with huge lines folded), `search` (ripgrep-backed, blob-safe), `syntax_check`, `file_stats`. Use these instead of reading large files whole.

**Safety** (hooks, automatic):
- After every Edit/Write: syntax/integrity check (JS via acorn, HTML inline scripts, JSON, Python, CSS, PowerShell, shell, TS when installed, YAML/XML basics). Failures are reported next to the tool result. JSX inside `.js` is skipped, never flagged.
- Before a Write that would replace a file over 2MB, shrink a file by more than 40%, or contains a "... rest unchanged" placeholder: asks the user.
- Before destructive shell commands: deletes are analyzed structurally (`rm`, `Remove-Item`, `rd`, `del`, pipelines, `bash -c`, `cd` tracking). Recursive deletes of home or any user profile, drive roots or system folders, disk formatting and fork bombs are denied; deletes outside the project, of the project root or `.git`, force pushes, `reset --hard`, `git clean`, download-to-shell pipes, `DROP TABLE` via a DB client and publishing ask first. In-project cleanups pass silently.
- At Stop: re-verifies every file edited in the session (plus git-modified files), capped at 12 seconds, and keeps working if something is broken.
- At SessionStart: a short brief with only what Claude Code does not already show (stack and check commands, large files with embedded blobs, what the last session left behind, the handoff note).

**Options** (`/plugin configure turbo`, or `claude plugin install turbo@turbo-local --config key=value`): `brief` (on/off, default on), `stop_check` (on/off, default on), `guard_level` (`strict` = deny + ask, `deny-only` = only catastrophic commands are denied and nothing asks, `off`; default `strict`). Hooks read them as `CLAUDE_PLUGIN_OPTION_BRIEF`, `CLAUDE_PLUGIN_OPTION_STOP_CHECK`, `CLAUDE_PLUGIN_OPTION_GUARD_LEVEL`; the session brief names any non-default value.

**Skills**: `/turbo:map` orient · `/turbo:patch` surgical edit with Find/Replace/Why/Test · `/turbo:debug` triage (not called / called but failed / completed but UI not updated) · `/turbo:verify` run all checks · `/turbo:smoke` headless browser boot test · `/turbo:handoff` next-session note · `/turbo:perf` measure-first optimization · `/turbo:release` ship checklist · `/turbo:setup` per-project config.

**Subagents**: `turbo:verifier` (independent proof that a change works), `turbo:reviewer` (regression-focused diff review), `turbo:smoke-tester` (runs the browser smoke test and interprets it). Ask for them by name or let Claude delegate.

**Continuity and stats**: every session start reports what the previous session in this project edited and whether it ended clean, plus how many broken edits, guarded commands and held writes Turbo has caught here. The full record (last 6 sessions) prints with `node "${CLAUDE_PLUGIN_ROOT}/scripts/stats.js" --data "${CLAUDE_PLUGIN_DATA}"` (add `--json` for the raw file). Records live under `${CLAUDE_PLUGIN_DATA}/projects/` and are removed when the plugin is uninstalled.

**Health check**: run `node "${CLAUDE_PLUGIN_ROOT}/mcp/server.js" --selftest` (prints OK plus which optional tools were found: ripgrep, python), `/mcp` should list `plugin:turbo:code`, `/hooks` should show the five Turbo hooks. Debug a hook with `claude --debug` or set `TURBO_DEBUG=1` in the environment for verbose stderr.

**Uninstall**: run `node <kit>/install.js --uninstall` (removes the plugin, the marketplace entry and the permission rules the installer added), or `claude plugin uninstall turbo`.
