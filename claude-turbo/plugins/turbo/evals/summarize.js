#!/usr/bin/env node
'use strict';
// Turn a `claude plugin eval --json <file>` result (or results/<ts>/aggregate-result.json) into the
// markdown tables used in EVALS.md: per case and arm, mean score, pass rate, turns, cost, duration,
// and (when the run used --keep-temp so traces still exist) context and output tokens.
//   node evals/summarize.js <result.json> [--md]

const fs = require('fs');

const file = process.argv[2];
if (!file) { console.error('usage: node summarize.js <result.json>'); process.exit(2); }
const d = JSON.parse(fs.readFileSync(file, 'utf8'));

function tokensFromTrace(tracePath) {
  try {
    let last = null;
    for (const line of fs.readFileSync(tracePath, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      let m; try { m = JSON.parse(line); } catch { continue; }
      if (m.type === 'result' && m.usage) last = m.usage;
    }
    if (!last) return null;
    const ctx = (last.input_tokens || 0) + (last.cache_creation_input_tokens || 0) + (last.cache_read_input_tokens || 0);
    return { context: ctx, output: last.output_tokens || 0 };
  } catch { return null; }
}

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const fmt = (n, digits = 2) => (n == null ? 'n/a' : Number(n).toFixed(digits));
const fmtK = (n) => (n == null ? 'n/a' : `${(n / 1000).toFixed(1)}k`);

const rows = [];
for (const c of d.cases || []) {
  for (const arm of ['with', 'without']) {
    const runs = (c.arms && c.arms[arm]) || [];
    if (!runs.length) continue;
    const ok = runs.filter((r) => !r.error);
    const toks = ok.map((r) => tokensFromTrace(r.tracePath)).filter(Boolean);
    rows.push({
      case: c.name, arm, runs: runs.length, errors: runs.length - ok.length,
      score: mean(runs.map((r) => r.score)), pass: mean(runs.map((r) => (r.passed ? 1 : 0))),
      turns: mean(ok.map((r) => r.turns)), cost: mean(ok.map((r) => r.costUsd)), judge: mean(runs.map((r) => r.judgeCostUsd || 0)),
      seconds: mean(ok.map((r) => r.durationSeconds)),
      context: toks.length ? mean(toks.map((t) => t.context)) : null, output: toks.length ? mean(toks.map((t) => t.output)) : null,
      graders: runs.map((r) => (r.graders || []).map((g) => `${g.name}:${g.passed ? 'P' : 'F'}`).join(' ')).join(' | '),
    });
  }
}

const out = [];
out.push(`Claude Code ${d.claudeVersion}; model ${d.suite && d.suite.modelOverride ? d.suite.modelOverride : 'session default'}; ablation ${d.suite ? d.suite.ablation : '?'}; total cost $${fmt(d.costUsd)} in ${d.durationSeconds}s${d.partial ? ` (PARTIAL: ${d.partialReason || 'interrupted'})` : ''}`);
out.push('');
out.push('| case | arm | runs | score | pass | turns | context tokens | output tokens | cost/run | seconds/run |');
out.push('|---|---|---|---|---|---|---|---|---|---|');
for (const r of rows) out.push(`| ${r.case} | ${r.arm} | ${r.runs}${r.errors ? ` (${r.errors} err)` : ''} | ${fmt(r.score)} | ${fmt(r.pass * 100, 0)}% | ${fmt(r.turns, 1)} | ${fmtK(r.context)} | ${fmtK(r.output)} | $${fmt(r.cost, 3)} | ${fmt(r.seconds, 0)} |`);
out.push('');
out.push('Per-run grader results (P = pass, F = fail):');
for (const r of rows) out.push(`- ${r.case} / ${r.arm}: ${r.graders}`);
const deltas = (d.cases || []).filter((c) => c.aggregates && c.aggregates.delta != null).map((c) => `${c.name} ${c.aggregates.delta >= 0 ? '+' : ''}${fmt(c.aggregates.delta)}`);
if (deltas.length) out.push('', `Score deltas (with minus without): ${deltas.join(', ')}`);
process.stdout.write(out.join('\n') + '\n');
