'use strict';
// Builds a deterministic fixture project in a temp directory: a large single-file web app
// with embedded base64 blobs, plus JS/ESM/JSON/Python/CSS/Markdown files and a set of
// deliberately broken files for the checkers.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

function b64blob(bytes, seed = 7) {
  // deterministic pseudo-random bytes -> base64
  const buf = Buffer.alloc(bytes);
  let x = seed;
  for (let i = 0; i < bytes; i++) { x = (x * 1103515245 + 12345) & 0x7fffffff; buf[i] = x & 0xff; }
  return buf.toString('base64');
}

function makeFixture(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'tools'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'broken'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'node_modules', 'junk'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'node_modules', 'junk', 'index.js'), 'module.exports = 1;\n');
  fs.writeFileSync(path.join(dir, 'dist', 'bundle.min.js'), 'var a=1;'.repeat(5000));

  const questions = [];
  for (let i = 1; i <= 40; i++) questions.push({ id: i, q: `Question ${i}: which option is correct?`, a: ['Alpha', 'Beta', 'Gamma', 'Delta'], c: i % 4 });

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Arena Fixture</title>
<style>
:root { --bg: #111; --fg: #eee; }
body { margin: 0; background: var(--bg); color: var(--fg); font-family: system-ui, sans-serif; }
.scr { display: none; }
.scr.act { display: block; }
#loading-overlay { position: fixed; inset: 0; background: #000; display: flex; align-items: center; justify-content: center; }
@media (max-width: 600px) { body { font-size: 14px; } }
@keyframes pulse { from { opacity: .4 } to { opacity: 1 } }
</style>
</head>
<body>
<div id="loading-overlay">Initializing Arena…</div>
<div id="ds" class="scr act"><h1>Pick an arena</h1><button id="btn-neuro" onclick="pickDisc('neuro')">Neuro</button></div>
<div id="ms" class="scr"><h2 id="mode-title">Mode</h2></div>
<div id="gs2" class="scr"><div id="hud"></div><div id="qa"></div></div>
<div id="rs" class="scr"><p id="score"></p></div>
<script type="application/json" id="config">{"version": 3, "modes": ["hero", "blitz"]}</script>
<script>
// Embedded assets (one line each, huge)
const SFX_OK = "data:audio/mpeg;base64,${b64blob(120000, 1)}";
const SFX_BAD = "data:audio/mpeg;base64,${b64blob(90000, 2)}";
const IMG_TENS = "data:image/png;base64,${b64blob(60000, 3)}";
</script>
<script>
'use strict';
const QN = ${JSON.stringify(questions, null, 1)};
let disc = 'neuro';
let score = 0, combo = 0, hp = 100, bossHp = 100;

function S(id) {
  document.querySelectorAll('.scr').forEach(el => el.classList.remove('act'));
  const t = document.getElementById(id);
  if (t) t.classList.add('act');
}

function pickDisc(d) {
  disc = d;
  document.documentElement.dataset.theme = d === 'neuro' ? '' : d;
  S('ms');
}

function getBank() {
  return QN;
}

const gQ = (n) => getBank().slice().sort(() => Math.random() - 0.5).slice(0, n);

class Engine {
  constructor(bank) {
    this.bank = bank;
    this.i = 0;
  }
  next() {
    return this.bank[this.i++];
  }
  static create() {
    return new Engine(gQ(15));
  }
}

const Audio = {
  ctx: null,
  init() { this.ctx = this.ctx || new (window.AudioContext || window.webkitAudioContext)(); },
  play: async function (name) { return name; },
};

Engine.prototype.reset = function () { this.i = 0; };

function uH() {
  const hud = document.getElementById('hud');
  if (hud) hud.textContent = 'Score ' + score + ' Combo ' + combo + ' HP ' + hp + ' Boss ' + bossHp;
}

window.startGame = function (mode) {
  const eng = Engine.create();
  S('gs2');
  uH();
  return eng;
};

document.addEventListener('DOMContentLoaded', () => {
  uH();
});

(function bootstrap() {
  const ov = document.getElementById('loading-overlay');
  if (ov) ov.remove();
})();
</script>
<script type="module">
import { clamp } from './src/util.mjs';
export const VERSION = '3.0.0';
console.log('module ok', clamp(5, 0, 3), VERSION);
</script>
</body>
</html>
`;
  fs.writeFileSync(path.join(dir, 'index.html'), html);

  fs.writeFileSync(path.join(dir, 'src', 'app.js'), `'use strict';
const util = require('./util.cjs');

/** Create the application state. */
function createState(opts = {}) {
  return { score: 0, level: opts.level || 1, items: [] };
}

async function loadData(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.json();
}

class Store {
  constructor() { this.data = new Map(); }
  get(k) { return this.data.get(k); }
  set(k, v) { this.data.set(k, v); return this; }
  async save() { return true; }
}

const render = (state) => {
  return JSON.stringify(state);
};

module.exports = { createState, loadData, Store, render };
`);
  fs.writeFileSync(path.join(dir, 'src', 'util.cjs'), `'use strict';
exports.clamp = function clamp(n, lo, hi) { return Math.min(hi, Math.max(lo, n)); };
exports.fmt = (n) => n.toFixed(2);
`);
  fs.writeFileSync(path.join(dir, 'src', 'util.mjs'), `export function clamp(n, lo, hi) { return Math.min(hi, Math.max(lo, n)); }
export const fmt = (n) => n.toFixed(2);
export default class Timer {
  constructor(ms) { this.ms = ms; }
  start() { this.t0 = Date.now(); }
}
`);
  fs.writeFileSync(path.join(dir, 'src', 'types.ts'), `export interface Question { q: string; a: string[]; c: number }
export type Mode = 'hero' | 'blitz';
export enum Theme { Neuro, Msk }
export function score(q: Question, pick: number): number { return q.c === pick ? 1 : 0; }
export class Bank { constructor(public items: Question[]) {} size(): number { return this.items.length; } }
`);
  fs.writeFileSync(path.join(dir, 'data', 'questions.json'), JSON.stringify({ version: 1, questions }, null, 2));
  fs.writeFileSync(path.join(dir, 'tools', 'gen.py'), `"""Generate question banks."""
import json
import sys

MAX_ITEMS = 40
TAGS = ["neuro", "msk"]


class Generator:
    def __init__(self, n):
        self.n = n

    def make(self):
        return [{"id": i, "q": f"Q{i}", "a": ["A", "B", "C", "D"], "c": i % 4} for i in range(self.n)]


def main(argv):
    g = Generator(int(argv[1]) if len(argv) > 1 else MAX_ITEMS)
    json.dump(g.make(), sys.stdout)


if __name__ == "__main__":
    main(sys.argv)
`);
  // JSX inside a plain .js file (React projects do this): no JS parser can judge it, so checks must skip, not fail
  fs.writeFileSync(path.join(dir, 'src', 'widget.js'), `import React from 'react';\n\nexport function Widget({ title }) {\n  return <div className="w"><h1>{title}</h1></div>;\n}\n`);
  // ESM with top-level await: valid only as a module
  fs.writeFileSync(path.join(dir, 'src', 'tla.mjs'), `const cfg = await Promise.resolve({ ok: true });\nexport default cfg;\n`);
  // Python with async, decorators and a nested class: exercises the ast-based outline
  fs.writeFileSync(path.join(dir, 'tools', 'svc.py'), `import asyncio\n\n\nclass Service:\n    """A service."""\n\n    @staticmethod\n    def build(cfg):\n        return Service()\n\n    async def fetch(self, url, *, retries=3):\n        await asyncio.sleep(0)\n        return url\n\n    class Inner:\n        def ping(self):\n            return "pong"\n\n\nasync def run(argv):\n    svc = Service.build(None)\n    return await svc.fetch(argv[0])\n`);
  fs.writeFileSync(path.join(dir, 'styles.css'), `:root { --x: 1; }\n.a { color: red; }\n@media (min-width: 800px) { .a { color: blue; } }\n`);
  fs.writeFileSync(path.join(dir, 'README.md'), `# Arena Fixture\n\nA fixture project.\n\n## Running\n\nOpen index.html.\n\n## Architecture\n\n### Engine\n\nSee src/app.js.\n`);
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'arena-fixture', version: '1.0.0', scripts: { test: 'node -e "process.exit(0)"', lint: 'echo lint', build: 'echo build' }, devDependencies: {} }, null, 2));
  fs.writeFileSync(path.join(dir, 'deploy.ps1'), `param([string]$Target = "dist")\nfunction Publish-Site {\n  param($Path)\n  Write-Host "publishing $Path"\n}\nPublish-Site -Path $Target\n`);
  fs.writeFileSync(path.join(dir, 'run.sh'), `#!/usr/bin/env bash\nset -euo pipefail\nbuild() {\n  echo build\n}\nbuild\n`);
  fs.writeFileSync(path.join(dir, '.gitignore'), `node_modules/\ndist/\n*.log\n`);

  // broken files
  fs.writeFileSync(path.join(dir, 'broken', 'bad.js'), `const a = 1;\nfunction f() {\n  return a ? 1 : \n}\n`);
  fs.writeFileSync(path.join(dir, 'broken', 'bad.json'), `{\n  "a": 1,\n  "b": [1, 2,],\n  "c": 3\n}\n`);
  fs.writeFileSync(path.join(dir, 'broken', 'bad.py'), `def f(:\n    return 1\n`);
  fs.writeFileSync(path.join(dir, 'broken', 'bad.css'), `.a { color: red;\n.b { color: blue; }\n`);
  fs.writeFileSync(path.join(dir, 'broken', 'bad.html'), `<!DOCTYPE html>\n<html><head><title>x</title></head>\n<body>\n<div id="a"></div>\n<script>\nfunction ok() { return 1; }\n</script>\n<script>\nfunction broken() {\n  const x = [1, 2;\n  return x;\n}\n</script>\n</body></html>\n`);
  fs.writeFileSync(path.join(dir, 'broken', 'bad.ps1'), `function Bad {\n  Write-Host "x"\n`);
  fs.writeFileSync(path.join(dir, 'broken', 'bad.sh'), `#!/bin/bash\nif [ 1 -eq 1 ]; then\n  echo hi\n`);
  fs.writeFileSync(path.join(dir, 'broken', 'bad.svg'), `<svg xmlns="http://www.w3.org/2000/svg"><g><rect/></svg>\n`);
  // an import statement in a CommonJS file is a real error (node rejects it); the checker must not "auto-detect" it away
  fs.writeFileSync(path.join(dir, 'broken', 'esm-in.cjs'), `import fs from 'fs';\nmodule.exports = fs;\n`);

  // git repo with one commit so git tools have something to say
  const run = (args) => spawnSync('git', args, { cwd: dir, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'fixture', GIT_AUTHOR_EMAIL: 'f@x', GIT_COMMITTER_NAME: 'fixture', GIT_COMMITTER_EMAIL: 'f@x' } });
  run(['init', '-q', '-b', 'main']);
  run(['add', '-A']);
  run(['commit', '-q', '-m', 'fixture: initial']);
  // make one uncommitted change so the stop hook / git info sees it
  fs.appendFileSync(path.join(dir, 'README.md'), '\nChanged after commit.\n');
  return dir;
}

module.exports = { makeFixture, b64blob };

if (require.main === module) {
  const dir = process.argv[2] || path.join(os.tmpdir(), 'turbo-fixture');
  makeFixture(dir);
  console.log(dir);
}
