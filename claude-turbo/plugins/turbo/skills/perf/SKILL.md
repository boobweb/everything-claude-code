---
name: perf
description: Measure-first performance work for apps and scripts (slow load, slow startup, janky UI, huge files, slow tests). Use when asked to make something faster or when load/boot time is a complaint. Produces ranked, evidence-backed fixes instead of guesses.
argument-hint: [what is slow]
allowed-tools: mcp__plugin_turbo_code__file_stats, mcp__plugin_turbo_code__file_outline, mcp__plugin_turbo_code__search, mcp__plugin_turbo_code__find_symbol, mcp__plugin_turbo_code__read_range, mcp__plugin_turbo_code__repo_map, Read, Glob, Grep, Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/smoke.js" *), PowerShell(node "${CLAUDE_PLUGIN_ROOT}/scripts/smoke.js" *)
---

# /turbo:perf — measure, rank, fix, re-measure

Target: $ARGUMENTS

## 1. Measure before touching anything

- Web page: `node "${CLAUDE_PLUGIN_ROOT}/scripts/smoke.js" --dir <folder> --wait-hidden <overlay>` for load/interactive times and transfer size; run twice, keep the second.
- Where the bytes are: `file_stats` on the largest files (blob lines, script blocks, data URIs). `repo_map` for the biggest files overall.
- Scripts/servers: time the real command (`time`, `Measure-Command`, `--prof`, a `console.time` around the suspect function). Node: `node --cpu-prof`; Python: `python -m cProfile -s cumtime`.
- Write the numbers down (baseline). No baseline, no optimization.

## 2. Rank by expected payoff × safety

Common wins, most to least likely:
1. **Payload**: base64-embedded audio/images/fonts inside HTML/JS (each byte is parsed before the first click). Externalize to files loaded lazily (`fetch`/`<audio src>` on first interaction), or keep tiny assets inline only. Beware hosting constraints (single-file deploys) and `fetch()` on `data:` URIs on mobile (decode via `atob` instead).
2. **Blocking boot**: synchronous decode/parse of everything at startup. Defer non-critical work (`requestIdleCallback`, after first paint, on first user gesture for audio), parallelize with `Promise.allSettled`, and make the loading overlay depend on the critical path only.
3. **Repeated DOM/query work**: cache element references, avoid layout reads inside loops (forced reflow), batch writes, use `documentFragment`, debounce resize/scroll handlers.
4. **Algorithmic**: O(n²) scans over data on every render; precompute indexes/maps once.
5. **Asset size**: images too large for their display size, uncompressed audio, unminified vendor code shipped twice.
6. **Tests/build**: slow suites from network calls, missing caching, sequential jobs that could run in parallel.

## 3. Fix with the smallest change, one at a time

Apply one improvement, then re-measure with the same command. Keep the change if the number moved; revert if it did not. Preserve behavior; do not rename established globals or change data shapes while optimizing.

## 4. Report

```
PERF <target>
baseline: load 4.8s / interactive 6.1s / 27.4MB transfer  (command used)
after:    load 1.2s / interactive 1.4s / 2.1MB           (same command)
changes: 1) ... (file:line) 2) ...
not done / next: ...
risks: ...
```
