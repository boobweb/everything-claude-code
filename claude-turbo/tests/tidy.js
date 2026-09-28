'use strict';
// Tests for scripts/tidy.js: builds a cluttered tree in a temp dir, checks the report, then
// quarantines with --apply, verifies every move, and restores everything with --undo.

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

function run(check, { PLUGIN, DATA }) {
  const tidy = require(path.join(PLUGIN, 'scripts', 'tidy.js'));
  const TIDY = path.join(PLUGIN, 'scripts', 'tidy.js');
  const root = path.join(DATA, 'tidy-root');
  const claudeDir = path.join(DATA, 'tidy-claude');
  const W = (rel, content) => { const p = path.join(root, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, content); return p; };
  const rnd = (n, seed) => { const b = Buffer.alloc(n); let x = seed; for (let i = 0; i < n; i++) { x = (x * 1103515245 + 12345) & 0x7fffffff; b[i] = x & 0xff; } return b; };
  const oldTime = new Date(Date.now() - 200 * 86400000);

  console.log('\n# Tidy (scripts/tidy.js)');
  fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(claudeDir, { recursive: true, force: true });
  const big = rnd(2048, 1);
  W('docs/report.pdf', big); W('docs/report - Copy.pdf', big); W('backup/report (1).pdf', big);
  W('photos/a.jpg', rnd(3000, 2)); W('photos/b.jpg', rnd(3000, 3));
  W('small.txt', 'same ten b'); W('small2.txt', 'same ten b'); // below --min-size: not reported
  W('empty.txt', '');
  fs.mkdirSync(path.join(root, 'emptydir')); fs.mkdirSync(path.join(root, 'nested', 'emptier'), { recursive: true });
  W('Thumbs.db', 'x'); W('docs/~$notes.docx', 'lock'); const oldTmp = W('old.tmp', 'old'); W('new.tmp', 'new');
  fs.utimesSync(oldTmp, oldTime, oldTime);
  W('node_modules/x/a.js', 'module.exports = 1;'.repeat(100)); W('node_modules/y/a.js', 'module.exports = 1;'.repeat(100));
  for (const f of ['node_modules/x/a.js', 'node_modules/y/a.js']) fs.utimesSync(path.join(root, f), oldTime, oldTime);
  W('archive.zip', rnd(1500, 4)); fs.mkdirSync(path.join(root, 'archive')); W('archive/inside.txt', 'hi');
  // fake ~/.claude: an orphaned transcript dir, a live one (its path contains hyphens, so the slug alone is
  // ambiguous), a slug-only dir with no cwd and an ambiguous name (must not be guessed), and a duplicated skill
  const gone = process.platform === 'win32' ? 'C:\\does-not\\exist-xyz' : '/does-not/exist-xyz';
  const orphan = path.join(claudeDir, 'projects', process.platform === 'win32' ? 'C--does-not-exist-xyz' : '-does-not-exist-xyz');
  fs.mkdirSync(orphan, { recursive: true }); fs.writeFileSync(path.join(orphan, 'abc.jsonl'), `${JSON.stringify({ type: 'user', cwd: gone, message: 'x' })}\n`.repeat(50));
  const liveSlug = process.platform === 'win32' ? root.replace(/^([A-Za-z]):\\/, '$1--').replace(/\\/g, '-') : root.replace(/\//g, '-');
  fs.mkdirSync(path.join(claudeDir, 'projects', liveSlug), { recursive: true }); fs.writeFileSync(path.join(claudeDir, 'projects', liveSlug, 'live.jsonl'), `${JSON.stringify({ type: 'user', cwd: root })}\n`);
  fs.mkdirSync(path.join(claudeDir, 'projects', '-some-old-hyphen-name'), { recursive: true }); fs.writeFileSync(path.join(claudeDir, 'projects', '-some-old-hyphen-name', 'x.jsonl'), '{"no":"cwd"}\n');
  for (const d of [path.join(claudeDir, 'skills', 'foo'), path.join(claudeDir, 'plugins', 'repos', 'm', 'skills', 'foo')]) { fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, 'SKILL.md'), '---\nname: foo\ndescription: x\n---\nbody\n'); }

  const opts = { ...tidy.parseArgs([root, '--claude-dir', claudeDir, '--quiet']) };
  const r = tidy.buildReport([root], opts, () => {});
  check('tidy: scan counts files and skips node_modules contents', r.scanned.files === 14 && !r.duplicates.some((g) => /node_modules/.test(g.keep)), JSON.stringify(r.scanned));
  check('tidy: one duplicate group of 2KB, original kept (not copy-named, shortest path), two extras', r.duplicates.length === 1 && r.duplicates[0].size === 2048 && r.duplicates[0].keep === path.join(root, 'docs', 'report.pdf') && r.duplicates[0].extra.length === 2 && r.duplicates[0].reclaim === 4096, JSON.stringify(r.duplicates));
  check('tidy: identical files under --min-size are not duplicates', !r.duplicates.some((g) => /small/.test(g.keep)));
  check('tidy: empty file and empty folders (including a folder that only holds an empty folder)', r.emptyFiles.length === 1 && /empty\.txt$/.test(r.emptyFiles[0]) && r.emptyDirs.length === 3 && r.emptyDirs.some((d) => d.endsWith('nested')) && r.emptyDirs.some((d) => d.endsWith('emptier')), JSON.stringify(r.emptyDirs));
  check('tidy: junk = Thumbs.db, Office lock file, stale .tmp; fresh .tmp is kept', r.junk.length === 3 && r.junk.some((j) => /Thumbs\.db$/.test(j.abs)) && r.junk.some((j) => /~\$notes\.docx$/.test(j.abs)) && r.junk.some((j) => /old\.tmp$/.test(j.abs)) && !r.junk.some((j) => /new\.tmp$/.test(j.abs)), JSON.stringify(r.junk));
  check('tidy: archive next to its extracted folder is reported', r.archives.length === 1 && /archive\.zip$/.test(r.archives[0].abs) && r.archives[0].folder === path.join(root, 'archive'), JSON.stringify(r.archives));
  check('tidy: heavy = node_modules untouched for 200 days, with size and file count', r.heavy.length === 1 && /node_modules$/.test(r.heavy[0].abs) && r.heavy[0].files === 2 && r.heavy[0].size === 3800, JSON.stringify(r.heavy));
  check('tidy: AI leftovers = orphaned transcript folder (cwd read from the transcript) and duplicated skill; live and ambiguous projects untouched', r.ai.length === 2 && r.ai.some((a) => a.abs === orphan && a.why.includes(gone)) && r.ai.some((a) => /skill "foo" is byte-identical/.test(a.why)) && !r.ai.some((a) => a.abs.includes(liveSlug) || a.abs.includes('hyphen-name')), JSON.stringify(r.ai));
  check('tidy: transcriptCwd reads the cwd field, null without one', tidy.transcriptCwd(orphan) === gone && tidy.transcriptCwd(path.join(claudeDir, 'projects', '-some-old-hyphen-name')) === null);
  check('tidy: reclaim totals add up', r.reclaim.duplicates === 4096 && r.reclaim.heavy === 3800 && r.reclaim.archives === 1500 && r.reclaim.junk === 8, JSON.stringify(r.reclaim));
  const text = tidy.printReport(r, opts);
  check('tidy: text report names every category and says nothing was changed', /DUPLICATES: 1 group/.test(text) && /EMPTY: 1 zero-byte file\(s\), 3 empty folder/.test(text) && /JUNK: 3/.test(text) && /AI LEFTOVERS: 2/.test(text) && /HEAVY[^\n]*: 1 folder/.test(text) && /ARCHIVES[^\n]*: 1/.test(text) && /Nothing was changed/.test(text), text);

  // snapshot, apply, verify, undo, compare
  const snapshot = (dir) => { const out = {}; const rel = (p) => path.relative(dir, p).replace(/\\/g, '/'); const rec = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) { out[rel(p) + '/'] = 'dir'; rec(p); } else out[rel(p)] = crypto.createHash('sha1').update(fs.readFileSync(p)).digest('hex'); } }; rec(dir); return out; };
  const before = { root: snapshot(root), claude: snapshot(claudeDir) };
  const cli = (args) => spawnSync(process.execPath, [TIDY, ...args], { encoding: 'utf8', timeout: 60000 });
  const a = cli([root, '--claude-dir', claudeDir, '--apply', '--quiet', '--json']);
  let aj = null; try { aj = JSON.parse(a.stdout.slice(a.stdout.indexOf('{'))); } catch { /* */ }
  check('tidy --apply: exits 0, writes a manifest in a quarantine folder inside the root', a.status === 0 && aj && aj.quarantine.startsWith(path.join(root, '_turbo-quarantine')) && fs.existsSync(path.join(aj.quarantine, 'manifest.json')), a.stdout.slice(0, 300) + a.stderr);
  const moved = aj ? aj.manifest.moved : [];
  check('tidy --apply: duplicates (extras only), junk, empty file and AI leftovers moved; kept copy, fresh tmp, heavy and archives untouched', moved.length === 8 && moved.every((m) => !fs.existsSync(m.from) && fs.existsSync(m.to)) && fs.existsSync(path.join(root, 'docs', 'report.pdf')) && fs.existsSync(path.join(root, 'new.tmp')) && fs.existsSync(path.join(root, 'node_modules', 'x', 'a.js')) && fs.existsSync(path.join(root, 'archive.zip')) && !fs.existsSync(path.join(root, 'docs', 'report - Copy.pdf')) && !fs.existsSync(orphan), JSON.stringify(moved.map((m) => [m.category, m.from])));
  check('tidy --apply: empty folders removed, quarantine keeps relative paths, outside-root items land under _outside', aj && aj.manifest.removedEmptyDirs.length === 3 && !fs.existsSync(path.join(root, 'nested')) && fs.existsSync(path.join(aj.quarantine, 'docs', 'report - Copy.pdf')) && moved.some((m) => m.from === orphan && m.to.includes('_outside')), JSON.stringify(aj && aj.manifest.removedEmptyDirs));
  const u = cli(['--undo', aj ? aj.quarantine : 'nope']);
  const after = { root: snapshot(root), claude: snapshot(claudeDir) };
  delete after.root['_turbo-quarantine/']; for (const k of Object.keys(after.root)) if (k.startsWith('_turbo-quarantine/')) delete after.root[k];
  check('tidy --undo: restores every file and folder byte-for-byte', u.status === 0 && JSON.stringify(after.root) === JSON.stringify(before.root) && JSON.stringify(after.claude) === JSON.stringify(before.claude), u.stdout + u.stderr + '\n' + JSON.stringify(Object.keys(after.root).filter((k) => !before.root[k])) + JSON.stringify(Object.keys(before.root).filter((k) => !after.root[k])));
  const only = cli([root, '--claude-dir', claudeDir, '--apply', '--only', 'junk', '--quiet', '--json']);
  let oj = null; try { oj = JSON.parse(only.stdout.slice(only.stdout.indexOf('{'))); } catch { /* */ }
  check('tidy --apply --only junk: moves only the 3 junk items', oj && oj.manifest.moved.length === 3 && oj.manifest.moved.every((m) => m.category === 'junk') && fs.existsSync(path.join(root, 'docs', 'report - Copy.pdf')), JSON.stringify(oj && oj.manifest.moved));
  cli(['--undo', oj ? oj.quarantine : 'nope']);
  const h = cli([]);
  check('tidy: no arguments -> usage, exit 2; --help -> exit 0', h.status === 2 && /Usage/.test(h.stdout + h.stderr) && cli(['--help']).status === 0);
  const nope = cli([path.join(root, 'does-not-exist')]);
  check('tidy: missing root -> exit 2 with a message', nope.status === 2 && /Not found/.test(nope.stderr));
  void os;
}

module.exports = { run };
