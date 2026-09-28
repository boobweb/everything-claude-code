---
name: handoff
description: Write the next-session handoff note so work continues without re-discovery. Use at the end of a work session, before context compaction on a long task, when stopping mid-way through something, or when the user says "save your progress" / "where were we".
argument-hint: [optional extra notes]
allowed-tools: Read, Glob, Bash(git status *), PowerShell(git status *), Bash(git log *), PowerShell(git log *), Bash(git diff --stat *), PowerShell(git diff --stat *)
---

# /turbo:handoff — leave the next session a running start

The plugin's SessionStart hook injects `.claude/turbo-handoff.md` (first ~1500 chars) into every new session, so this note is read automatically next time. Extra notes from the user: $ARGUMENTS

## Write `.claude/turbo-handoff.md` (create `.claude/` if needed; overwrite the previous note)

Keep it under 60 lines, facts only, most useful first:

```
# Handoff — <YYYY-MM-DD HH:MM> — <one-line summary of the session>

## State
- Done: <what was completed, with file:line for the key edits>
- In progress: <what is half-done and exactly where it stands>
- Not started: <agreed next steps, in order>

## How to run / check
- <exact commands: serve, test, smoke, build>

## Decisions and constraints
- <choices made and why; things the user asked never to change>

## Traps discovered
- <gotchas: large files with blobs, fragile boot code, generated files, flaky tests, Windows path quirks>

## Open questions for the user
- <anything blocking or needing a decision>
```

## Rules

- Only write what is true now; if unsure, check (`git status`, `git log -3`, the file) before claiming.
- Prefer `path:line` references over prose descriptions of locations.
- Do not paste code blocks longer than 5 lines; point at the file instead.
- If the project is a git repo, do not commit the note unless the user's workflow already commits `.claude/`; suggest adding `.claude/turbo-handoff.md` to `.gitignore` if it should stay local.
- Finish by telling the user in one line that the note is written and what the top next step is.
