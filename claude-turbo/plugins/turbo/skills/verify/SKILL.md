---
name: verify
description: Run every cheap check the project offers and prove the current state is sound before declaring work done. Use after finishing a feature or fix, before a commit or deploy, or when asked "does it still work". Covers syntax of changed files, project test/lint/build scripts, and a browser smoke test for web apps.
argument-hint: '[scope: "changed" (default) | "all" | a path]'
allowed-tools: mcp__plugin_turbo_code__syntax_check, mcp__plugin_turbo_code__search, mcp__plugin_turbo_code__file_outline, mcp__plugin_turbo_code__read_range, Read, Glob, Grep, Bash(git status *), PowerShell(git status *), Bash(git diff *), PowerShell(git diff *), Bash(git log *), PowerShell(git log *), Bash(git show *), PowerShell(git show *), Bash(git branch *), PowerShell(git branch *), Bash(node --check *), PowerShell(node --check *), Bash(npm test *), PowerShell(npm test *), Bash(npm run test *), PowerShell(npm run test *), Bash(npm run lint *), PowerShell(npm run lint *), Bash(npm run build *), PowerShell(npm run build *), Bash(npm run typecheck *), PowerShell(npm run typecheck *), Bash(pytest *), PowerShell(pytest *), Bash(python -m pytest *), PowerShell(python -m pytest *), Bash(go test *), PowerShell(go test *), Bash(go build *), PowerShell(go build *), Bash(cargo test *), PowerShell(cargo test *), Bash(dotnet test *), PowerShell(dotnet test *), Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/smoke.js" *), PowerShell(node "${CLAUDE_PLUGIN_ROOT}/scripts/smoke.js" *)
---

# /turbo:verify — evidence, not confidence

Scope: $ARGUMENTS (default: files changed in this session / git working tree).

## Procedure

1. **What changed**: `git status --porcelain` and `git diff --stat` (or the session's edited files if not a git repo). List them.
2. **Syntax/integrity**: `syntax_check` with `paths` = all changed checkable files (JS, HTML, JSON, Python, CSS, PowerShell, shell, TS, YAML, XML). Fix anything red before continuing.
3. **Project checks** (run what exists, in this order, stop on the first failure and fix it): 
   - package.json scripts: `lint`, `typecheck`/`check`, `test`, `build` (`npm run <name>`; use the detected package manager). 
   - Python: `pytest -q` (or `python -m pytest -q`), `ruff check .` if configured. 
   - Go: `go build ./... && go test ./...`; Rust: `cargo test`; .NET: `dotnet test`; Make: `make test` if the target exists.
   - Run each with a timeout; capture the last 40 lines of output on failure.
4. **Runtime smoke** for web apps (static HTML, SPA, local server): `node "${CLAUDE_PLUGIN_ROOT}/scripts/smoke.js" --dir <folder>` or `--url <running url>`, adding `--wait-hidden "<loading overlay selector>"` and `--click "<primary button>"` when known. Zero uncaught exceptions and zero console errors is the bar. Add `--mobile` for a second run when layout matters.
5. **Data integrity** when structured data changed: spot-check object shapes and index-based fields (`read_range` around the edited items), duplicate ids (`search` for the id pattern), array lengths that other code assumes.
6. **Manual checklist**: list 3 to 6 concrete steps for the user, in the order they would do them, with the expected result of each.

## Report format

```
VERIFY  <pass|fail>
changed: N files (list)
syntax: ok | file:line message
checks: npm test ok (12 passed) · lint ok · build ok
smoke: PASS interactive 840ms, 0 exceptions, 0 console errors  (or FAIL + first error)
data: ok | issue
manual: 1) ... 2) ... 3) ...
open risks: ...
```

Never report "verified" for a step you did not run; say "not run" and why.
