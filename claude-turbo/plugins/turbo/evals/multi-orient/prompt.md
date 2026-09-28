---
name: multi-orient
description: Answer three orientation questions about a small multi-file repo (JS, JSON, Python) with file:line citations. Measures accuracy of navigation across files and languages.
tags: [multi, read-only, navigation]
runs: 2
max_turns: 12
timeout_seconds: 300
allowed_tools: [Read, Glob, Grep, mcp__plugin_turbo_code__repo_map, mcp__plugin_turbo_code__file_outline, mcp__plugin_turbo_code__find_symbol, mcp__plugin_turbo_code__read_range, mcp__plugin_turbo_code__search]
---

Answer these three questions about this repository. Cite the file and line number for each answer.

1. Where does the question bank live and how many questions does it contain?
2. What does the `save` method of the `Store` class return?
3. Which Python method builds the list of question objects, and in which class is it?
