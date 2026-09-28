---
name: tidy
description: 'Find and clear clutter on a drive or in a folder: byte-identical duplicate files, empty files and folders, system junk (Thumbs.db, .DS_Store, Office lock files, stale partial downloads), Claude Code leftovers (transcripts of deleted projects, old logs, duplicate skill folders) and stale regenerable caches. Use when the user says their drive or downloads are a mess, asks to find duplicates, or wants to clean up AI/Claude files. Reports first; moves to a quarantine folder only when asked; never deletes.'
argument-hint: '[folder or drive, e.g. C:\Users\me\Downloads or ~] [--older-than days]'
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/tidy.js" *), PowerShell(node "${CLAUDE_PLUGIN_ROOT}/scripts/tidy.js" *), Read
---

# /turbo:tidy — clean up without losing anything

Target: $ARGUMENTS (if empty, ask which folder or drive to scan; suggest the user's home folder or Downloads first, a whole drive second).

## Rules

- **Report before touching.** Always run the scan without `--apply` first and show the user the summary.
- **Quarantine, never delete.** `--apply` moves items into `<root>/_turbo-quarantine/<timestamp>/` with a `manifest.json`; `--undo <that folder>` restores every item. Tell the user both paths. The user deletes the quarantine folder themselves once they are sure, typically after a week.
- **Only the categories the user chose.** Default apply set is `duplicates,empty,junk,ai`. `heavy` (node_modules, virtualenvs, caches) and `archives` are report-only unless the user explicitly asks; heavy folders are regenerable but moving gigabytes takes time.
- Scanning is read-only and safe on any folder, including a whole drive; system folders are skipped unless `--all`. A whole drive can take minutes: say so, and prefer starting with the user's home folder.
- Do not run any other delete command as part of this skill.

## Procedure

1. Scan: `node "${CLAUDE_PLUGIN_ROOT}/scripts/tidy.js" <target> --limit 15` (add `--older-than <days>` if given; `--json` when you need exact lists). On Windows use the PowerShell tool with the same command.
2. Summarize in 6 lines or fewer: files scanned, reclaimable size per category, the three biggest duplicate groups, anything surprising (e.g. transcripts of deleted projects). Point out that the kept copy in each duplicate group is the one not named like a copy and in the shortest path.
3. Ask the user which categories to quarantine (offer the default set), and whether to include heavy folders.
4. Apply exactly that: `node "${CLAUDE_PLUGIN_ROOT}/scripts/tidy.js" <target> --apply --only <cats>` (add `--include-heavy` only if asked).
5. Report: how many items moved, total size, the quarantine folder path, and the one-line undo command. Suggest a date to delete the quarantine folder.

For Claude Code specific cleanup (transcripts, logs, plugin data), the scan already inspects `~/.claude` (override with `--claude-dir`); running the scan on `~` covers both the home folder and those leftovers in one pass.
