---
name: webapp-search-usages
description: List every use of one variable in the 360KB single-file app with line numbers and enclosing functions. Grep already does this cheaply, so Turbo is not expected to win here.
tags: [webapp, read-only, control]
runs: 2
max_turns: 12
timeout_seconds: 300
allowed_tools: [Read, Glob, Grep, mcp__plugin_turbo_code__search, mcp__plugin_turbo_code__file_outline, mcp__plugin_turbo_code__read_range, mcp__plugin_turbo_code__find_symbol]
---

In `index.html`, list every line where the variable `bossHp` appears, with its line number, and name the function each line belongs to (or say it is top-level). Do not modify any file.
