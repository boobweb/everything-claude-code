# Turbo evals: measured, with and without the plugin

Everything below was produced by `claude plugin eval` on 2026-09-28 with Claude Code 2.1.283, running the five cases in `plugins/turbo/evals/` twice per arm, once with the Turbo plugin loaded (its real MCP server and hooks) and once without it, on two models. Total spend for both runs and three probe runs: about $3.50 of the $15 cap. Raw results: `plugins/turbo/evals/published/v2-sonnet.json` and `v2-opus.json`; regenerate the tables with `node plugins/turbo/evals/summarize.js <file>`.

The short version: on these tasks the plugin does not change correctness (every grader passed in all 40 runs, on both models). What it changes is how much the model reads. With Sonnet, Turbo cuts context by 13 to 34 percent and turns by up to half on the navigation tasks, and costs 17 to 19 percent more on the two control tasks. With Opus, which is already frugal with Grep and Read, the plugin's fixed context overhead outweighs its savings on the small tasks and only wins where the search runs over the blob-heavy file. Details, including where Turbo does not help, follow.

## The cases

| case | fixture | what is measured |
|---|---|---|
| webapp-find-function | single-file app, 360KB, 98% base64 in 3 lines | exact line range and behavior of one function |
| webapp-surgical-edit | same | one-line change inside the file; assets and tail must survive; no whole-file Write |
| multi-orient | 15-file repo (JS, JSON, Python, TS) | three questions answered with file:line citations |
| multi-add-method | same | add a method to a 5-line class (control: Turbo not expected to help) |
| webapp-search-usages | single-file app | every use of one variable with line numbers (control: Grep already does this) |

