# turbo (Claude Code plugin)

Faster, smarter, safer Claude Code in any project. See the kit README one level up for install and usage, ARCHITECTURE.md for how it fits together, EVALS.md for measured numbers.

Components: MCP server `code` (`mcp/server.js`; JavaScript, HTML inline scripts, Python and TypeScript parsed with real parsers, acorn vendored under `vendor/`), hooks (`hooks/hooks.json` -> `scripts/hook-*.js`), user options (`brief`, `stop_check`, `guard_level` in `.claude-plugin/plugin.json`), the per-project continuity record (`lib/project.js`, printed by `scripts/stats.js`), skills (`skills/*/SKILL.md`, invoked as `/turbo:<name>`, including `/turbo:tidy`), subagents (`agents/*.md`, `turbo:<name>`), the smoke test (`scripts/smoke.js`), the tidy tool (`scripts/tidy.js`) and the eval suite (`evals/`).

No `npm install` anywhere: the only third-party code is acorn (MIT), vendored. Health check: `node mcp/server.js --selftest`. Debug hooks with `TURBO_DEBUG=1` or `claude --debug`.
