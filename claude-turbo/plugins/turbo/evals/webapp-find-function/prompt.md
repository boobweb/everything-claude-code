---
name: webapp-find-function
description: Locate one function in a 360KB single-file web app (98% embedded base64) and explain it. Measures whether the model gets the exact lines and the behavior, and what it costs to get there.
tags: [webapp, read-only, navigation]
runs: 2
max_turns: 12
timeout_seconds: 300
allowed_tools: [Read, Glob, Grep, mcp__plugin_turbo_code__file_outline, mcp__plugin_turbo_code__find_symbol, mcp__plugin_turbo_code__read_range, mcp__plugin_turbo_code__search, mcp__plugin_turbo_code__repo_map]
---

This directory contains a single-file web app, `index.html`. Tell me exactly which lines the function `pickDisc` occupies in `index.html` (first and last line number, 1-based, as they appear in the file) and what the function does, in three sentences or fewer. Do not modify any file.
