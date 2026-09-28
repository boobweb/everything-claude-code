---
name: release
description: Pre-deploy / pre-commit checklist for any project (static sites, Netlify/Vercel, npm packages, scripts). Use when asked to ship, deploy, publish, tag or "make it ready", so nothing broken or half-finished goes out.
argument-hint: '[target, e.g. "netlify" or "v1.4"]'
allowed-tools: mcp__plugin_turbo_code__syntax_check, mcp__plugin_turbo_code__search, mcp__plugin_turbo_code__file_stats, Read, Glob, Grep, Bash(git status *), PowerShell(git status *), Bash(git diff *), PowerShell(git diff *), Bash(git log *), PowerShell(git log *), Bash(git show *), PowerShell(git show *), Bash(git branch *), PowerShell(git branch *), Bash(node --check *), PowerShell(node --check *), Bash(npm test *), PowerShell(npm test *), Bash(npm run test *), PowerShell(npm run test *), Bash(npm run lint *), PowerShell(npm run lint *), Bash(npm run build *), PowerShell(npm run build *), Bash(npm run typecheck *), PowerShell(npm run typecheck *), Bash(pytest *), PowerShell(pytest *), Bash(python -m pytest *), PowerShell(python -m pytest *), Bash(go test *), PowerShell(go test *), Bash(go build *), PowerShell(go build *), Bash(cargo test *), PowerShell(cargo test *), Bash(dotnet test *), PowerShell(dotnet test *), Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/smoke.js" *), PowerShell(node "${CLAUDE_PLUGIN_ROOT}/scripts/smoke.js" *)
---

# /turbo:release — ship only what is verified

Target: $ARGUMENTS

## Checklist (run in order, stop and fix on the first failure)

1. **Clean state**: `git status` — no stray debug files, no accidental large binaries, no secrets (`search` for `api[_-]?key|secret|token|password\s*[:=]` in changed files; check `.env` is ignored).
2. **Verify**: run `/turbo:verify all` (syntax of all checkable files, project tests/lint/build, smoke test for web apps, `--mobile` run when the app targets phones).
3. **Debug leftovers**: `search` for `console.log(`, `debugger`, `TODO(release)`, `FIXME`, `localhost:` hardcoded URLs, test flags left on.
4. **Size and hosting limits**: `file_stats` on the deploy artifact(s). Note the host's limits (e.g. single-file uploads, per-file size caps, path case sensitivity on Linux hosts, `_redirects`/`netlify.toml` presence). If a file is too large for the host's API/CLI, say so and name the fallback (web UI drag-and-drop, split assets).
5. **Cache and versioning**: bump the version string the app displays or logs (if any); bust caches for renamed assets; update CHANGELOG/README if the project keeps one.
6. **Commit**: one focused commit with a message that says what changed and why; do not amend or force-push published history. Tag only if the user's workflow uses tags.
7. **Deploy** (only if asked): run the project's deploy command or the documented manual steps. After deploy, smoke test the live URL: `node "${CLAUDE_PLUGIN_ROOT}/scripts/smoke.js" --url <live url> --wait-hidden <overlay>`.
8. **Rollback plan**: state how to revert (previous deploy id, git revert of the commit, previous artifact).

## Report

```
RELEASE <target>  ready | blocked
checks: verify ok · no secrets · no debug leftovers · size 3.2MB (limit 25MB)
commit: <hash> <message>
deploy: not run | done <url> smoke PASS
rollback: <how>
```
