#!/usr/bin/env node
'use strict';
// Regenerates the eval fixtures from the deterministic test fixture builder, so the eval cases
// and the test suite agree on every line number. Run after changing tests/fixture.js:
//   node plugins/turbo/evals/make-fixtures.js
// Output (committed, so evals run on a plain checkout without a build step):
//   evals/fixtures/webapp/  a large single-file web app: index.html (360KB, 98% embedded base64), README, package.json
//   evals/fixtures/multi/   a small multi-file repo: src/, tools/, data/, README, package.json, scripts

const fs = require('fs');
const path = require('path');
const os = require('os');
const { makeFixture } = require('../../../tests/fixture');

const OUT = path.join(__dirname, 'fixtures');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'turbo-evalfix-'));
makeFixture(tmp);

function copy(rel, destRoot, renameTo) {
  const src = path.join(tmp, rel);
  const dst = path.join(destRoot, renameTo || rel);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
}

fs.rmSync(OUT, { recursive: true, force: true });

const webapp = path.join(OUT, 'webapp');
for (const f of ['index.html', 'package.json', 'styles.css']) copy(f, webapp);
fs.writeFileSync(path.join(webapp, 'README.md'), '# Arena\n\nA single-file quiz game. Open `index.html` in a browser; there is no build step.\nThe sound and image assets are embedded in `index.html` as base64 data URIs.\n');

const multi = path.join(OUT, 'multi');
for (const f of ['src/app.js', 'src/util.cjs', 'src/util.mjs', 'src/types.ts', 'src/widget.js', 'src/tla.mjs', 'data/questions.json', 'tools/gen.py', 'tools/svc.py', 'package.json', 'deploy.ps1', 'run.sh', 'styles.css']) copy(f, multi);
fs.writeFileSync(path.join(multi, 'README.md'), '# Arena tools\n\nSupporting code for the Arena quiz game.\n\n## Layout\n\n- `src/` application code (CommonJS entry in `src/app.js`, ESM helpers, a React widget, TypeScript types)\n- `data/questions.json` the question bank\n- `tools/` Python generators for question banks\n\n## Running\n\n`npm test`, `npm run lint`, `npm run build`. Generate a bank with `python tools/gen.py 40 > data/questions.json`.\n');
fs.writeFileSync(path.join(multi, '.gitignore'), 'node_modules/\ndist/\n');

fs.rmSync(tmp, { recursive: true, force: true });
const count = (d) => fs.readdirSync(d, { withFileTypes: true, recursive: true }).filter((e) => e.isFile()).length;
console.log(`fixtures written: webapp (${count(webapp)} files), multi (${count(multi)} files) under ${OUT}`);
