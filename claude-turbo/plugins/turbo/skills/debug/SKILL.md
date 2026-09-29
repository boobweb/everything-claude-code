---
name: debug
description: Systematic triage for bugs, loading hangs, "nothing happens on click", broken state transitions, and silent failures. Use when the user reports a symptom rather than a known cause, or when a change made something stop working. Enforces evidence before edits.
argument-hint: '[symptom, e.g. "cards unclickable after load"]'
allowed-tools: mcp__plugin_turbo_code__repo_map, mcp__plugin_turbo_code__file_outline, mcp__plugin_turbo_code__find_symbol, mcp__plugin_turbo_code__read_range, mcp__plugin_turbo_code__search, mcp__plugin_turbo_code__syntax_check, mcp__plugin_turbo_code__file_stats, Read, Grep, Glob, Bash(git status *), PowerShell(git status *), Bash(git diff *), PowerShell(git diff *), Bash(git log *), PowerShell(git log *), Bash(git show *), PowerShell(git show *), Bash(git branch *), PowerShell(git branch *), Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/smoke.js" *), PowerShell(node "${CLAUDE_PLUGIN_ROOT}/scripts/smoke.js" *)
---

# /turbo:debug — find the real failure point before changing anything

Symptom: $ARGUMENTS

## Step 1: rule out the cheap catastrophic causes (2 minutes)

- `syntax_check` every recently changed file (git status / the session's edits). A single syntax error in a single-file app disables every handler at once.
- Web app: run `/turbo:smoke` (or `node "${CLAUDE_PLUGIN_ROOT}/scripts/smoke.js" --dir <folder> --wait-hidden <overlay selector>`) to capture uncaught exceptions, console errors and failed asset requests at boot. Console errors first, network failures second.
- Paths: verify relative asset paths from the location of the HTML file actually being served (file:// vs http://, subfolder vs root).

## Step 2: locate the code path

Use `find_symbol` / `search` to get the handler, the state it reads, and the render path it drives. Read only those (`read_range`), not the whole file. Write down the chain: trigger → handler → state change → render/effect.

## Step 3: classify the failure (state which one, with evidence)

1. **Not called**: the handler never runs (listener not bound, element replaced/re-rendered, overlay intercepting clicks, wrong id/selector, script never reached because of an earlier error).
2. **Called but failed**: it runs and throws or bails early (guard clause, null DOM query, undefined state, async rejection swallowed, wrong type).
3. **Completed but UI not updated**: state changed but the render path did not run, rendered the wrong node, or CSS hides it (display/visibility/z-index/overlay/opacity, class not toggled).

Get evidence: add a temporary `console.log`/`console.error` at the boundary, reproduce with the smoke script (`--click <selector>`), read the output, then remove the log. Do not guess between the three classes.

## Step 4: smallest safe fix

- Fix the root cause at the failure point; avoid speculative rewrites and do not rename or repurpose existing globals/state.
- Guard async boot paths: one failed asset must never trap a loading overlay (`Promise.allSettled`, explicit `catch`, timeouts).
- Null-safe DOM queries for conditional elements; check `res.ok` on fetches; avoid duplicate listener binding.

## Step 5: prove it

Re-run the same reproduction (smoke script with the same `--click`/`--wait` args, or the test). Report: cause (which of the three classes and why), the exact change (Find/Replace), and a 3-step manual check for the user. If the cause could recur elsewhere (same pattern in other handlers), list those locations with `search` results.
