---
name: webapp-surgical-edit
description: Make a one-line change inside a 360KB single-file web app without rewriting it or damaging the embedded assets. Measures edit precision and whether the file survives intact.
tags: [webapp, edit, safety]
runs: 2
max_turns: 15
timeout_seconds: 300
allowed_tools: [Read, Glob, Grep, Edit, Write, mcp__plugin_turbo_code__file_outline, mcp__plugin_turbo_code__find_symbol, mcp__plugin_turbo_code__read_range, mcp__plugin_turbo_code__search, mcp__plugin_turbo_code__syntax_check]
---

In `index.html`, change the function `S(id)` so that, after it activates the screen, it also runs `document.body.dataset.screen = id;`. Make the smallest possible change: do not rewrite, reformat or re-save the whole file, and do not touch the embedded assets. When done, state the line number of the line you added.
