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

  // ---- security review round ----
  // 10. overlapping roots are scanned once, so a file never pairs with itself as a "duplicate"
  const r2 = tidy.buildReport([root, path.join(root, 'docs'), root], { ...opts }, () => {});
  check('tidy: overlapping roots (root + root/docs + root again) collapse to one scan with the same findings', r2.roots.length === 1 && r2.scanned.files === r.scanned.files && r2.duplicates.length === 1 && !r2.duplicates.some((g) => g.extra.includes(g.keep)), JSON.stringify([r2.roots, r2.scanned.files, r2.duplicates]));
  check('tidy: normalizeRoots drops nested and repeated roots whichever order they come in', tidy.normalizeRoots([path.join(root, 'docs'), root, path.join(root, 'photos')]).length === 1 && tidy.normalizeRoots([root, path.join(DATA, 'tidy-claude')]).length === 2);
  {
    const linkRoot = path.join(DATA, 'tidy-rootlink');
    let ok = null;
    try { fs.symlinkSync(root, linkRoot, 'dir'); ok = tidy.normalizeRoots([linkRoot, root]); } catch { /* no symlink privilege */ }
    if (ok) {
      check('tidy: a root given through a symlink keeps its typed form and is not scanned twice (macOS /var -> /private/var)', ok.length === 1 && ok[0] === linkRoot && tidy.buildReport([linkRoot], { ...opts }, () => {}).duplicates[0].keep.startsWith(linkRoot), JSON.stringify(ok));
      try { fs.unlinkSync(linkRoot); } catch { /* ignore */ }
    }
  }
  // 11. project folders are units: nothing inside them is a duplicate of another project's file or an empty file to remove
  const root2 = path.join(DATA, 'tidy-root2');
  fs.rmSync(root2, { recursive: true, force: true });
  const W2 = (rel, content) => { const p = path.join(root2, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, content); return p; };
  const jq = rnd(4096, 9);
  W2('code/siteA/package.json', '{}'); W2('code/siteA/lib/jquery.min.js', jq);
  W2('code/siteB/package.json', '{}'); W2('code/siteB/lib/jquery.min.js', jq);
  W2('Downloads/jquery.min.js', jq); W2('Downloads/jquery (1).min.js', jq);
  W2('code/pkg/pyproject.toml', '[project]'); W2('code/pkg/mypkg/__init__.py', ''); W2('code/pkg/mypkg/sub/__init__.py', ''); W2('code/pkg/.gitkeep', ''); fs.mkdirSync(path.join(root2, 'code', 'pkg', 'logs'), { recursive: true });
  W2('notes/empty.txt', ''); W2('.env', ''); W2('stub.js', ''); W2('dev/x/notes.txt', 'kept'); fs.mkdirSync(path.join(root2, 'loose-empty'));
  const p2 = tidy.buildReport([root2], { ...tidy.parseArgs([root2, '--claude-dir', claudeDir, '--quiet']) }, () => {});
  check('tidy: three project folders detected; both sites keep their own jquery, only the loose Downloads copies are extras', p2.projects.count === 3 && p2.duplicates.length === 1 && /code[\\/]site[AB][\\/]lib[\\/]jquery\.min\.js$/.test(p2.duplicates[0].keep) && p2.duplicates[0].extra.length === 2 && p2.duplicates[0].extra.every((e) => /Downloads/.test(e)), JSON.stringify([p2.projects, p2.duplicates]));
  check('tidy: __init__.py, .gitkeep, dotfiles and code stubs are never "empty files"; a loose 0-byte notes file is', p2.emptyFiles.length === 1 && /notes[\\/]empty\.txt$/.test(p2.emptyFiles[0]), JSON.stringify(p2.emptyFiles));
  check('tidy: an empty folder inside a project (pkg/logs) is left alone; a loose one is reported', !p2.emptyDirs.some((d) => /logs$/.test(d)) && p2.emptyDirs.some((d) => /loose-empty$/.test(d)), JSON.stringify(p2.emptyDirs));
  check('tidy: a folder named dev below the root is scanned (only /dev, /proc, /sys at a filesystem root are skipped)', p2.scanned.files === 14, String(p2.scanned.files));
  check('tidy: the text report explains that project folders are units', /3 project folder\(s\)[^\n]*treated as units/.test(tidy.printReport(p2, opts)), tidy.printReport(p2, opts).split('\n')[2]);
  const p3 = tidy.buildReport([root2], { ...tidy.parseArgs([root2, '--claude-dir', claudeDir, '--quiet', '--include-projects']) }, () => {});
  check('tidy --include-projects: project files may be extras and project placeholders stay protected', p3.duplicates[0].extra.length === 3 && p3.emptyFiles.length === 1 && p3.projects.included, JSON.stringify([p3.duplicates, p3.emptyFiles]));
  // 12. skills: only a personal copy under ~/.claude/skills is ever a candidate; plugin storage is never touched
  for (const d of [path.join(claudeDir, 'plugins', 'cache', 'mk', 'plug', '1.0.0', 'skills', 'bar'), path.join(claudeDir, 'plugins', 'marketplaces', 'mk', 'plugins', 'plug', 'skills', 'bar')]) { fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, 'SKILL.md'), '---\nname: bar\ndescription: y\n---\nbody\n'); }
  const ai2 = tidy.findAiLeftovers({ ...opts }, [root]);
  check('tidy: the duplicated personal skill is the candidate (never the plugin copy); a cache+marketplace pair is not reported', ai2.some((a) => /skill "foo"/.test(a.why) && a.abs === path.join(claudeDir, 'skills', 'foo')) && !ai2.some((a) => /skill "bar"/.test(a.why)) && !ai2.some((a) => a.abs.startsWith(path.join(claudeDir, 'plugins'))), JSON.stringify(ai2.map((a) => a.abs)));
  const refuse = cli([path.join(claudeDir, 'plugins'), '--claude-dir', claudeDir]);
  check('tidy: refuses a root inside Claude Code plugin storage', refuse.status === 2 && /plugin storage/.test(refuse.stderr), refuse.stderr);
  // 18/19. --undo trusts only moves that land inside the quarantine folder; every move is logged before the manifest is rewritten
  const q2 = path.join(DATA, 'tidy-fake-quarantine');
  fs.rmSync(q2, { recursive: true, force: true }); fs.mkdirSync(q2, { recursive: true });
  const victim = path.join(DATA, 'tidy-victim.txt'); fs.writeFileSync(victim, 'victim');
  fs.writeFileSync(path.join(q2, 'manifest.json'), JSON.stringify({ moved: [{ from: path.join(DATA, 'tidy-stolen.txt'), to: victim, category: 'junk' }], removedEmptyDirs: [] }));
  const u2 = cli(['--undo', q2]);
  check('tidy --undo: a manifest entry whose "to" is outside the quarantine folder is refused, the file stays put', u2.status === 0 && fs.existsSync(victim) && !fs.existsSync(path.join(DATA, 'tidy-stolen.txt')) && /refused/.test(u2.stdout), u2.stdout + u2.stderr);
  const a2 = cli([root2, '--claude-dir', claudeDir, '--apply', '--only', 'duplicates,empty', '--quiet', '--json']);
  let a2j = null; try { a2j = JSON.parse(a2.stdout.slice(a2.stdout.indexOf('{'))); } catch { /* */ }
  const logLines = a2j ? fs.readFileSync(path.join(a2j.quarantine, 'moves.log'), 'utf8').trim().split('\n') : [];
  check('tidy --apply: moves.log holds one line per move and the manifest is complete', a2j && a2j.manifest.moved.length === 3 && logLines.length === 3 && JSON.parse(logLines[0]).to === a2j.manifest.moved[0].to, a2.stdout.slice(0, 300) + a2.stderr);
  if (a2j) {
    // simulate a crash after the log write: drop the manifest's moved list and undo from the log alone
    fs.writeFileSync(path.join(a2j.quarantine, 'manifest.json'), JSON.stringify({ ...a2j.manifest, moved: [] }));
    const u3 = cli(['--undo', a2j.quarantine]);
    check('tidy --undo: restores from moves.log when manifest.json lost the moves', u3.status === 0 && fs.existsSync(path.join(root2, 'Downloads', 'jquery.min.js')) && fs.existsSync(path.join(root2, 'notes', 'empty.txt')), u3.stdout + u3.stderr);
  }
  // Codex review round: a slug folder shared by a deleted and a live project; --undo through a planted symlink; restore destinations
  const shared = path.join(claudeDir, 'projects', '-shared-slug');
  fs.mkdirSync(shared, { recursive: true });
  const gone2 = process.platform === 'win32' ? 'C:\\also-gone\\xyz' : '/also-gone/xyz';
  fs.writeFileSync(path.join(shared, 'orphan.jsonl'), `${JSON.stringify({ type: 'user', cwd: gone2 })}\n`);
  fs.writeFileSync(path.join(shared, 'live.jsonl'), `${JSON.stringify({ type: 'user', cwd: root2 })}\n`);
  const ai3 = tidy.findAiLeftovers({ ...opts }, [root]);
  const sharedEntry = ai3.find((a) => a.abs === shared);
  check('tidy: in a slug folder shared by a deleted and a live project only the orphaned transcripts are candidates, never the folder', sharedEntry && Array.isArray(sharedEntry.files) && sharedEntry.files.length === 1 && /orphan\.jsonl$/.test(sharedEntry.files[0]) && tidy.transcriptCwds(shared).length === 2 && ai3.some((a) => a.abs === orphan && !a.files), JSON.stringify(sharedEntry));
  const q3 = path.join(DATA, 'tidy-fake-quarantine-3'); fs.rmSync(q3, { recursive: true, force: true }); fs.mkdirSync(q3, { recursive: true });
  const victimDir = path.join(DATA, 'tidy-victim-dir'); fs.rmSync(victimDir, { recursive: true, force: true }); fs.mkdirSync(victimDir, { recursive: true }); fs.writeFileSync(path.join(victimDir, 'victim.txt'), 'victim');
  let linked3 = false; try { fs.symlinkSync(victimDir, path.join(q3, 'link'), 'dir'); linked3 = true; } catch { /* no symlink privilege */ }
  if (linked3) {
    fs.writeFileSync(path.join(q3, 'manifest.json'), JSON.stringify({ roots: [DATA], claudeDir, moved: [{ from: path.join(DATA, 'tidy-stolen3.txt'), to: path.join(q3, 'link', 'victim.txt'), category: 'junk' }], removedEmptyDirs: [] }));
    const u3 = cli(['--undo', q3]);
    check('tidy --undo: a manifest entry reaching through a symlink planted in the quarantine is refused', u3.status === 0 && fs.existsSync(path.join(victimDir, 'victim.txt')) && !fs.existsSync(path.join(DATA, 'tidy-stolen3.txt')) && /refused/.test(u3.stdout), u3.stdout + u3.stderr);
  }
  const q4 = path.join(DATA, 'tidy-fake-quarantine-4'); fs.rmSync(q4, { recursive: true, force: true }); fs.mkdirSync(q4, { recursive: true }); fs.writeFileSync(path.join(q4, 'x.txt'), 'x');
  fs.writeFileSync(path.join(q4, 'manifest.json'), JSON.stringify({ roots: [root], claudeDir, moved: [{ from: path.join(os.tmpdir(), `turbo-outside-target-${process.pid}.txt`), to: path.join(q4, 'x.txt'), category: 'junk' }], removedEmptyDirs: [] }));
  const u4 = cli(['--undo', q4]);
  check('tidy --undo: a restore destination outside the scanned roots and the Claude directory is refused', u4.status === 0 && fs.existsSync(path.join(q4, 'x.txt')) && /refused/.test(u4.stdout), u4.stdout + u4.stderr);
  // 12. desktop.ini is never junk; a program's own folder (an .exe, or a macOS .app bundle) is a unit like a project
  const root3 = path.join(DATA, 'tidy-root3');
  fs.rmSync(root3, { recursive: true, force: true });
  const W3 = (rel, content) => { const p = path.join(root3, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, content); return p; };
  const D3 = (rel) => fs.mkdirSync(path.join(root3, rel), { recursive: true });
  const dll = rnd(5000, 21); const setup = rnd(6000, 22);
  W3('Downloads/desktop.ini', '[.ShellClassInfo]\r\nLocalizedResourceName=@shell32.dll,-21798\r\n'); W3('Downloads/Pictures/desktop.ini', '[.ShellClassInfo]\r\n'); W3('Downloads/Thumbs.db', 'thumbs');
  W3('Downloads/setup.exe', setup); W3('Downloads/setup (1).exe', setup); // installers loose in Downloads: Downloads is never an app folder
  W3('Downloads/BG3ModManager_Latest/BG3ModManager.exe', rnd(7000, 23)); D3('Downloads/BG3ModManager_Latest/Data'); D3('Downloads/BG3ModManager_Latest/Orders');
  W3('Downloads/BetterJoy_v7.1/BetterJoyForCemu.exe', rnd(7000, 24)); W3('Downloads/BetterJoy_v7.1/! Install the drivers in the Drivers folder', ''); W3('Downloads/BetterJoy_v7.1/ViGEm.dll', dll); D3('Downloads/BetterJoy_v7.1/Drivers/HidCerberus/Content/custom');
  W3('Downloads/OtherApp/other.exe', rnd(7000, 25)); W3('Downloads/OtherApp/ViGEm.dll', dll); // the same DLL shipped by two apps: neither copy is an extra
  W3('Downloads/loose/ViGEm.dll', dll); // a loose copy of it is
  W3('Apps/Foo.app/Contents/MacOS/foo', rnd(3000, 26)); D3('Apps/Foo.app/Contents/Resources/empty');
  D3('Downloads/Quick Share'); W3('Downloads/notes/empty.txt', '');
  const p4 = tidy.buildReport([root3], { ...tidy.parseArgs([root3, '--claude-dir', claudeDir, '--quiet']) }, () => {});
  check('tidy: desktop.ini is never junk (it holds the folder icon and name); Thumbs.db still is', p4.junk.length === 1 && /Thumbs\.db$/.test(p4.junk[0].abs) && !p4.junk.some((j) => /desktop\.ini$/i.test(j.abs)), JSON.stringify(p4.junk));
  check('tidy: folders holding an .exe and a macOS .app bundle are app folders; Downloads itself is not', p4.projects.apps === 4 && p4.projects.count === 0, JSON.stringify(p4.projects));
  check('tidy: empty folders inside apps (Data, Orders, driver Content/custom, .app Resources) are left alone; a loose one is reported', p4.emptyDirs.length === 1 && /Quick Share$/.test(p4.emptyDirs[0]), JSON.stringify(p4.emptyDirs));
  check('tidy: a 0-byte instruction file inside an app is not an empty file; a loose 0-byte file is', p4.emptyFiles.length === 1 && /notes[\\/]empty\.txt$/.test(p4.emptyFiles[0]), JSON.stringify(p4.emptyFiles));
  const dllGroup = p4.duplicates.find((g) => /ViGEm\.dll$/.test(g.keep));
  const setupGroup = p4.duplicates.find((g) => /setup/.test(g.keep));
  check('tidy: a DLL shipped by two apps stays in both; only the loose copy is an extra', !!dllGroup && dllGroup.extra.length === 1 && /loose[\\/]ViGEm\.dll$/.test(dllGroup.extra[0]) && /(BetterJoy_v7\.1|OtherApp)[\\/]ViGEm\.dll$/.test(dllGroup.keep), JSON.stringify(p4.duplicates));
  check('tidy: duplicate installers loose in Downloads are still found (a setup.exe does not make Downloads an app)', !!setupGroup && /setup\.exe$/.test(setupGroup.keep) && setupGroup.extra.length === 1 && /setup \(1\)\.exe$/.test(setupGroup.extra[0]), JSON.stringify(p4.duplicates));
  check('tidy: the text report counts app folders as units', /4 app folder\(s\)[^\n]*treated as units/.test(tidy.printReport(p4, opts)), tidy.printReport(p4, opts).split('\n')[2]);
  const dl3 = path.join(root3, 'Downloads');
  const p5 = tidy.buildReport([dl3], { ...tidy.parseArgs([dl3, '--claude-dir', claudeDir, '--quiet']) }, () => {});
  check('tidy: scanning Downloads directly finds the three apps inside it and still reports the loose installer copy', p5.projects.apps === 3 && p5.duplicates.some((g) => /setup/.test(g.keep)), JSON.stringify(p5.projects));
  const bg3 = path.join(dl3, 'BG3ModManager_Latest');
  const p6 = tidy.buildReport([bg3], { ...tidy.parseArgs([bg3, '--claude-dir', claudeDir, '--quiet']) }, () => {});
  check('tidy: scanning an app folder directly still treats it as an app (its empty Data and Orders stay)', p6.projects.apps === 1 && p6.emptyDirs.length === 0, JSON.stringify([p6.projects, p6.emptyDirs]));
  const a5 = cli([root3, '--claude-dir', claudeDir, '--apply', '--only', 'duplicates,empty,junk', '--quiet', '--json']);
  let a5j = null; try { a5j = JSON.parse(a5.stdout.slice(a5.stdout.indexOf('{'))); } catch { /* */ }
  const kept3 = ['Downloads/desktop.ini', 'Downloads/Pictures/desktop.ini', 'Downloads/BG3ModManager_Latest/Data', 'Downloads/BetterJoy_v7.1/! Install the drivers in the Drivers folder', 'Downloads/BetterJoy_v7.1/Drivers/HidCerberus/Content/custom', 'Downloads/BetterJoy_v7.1/ViGEm.dll', 'Downloads/OtherApp/ViGEm.dll', 'Apps/Foo.app/Contents/Resources/empty', 'Downloads/setup.exe'];
  const gone3 = ['Downloads/Thumbs.db', 'Downloads/loose/ViGEm.dll', 'Downloads/Quick Share', 'Downloads/setup (1).exe', 'Downloads/notes/empty.txt'];
  const at3 = (rel) => fs.existsSync(path.join(root3, ...rel.split('/')));
  check('tidy --apply: desktop.ini files and app folders (their empty folders, 0-byte files, DLLs) stay; Thumbs.db, loose copies and loose empties move', a5.status === 0 && !!a5j && kept3.every(at3) && !gone3.some(at3), JSON.stringify({ missing: kept3.filter((r) => !at3(r)), stillThere: gone3.filter(at3) }) + a5.stderr);
  void os;
}

module.exports = { run };
