---
name: multi-add-method
description: Add one method to a class in a small CommonJS file. A control case where Turbo is not expected to help much; it shows the plugin costs nothing when its tools are not needed.
tags: [multi, edit, control]
runs: 2
max_turns: 12
timeout_seconds: 300
allowed_tools: [Read, Glob, Grep, Edit, Write, mcp__plugin_turbo_code__file_outline, mcp__plugin_turbo_code__find_symbol, mcp__plugin_turbo_code__read_range, mcp__plugin_turbo_code__syntax_check]
---

In `src/app.js`, add a method `remove(k)` to the `Store` class that deletes key `k` from the underlying map and returns `this`, in the same one-line style as the existing `get` and `set` methods. Change nothing else.
