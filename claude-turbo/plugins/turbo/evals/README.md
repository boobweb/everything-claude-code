# Turbo evals

Measured with-vs-without-plugin runs through `claude plugin eval`. Each case copies a fixture into a fresh temporary working directory (scaffold), runs the prompt once with the plugin loaded and once without, and scores both arms with the same graders. The numbers behind `EVALS.md` at the kit root come from here.

Fixtures (`fixtures/`) are generated from the test suite's fixture builder so the eval cases and the tests agree on every line number: `node plugins/turbo/evals/make-fixtures.js` (from the kit root) regenerates them after `tests/fixture.js` changes.

Run from the kit root (Linux, macOS or WSL: the scaffold is a bash script; the harness needs no shell grant for these cases):

```
claude plugin eval ./plugins/turbo --scaffold --allow-real-servers \
  --allow-tools Read Glob Grep Edit Write "mcp__plugin_turbo_code__*" \
  --trust-plugin --no-publish --runs 2 -j 2 --max-cost-usd 15 --keep-temp --model sonnet \
  --json plugins/turbo/evals/results/mine.json
node plugins/turbo/evals/summarize.js plugins/turbo/evals/results/mine.json --embed
```

`--allow-real-servers` starts the kit's real MCP server in the with arm (there are no mocks; the server is read-only and zero-dependency). `--keep-temp` keeps each run's trace; `summarize.js --embed` copies the token counts out of the traces into the JSON so the file stays self-contained, then prints the tables. Results land in `evals/results/` (git-ignored); the runs reported in `EVALS.md` are kept under `evals/published/`.
