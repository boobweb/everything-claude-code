---
name: map
description: Orient in a codebase fast. Use at the start of work in an unfamiliar or large project, when asked "how does this project work", "where is X handled", or before planning a multi-file change. Produces a compact architecture brief from indexed symbols instead of reading files one by one.
argument-hint: [focus area, e.g. "auth flow" or "src/engine"]
allowed-tools: mcp__plugin_turbo_code__repo_map, mcp__plugin_turbo_code__file_outline, mcp__plugin_turbo_code__find_symbol, mcp__plugin_turbo_code__read_range, mcp__plugin_turbo_code__search, mcp__plugin_turbo_code__syntax_check, mcp__plugin_turbo_code__file_stats, Read, Glob, Grep
---

# /turbo:map — orient in minutes, not tokens

Goal: understand the project's shape, entry points, data flow and conventions with the fewest, cheapest reads. Focus: $ARGUMENTS (if empty: the whole project).

## Procedure

1. `repo_map` (default args; add `filter` when a focus area was given). Read the stack line and the ranked files.
2. Identify the 2 to 5 files that matter for the focus: entry points (index/main/app/server), the largest source files, anything named after the focus. For each, `file_outline` (not Read). For files over ~100KB or with blobs, never use Read on the whole file; use `read_range` on the lines the outline points to.
3. Trace one concrete path end to end (boot → first screen, request → response, input → state → render) with `find_symbol` on the 3 to 6 functions involved. Stop when the flow is clear; do not read every function.
4. Check conventions: CLAUDE.md / README / package.json scripts (already summarized in the session brief and repo_map). Note test and lint commands.

## Output (keep it under ~40 lines)

**Architecture brief**
- What it is, stack, how it runs (exact commands).
- Entry point and boot sequence (file:line references).
- Core state and where it lives (globals, stores, modules) with file:line.
- Main flows traced (bullet per flow with the functions in order).
- Data/config files and their shapes (arrays of objects: keys; JSON: top-level keys).
- Conventions and traps: naming, formatting, large files with embedded blobs, generated files, places where a syntax error would be catastrophic (single-file apps).
- Where to be careful when editing (shared globals, mode flags, init/boot code, overlays).

Cite `path:line` for every claim so the next step can jump straight there. Do not propose changes here unless asked; this skill is for understanding.
