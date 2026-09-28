---
name: setup
description: 'Configure the current project for fast, safe Claude Code sessions. Use once per project (or when asked to "set up Claude for this repo"): writes a lean CLAUDE.md section, a project permission allowlist for the project''s own safe commands, ignore entries, and a first handoff note.'
argument-hint: '[optional: "minimal" | "full"]'
allowed-tools: mcp__plugin_turbo_code__repo_map, mcp__plugin_turbo_code__file_outline, Read, Glob, Grep, Bash(git status *), PowerShell(git status *), Bash(git check-ignore *), PowerShell(git check-ignore *)
---

# /turbo:setup — project bootstrap

Mode: $ARGUMENTS (default: full)

## 1. Learn the project (cheap)

`repo_map` once; read `README`, `package.json` (scripts), existing `CLAUDE.md` / `.claude/settings.json` if present. Do not read source files beyond outlines.

## 2. CLAUDE.md (create or append a `## Turbo` section; never delete existing content)

Keep it under 40 lines, facts only:
- What the project is, how to run it locally, how to test/lint/build (exact commands).
- Layout: the 5 to 10 files/directories that matter and what lives in each.
- Large or fragile files (size, embedded blobs, "edit with Edit only, never rewrite") and generated files (never hand-edit).
- Data shapes for structured content (arrays of objects: keys and meaning of index fields).
- Conventions: naming, formatting, globals/state that must not be renamed, boot/loading code to preserve.
- Verification: "run /turbo:verify before finishing; hooks auto-check syntax after edits".

## 3. `.claude/settings.local.json` (project-local, not committed)

Merge (do not overwrite other keys) a `permissions.allow` list with the project's own safe commands only, e.g. `Bash(npm test *)`, `Bash(npm run lint *)`, `Bash(npm run build *)`, `Bash(pytest *)`, `Bash(node --check *)`, `Bash(py -m http.server *)`, `Bash(python -m http.server *)`, plus `mcp__plugin_turbo_code__*` if not already allowed at user level. Never add `rm`, `git push`, deploy or publish commands. Show the user the exact JSON you added.

## 4. Ignore entries

Ensure `.gitignore` contains `.claude/settings.local.json` and `.claude/turbo-handoff.md` (unless the user commits Claude config on purpose; ask if there is an existing `.claude/` tracked in git).

## 5. First handoff

Run `/turbo:handoff` with a one-line state summary so the next session starts oriented.

## Report

List every file created or changed with a one-line description, and the 3 commands the user can use immediately (`/turbo:map`, `/turbo:verify`, `/turbo:smoke ...` with the right selector if it is a web app).
