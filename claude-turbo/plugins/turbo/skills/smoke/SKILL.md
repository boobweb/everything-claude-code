---
name: smoke
description: Headless Chromium boot test for a web app (static folder or running URL). Use to catch loading hangs, boot-time exceptions, console errors, missing assets and layout overflow after changes to HTML/JS/CSS, or whenever a user says the page "doesn't load" or "nothing happens".
argument-hint: '[folder or URL] [--wait-hidden <selector>] [--click <selector>] [--mobile]'
allowed-tools: Read, Glob, mcp__plugin_turbo_code__search, mcp__plugin_turbo_code__file_outline, Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/smoke.js" *), PowerShell(node "${CLAUDE_PLUGIN_ROOT}/scripts/smoke.js" *)
---

# /turbo:smoke — does it actually boot?

Arguments: $ARGUMENTS

## Run

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/smoke.js" --dir <folder> [--file index.html] [--wait-hidden "#loading-overlay"] [--wait-visible ".app"] [--click "#start"] [--mobile] [--timeout 30000] [--screenshot <file>] [--ignore <regex>] [--json]
node "${CLAUDE_PLUGIN_ROOT}/scripts/smoke.js" --url http://localhost:8000/ ...
```

- With `--dir`, the script serves the folder itself on a random localhost port (no server setup needed); with `--url` it tests a server you already started.
- Pick the wait condition from the app: a loading overlay that must disappear (`--wait-hidden`), a main element that must appear (`--wait-visible`), or text (`--wait-text`). Find selectors with `file_outline` (HTML ids) or `search`.
- Exit codes: 0 pass, 1 problems, 2 usage error, 3 Playwright missing.
- If exit 3: install once with `npm install -g playwright && npx playwright install chromium` (ask the user first if the project is not yours; it downloads a browser), then re-run.
- The script prints a screenshot path; use `Read` on it to look at the rendered page when a visual check matters (blank screen, overlay stuck, overflow).

## Interpret

- **uncaught exceptions > 0**: a script failed at boot. Take the message and location, `search` for it, fix, re-run.
- **wait FAIL**: the app never became interactive (loading hang). Check the boot path: the code that removes the overlay, async asset loading without `catch`/`allSettled`, a thrown error before the overlay removal.
- **failed requests / HTTP >= 400**: wrong relative paths or missing files. Verify paths from the served HTML's location.
- **HORIZONTAL OVERFLOW**: layout wider than the viewport (mobile bug). Check fixed widths, `100vw` with scrollbars, oversized images.
- Compare `interactive` time between runs when optimizing load time.

Report the PASS/FAIL line, the first error verbatim, and what you did about it.
