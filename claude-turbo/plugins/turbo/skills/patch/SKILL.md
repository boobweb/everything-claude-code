---
name: patch
description: Make a surgical, verified change in a large or high-stakes file (single-file apps, giant HTML/JS, data banks, config). Use whenever an edit targets a file over ~100KB, a file with embedded base64/minified blobs, or structured data where a shifted index or stray comma is costly. Produces a Find / Replace / Why / Test report.
argument-hint: [file] [what to change]
allowed-tools: mcp__plugin_turbo_code__repo_map, mcp__plugin_turbo_code__file_outline, mcp__plugin_turbo_code__find_symbol, mcp__plugin_turbo_code__read_range, mcp__plugin_turbo_code__search, mcp__plugin_turbo_code__syntax_check, mcp__plugin_turbo_code__file_stats, Read, Edit, Grep, Glob
---

# /turbo:patch — surgical edits that cannot silently break the file

Request: $ARGUMENTS

## Rules

- Never rewrite or re-emit a large file. Use `Edit` with exact `old_string`/`new_string` (the Write guard will stop you if you try).
- Locate before you touch: `file_outline` → `find_symbol` / `read_range` on the exact lines. Read only what the change needs plus enough context to make `old_string` unique.
- Preserve everything you did not intend to change: names of established globals, state variables, mode flags, boot/loading code, formatting style, comments, data ordering.
- Structured data (arrays of objects, question banks, config): keep object shape identical; after inserting or removing items re-check that any index-based fields (e.g. `c: 2` meaning "third option") still point at the intended element; no duplicate ids; no trailing-comma or bracket damage.
- One logical change per Edit call; several Edits are fine. Do not touch lines you cannot see.

## Procedure

1. Outline the file, find the target symbol/lines, read the minimum context (`read_range`, folded blobs are fine to leave folded).
2. Plan the edit: what exactly changes, what must stay identical, what else references it (`search` for the symbol name; check callers).
3. Apply with `Edit`. The plugin's PostToolUse hook syntax-checks the file automatically after each Edit; if it reports an error, fix it immediately before anything else.
4. Verify: `syntax_check` on the file is redundant (hook already did it) unless the file type was skipped; re-read the edited region with `read_range` to eyeball the result; `search` for any now-dangling references; run the project's quick check if one exists (test/lint) when the change is not trivially local.
5. Report in this format:

**1. Find:** the exact old code (or the symbol and line range) 
**2. Replace with:** the exact new code 
**3. Why:** one or two sentences 
**4. Test:** a 3-to-6 step manual checklist the user can run right now (what to open, click, expect) 
**Regression risk:** what else could be affected and how you checked it.