Graders are regexes on the final answer or on the edited file, an LLM judge with a fixed rubric, and tool-usage checks. Two checks are "with-only" indicators (did the plugin's tools fire) and do not count toward the score. Scores are 0 to 1 per run.

## Sonnet

Model `sonnet`, total cost $1.32, 78 s wall clock for 20 runs (2 in parallel).

| case | arm | runs | score | pass | turns | context tokens | output tokens | cost/run | seconds/run |
|---|---|---|---|---|---|---|---|---|---|
| multi-add-method | with | 2 | 1.00 | 100% | 3.0 | 73.1k | 0.3k | $0.062 | 5 |
| multi-add-method | without | 2 | 1.00 | 100% | 3.0 | 62.6k | 0.3k | $0.053 | 6 |
| multi-orient | with | 2 | 1.00 | 100% | 4.0 | 74.8k | 0.5k | $0.069 | 8 |
| multi-orient | without | 2 | 1.00 | 100% | 7.5 | 103.4k | 1.0k | $0.107 | 16 |
| webapp-find-function | with | 2 | 1.00 | 100% | 2.0 | 48.6k | 0.2k | $0.057 | 5 |
| webapp-find-function | without | 2 | 1.00 | 100% | 3.5 | 73.4k | 0.5k | $0.060 | 8 |
| webapp-search-usages | with | 2 | 1.00 | 100% | 4.0 | 75.2k | 0.6k | $0.073 | 10 |
| webapp-search-usages | without | 2 | 1.00 | 100% | 3.0 | 63.1k | 0.4k | $0.058 | 7 |
| webapp-surgical-edit | with | 2 | 1.00 | 100% | 3.0 | 73.4k | 0.3k | $0.062 | 6 |
| webapp-surgical-edit | without | 2 | 1.00 | 100% | 4.0 | 83.9k | 0.5k | $0.060 | 9 |

"Context tokens" is the sum of input, cache-write and cache-read tokens over the whole run, i.e. everything the model had to attend to; "output tokens" is what it wrote. Both come from the run traces.

Tool choices with the plugin: `find_symbol` alone answered webapp-find-function in one call (2 turns) where the baseline needed Grep then Read; multi-orient took `repo_map` plus two `find_symbol` calls (4 turns) against nine Grep/Read/Glob calls, or an Agent subcall, in the baseline.

## Opus

Model `opus`, total cost $1.78, 93 s wall clock for 20 runs.

| case | arm | runs | score | pass | turns | context tokens | output tokens | cost/run | seconds/run |
|---|---|---|---|---|---|---|---|---|---|
| multi-add-method | with | 2 | 1.00 | 100% | 3.0 | 45.3k | 0.4k | $0.137 | 6 |
| multi-add-method | without | 2 | 1.00 | 100% | 3.0 | 34.2k | 0.4k | $0.061 | 5 |
| multi-orient | with | 2 | 1.00 | 100% | 6.5 | 64.5k | 0.8k | $0.106 | 14 |
| multi-orient | without | 2 | 1.00 | 100% | 6.0 | 62.7k | 0.8k | $0.116 | 15 |
| webapp-find-function | with | 2 | 1.00 | 100% | 3.5 | 45.6k | 0.5k | $0.084 | 9 |
| webapp-find-function | without | 2 | 1.00 | 100% | 3.0 | 34.4k | 0.4k | $0.066 | 7 |
| webapp-search-usages | with | 2 | 1.00 | 100% | 3.0 | 31.0k | 0.5k | $0.085 | 9 |
| webapp-search-usages | without | 2 | 1.00 | 100% | 4.0 | 46.8k | 0.7k | $0.076 | 10 |
| webapp-surgical-edit | with | 2 | 1.00 | 100% | 4.0 | 60.9k | 0.5k | $0.086 | 9 |
| webapp-surgical-edit | without | 2 | 1.00 | 100% | 4.5 | 46.1k | 0.6k | $0.070 | 8 |

Opus with the plugin tends to double-check: webapp-find-function used `find_symbol`, then `search`, then `read_range` where one call would have done, and multi-orient mixed Turbo tools with plain Read. Each extra call pays the fixed overhead again.

## Fixed overhead per model call

The first API call of every run shows what the plugin adds to the context before any work happens:

| model | without | with | overhead per call |
|---|---|---|---|
| Sonnet | 20.5k | 24.1k | +3.6k tokens |
| Opus | 11.0k | 14.8k | +3.8k tokens |

Where it goes (`claude --plugin-dir plugins/turbo plugin details turbo` plus the traces): skill and agent descriptions about 1.4k tokens always on (11 skills, 3 agents), the 7 MCP tool schemas and the server instructions about 2k, the session brief about 0.2k. Most of it is cached after the first call, so the dollar cost is small (cache reads are a tenth of the input price), but every call still carries it, which is why the two control tasks cost more with the plugin than without on both models.

## Where Turbo does not help

- **multi-add-method** (both models): a five-line class in a 26-line file. Read plus Edit is already optimal; the plugin adds only its overhead (+17% context with Sonnet, +32% with Opus).
- **webapp-search-usages with Sonnet**: Grep answers this directly. Sonnet with the plugin chose `search`, then `file_outline`, then `read_range` (4 turns) and used 19% more context. With Opus the same case went the other way (31.0k against 46.8k), because Opus used `search` once and its output already carried the enclosing context.
- **webapp-find-function and webapp-surgical-edit with Opus**: Opus grepped and read the 360KB file cheaply on its own (Read truncates the three 80 to 160KB lines to 2,000 characters, so the "huge" file costs only about 8k tokens to read whole). The plugin's extra verification calls cost more than they saved.
- **Safety hooks**: no run tried to Write the whole file and no edit produced a syntax error, so the write guard, the post-edit check and the Stop check had nothing to catch in 40 runs. Their behavior is proven by the unit tests (`tests/run-tests.js`, 289 checks), not by these evals.

## Where it does

- Navigation across files with Sonnet: multi-orient dropped from 7.5 to 4 turns, 103k to 75k context, $0.107 to $0.069 per run.
- Jumping to one symbol in a big file with Sonnet: 2 turns instead of 3.5, 49k against 73k context, and the answer came with exact start and end lines from the parser rather than from reading around a Grep hit.
- Searching a blob-heavy file with Opus: 31k against 47k context, one call instead of three.

## Limits of this measurement

- Two runs per arm is enough to see direction, not to put error bars on the numbers; treat differences under about 10 percent as noise.
- The fixtures are small on purpose (cheap to run): 360KB with three long lines that Read truncates anyway. The plugin's design case, a 5 to 20MB single-file app with hundreds of functions and dozens of blob lines, where Read has to page through 2,000 lines at a time, was not run here; every run of such a case costs real money and the step was capped at $15. The parsers and folding logic for that case are covered by the test suite instead.
- The baseline arm is plain Claude Code with the same tool grants minus the plugin; it is not tuned in any way.
- The eval harness needs bash for the scaffold step (Linux, macOS or WSL), so these numbers were produced on Linux, not on the Windows machine the plugin targets.

## Reproduce

```
cd claude-turbo
claude plugin eval ./plugins/turbo --scaffold --allow-real-servers \
  --allow-tools Read Glob Grep Edit Write "mcp__plugin_turbo_code__*" \
  --trust-plugin --no-publish --runs 2 -j 2 --max-cost-usd 15 --keep-temp \
  --model sonnet --json plugins/turbo/evals/results/mine.json
node plugins/turbo/evals/summarize.js plugins/turbo/evals/results/mine.json
```
