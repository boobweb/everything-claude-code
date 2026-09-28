# turbo (Claude Code plugin)

Faster, smarter, safer Claude Code in any project. See the kit README one level up for install and usage.

Components: MCP server `code` (`mcp/server.js`, zero dependencies), hooks (`hooks/hooks.json` → `scripts/hook-*.js`), skills (`skills/*/SKILL.md`, invoked as `/turbo:<name>`), subagents (`agents/*.md`, `turbo:<name>`), smoke test (`scripts/smoke.js`).

Health check: `node mcp/server.js --selftest`. Debug hooks with `TURBO_DEBUG=1` or `claude --debug`.
