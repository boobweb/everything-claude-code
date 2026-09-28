'use strict';
// Unit tests for the command guard's structural analysis and the path helpers, with
// platform-aware expectations so the same file is meaningful on Windows, macOS and Linux.
// Called by run-tests.js with its check() function; needs no MCP server.

const path = require('path');
const os = require('os');

function run(check, { PLUGIN, FIX }) {
  const guard = require(path.join(PLUGIN, 'scripts', 'hook-pre-bash.js'));
  const fsx = require(path.join(PLUGIN, 'lib', 'fsx'));
  const WIN = process.platform === 'win32';
  const ctx = { cwd: FIX, root: FIX };
  const home = os.homedir();

  console.log(`\n# Guards and paths (unit, ${process.platform})`);

  // ---- tokenizer / segmenter ----
  check('tokens: quoted strings stay whole, quotes removed', JSON.stringify(guard.tokens('rm -rf "a b" \'c d\' e')) === JSON.stringify(['rm', '-rf', 'a b', 'c d', 'e']), JSON.stringify(guard.tokens('rm -rf "a b" \'c d\' e')));
  check('tokens: backslash-space is an escaped space in POSIX segments only', guard.tokens('rm -rf my\\ dir')[2] === 'my dir' && guard.tokens('Remove-Item C:\\my\\ dir')[1] === 'C:\\my\\', JSON.stringify([guard.tokens('rm -rf my\\ dir'), guard.tokens('Remove-Item C:\\my\\ dir')]));
  const segs = guard.splitSegments('cd build && rm -rf * ; echo "a;b" | grep a || true\nls');
  check('splitSegments: splits on ; && || | newline, not inside quotes, marks after-pipe', segs.length === 6 && segs[2].text === 'echo "a;b"' && segs[3].afterPipe === true && segs[5].text === 'ls', JSON.stringify(segs));
  check('innerCommands: bash -c, eval, powershell -Command, cmd /c', JSON.stringify(guard.innerCommands('bash -c "rm -rf /" ; eval \'x\' ; powershell -NoProfile -Command "Remove-Item C:\\" ; cmd /c "del x"')) === JSON.stringify(['rm -rf /', 'x', 'Remove-Item C:\\', 'del x']), JSON.stringify(guard.innerCommands('bash -c "rm -rf /" ; eval \'x\' ; powershell -NoProfile -Command "Remove-Item C:\\" ; cmd /c "del x"')));

  // ---- classifyTarget: home / system / drive roots deny on every platform ----
  for (const t of ['~', '~/', '$HOME', '${HOME}', '$env:USERPROFILE', '%USERPROFILE%', '/', '/*', '/home', '/Users', '/etc', 'C:\\', 'C:/', 'C:\\*', 'C:\\Users', 'C:\\Windows', 'C:\\Program Files', 'D:\\', '%SystemRoot%\\x']) check(`classifyTarget denies ${t}`, guard.classifyTarget(t, ctx) === 'deny', guard.classifyTarget(t, ctx));
  for (const t of ['C:\\Users\\Brendan', 'C:\\Users\\Brendan\\', 'c:/users/someone/*', '/home/alice', '/Users/bob/', home]) check(`classifyTarget denies any user profile root: ${t}`, guard.classifyTarget(t, ctx) === 'deny', guard.classifyTarget(t, ctx));
  // ---- inside the project: allow; project root and .git: ask; outside: ask ----
  check('classifyTarget: relative path inside the project -> allow', guard.classifyTarget('dist', ctx) === 'allow' && guard.classifyTarget('./build/out', ctx) === 'allow' && guard.classifyTarget('.\\dist', ctx) === 'allow');
  check('classifyTarget: absolute path inside the project -> allow', guard.classifyTarget(path.join(FIX, 'dist'), ctx) === 'allow');
  check('classifyTarget: project root itself (., *, abs) -> ask', guard.classifyTarget('.', ctx) === 'ask' && guard.classifyTarget('*', ctx) === 'ask' && guard.classifyTarget(FIX, ctx) === 'ask');
  check('classifyTarget: .git -> ask', guard.classifyTarget('.git', ctx) === 'ask' && guard.classifyTarget(path.join(FIX, '.git'), ctx) === 'ask');
  check('classifyTarget: parent of the project -> deny, sibling -> ask', guard.classifyTarget('..', ctx) === 'deny' && guard.classifyTarget('../sibling', ctx) === 'ask', JSON.stringify([guard.classifyTarget('..', ctx), guard.classifyTarget('../sibling', ctx)]));
  check('classifyTarget: explicit temp path -> allow, temp root (a parent of the fixture) -> deny', guard.classifyTarget(path.join(os.tmpdir(), 'scratch-abc'), ctx) === 'allow' && guard.classifyTarget(os.tmpdir(), ctx) === 'deny', JSON.stringify([guard.classifyTarget(path.join(os.tmpdir(), 'scratch-abc'), ctx), guard.classifyTarget(os.tmpdir(), ctx)]));
  check('classifyTarget: ~\\Documents and $env:USERPROFILE\\Downloads resolve under the home directory (never inside the project)', guard.classifyTarget('~\\Documents', ctx) === 'ask' && guard.classifyTarget('$env:USERPROFILE\\Downloads', ctx) === 'ask' && guard.classifyTarget('%USERPROFILE%\\Downloads', ctx) === 'ask' && guard.classifyTarget('~/Documents', ctx) === 'ask', JSON.stringify([guard.classifyTarget('~\\Documents', ctx), guard.classifyTarget('$env:USERPROFILE\\Downloads', ctx)]));
  check('deleteGuard: Remove-Item -Recurse -Force ~\\Documents asks', guard.deleteGuard('Remove-Item -Recurse -Force ~\\Documents', ctx) && guard.deleteGuard('Remove-Item -Recurse -Force ~\\Documents', ctx).decision === 'ask', JSON.stringify(guard.deleteGuard('Remove-Item -Recurse -Force ~\\Documents', ctx)));
  check('normPath: ~\\x and ~/x both expand to the home directory', fsx.normPath('~\\Documents') === path.join(home, 'Documents') && fsx.normPath('~/Documents') === path.join(home, 'Documents'), fsx.normPath('~\\Documents'));
  check('classifyTarget: cd tracking resolves later relative targets', guard.deleteGuard('cd dist && rm -rf *', ctx) === null && guard.deleteGuard('cd .. && rm -rf *', ctx) !== null, JSON.stringify(guard.deleteGuard('cd .. && rm -rf *', ctx)));
  if (WIN) {
    check('classifyTarget (win32): a drive path inside the project resolves and allows', guard.classifyTarget(path.join(FIX, 'dist').replace(/\\/g, '/'), ctx) === 'allow');
    check('classifyTarget (win32): the current user profile via USERPROFILE denies', guard.classifyTarget(process.env.USERPROFILE || home, ctx) === 'deny');
    check('classifyTarget (win32): case-insensitive comparison of drive paths', guard.classifyTarget(path.join(FIX, 'dist').toUpperCase(), ctx) === 'allow');
  } else {
    check('classifyTarget (posix): an unresolvable Windows drive path outside known roots asks', guard.classifyTarget('C:\\Projects\\other', ctx) === 'ask');
  }

  // ---- PowerShell forms ----
  check('deleteGuard: Remove-Item -Path list splits on commas', guard.deleteGuard('Remove-Item -Recurse -Force -Path dist,build', ctx) === null && guard.deleteGuard('Remove-Item -Recurse -Path dist,..\\other', ctx) !== null);
  check('deleteGuard: Remove-Item -LiteralPath:value form', guard.deleteGuard('Remove-Item -Recurse -LiteralPath:C:\\', ctx) !== null && guard.deleteGuard('Remove-Item -Recurse -LiteralPath:C:\\', ctx).decision === 'deny');
  check('deleteGuard: Get-ChildItem pipeline supplies targets and recursion', guard.deleteGuard('Get-ChildItem dist -Recurse | Remove-Item -Force', ctx) === null && guard.deleteGuard('gci ~ -Recurse | ri -Force', ctx).decision === 'deny');
  check('deleteGuard: non-recursive deletes are never guarded', guard.deleteGuard('rm -f /etc/passwd', ctx) === null && guard.deleteGuard('del C:\\x.txt', ctx) === null);
  check('deleteGuard: -Force, -Verbose, -ErrorAction are not recursion; -Recurse, -Rec, -Recurse:$true, -Rf, -rfv are', guard.deleteGuard('Remove-Item -Force ..\\other\\file.txt', ctx) === null && guard.deleteGuard('Remove-Item -Verbose -ErrorAction Stop ../x.txt', ctx) === null && guard.deleteGuard('Remove-Item -Rec ../x', ctx) !== null && guard.deleteGuard('Remove-Item -Recurse:$true ../x', ctx) !== null && guard.deleteGuard('rm -Rf ../x', ctx) !== null && guard.deleteGuard('rm -rfv ../x', ctx) !== null, JSON.stringify([guard.deleteGuard('Remove-Item -Force ..\\other\\file.txt', ctx), guard.deleteGuard('Remove-Item -Rec ../x', ctx)]));
  check('splitSegments: a # comment ends at the line, so an apostrophe in it cannot hide the next command', guard.evaluate("# don't touch this\nrm -rf ~/", ctx) && guard.evaluate("# don't touch this\nrm -rf ~/", ctx).decision === 'deny' && guard.evaluate("echo ok # it's fine\nrm -rf ~", ctx).decision === 'deny' && guard.evaluate('echo "# not a comment" && ls', ctx) === null && guard.evaluate('echo a#b; ls', ctx) === null, JSON.stringify(guard.splitSegments("# don't touch this\nrm -rf ~/")));
  check('deleteGuard: rd /s and rmdir /s count as recursive', guard.deleteGuard('rd /s /q C:\\Users', ctx).decision === 'deny' && guard.deleteGuard('rmdir /s /q build', ctx) === null);

  // ---- evaluate: precedence deny > delete-deny > ask > delete-ask ----
  check('evaluate: deny wins over ask in one command line', guard.evaluate('git push --force origin main && rm -rf /', ctx).decision === 'deny');
  check('evaluate: inner interpreter strings are evaluated (depth-limited)', guard.evaluate('bash -c "rm -rf ~"', ctx).decision === 'deny' && guard.evaluate('powershell -Command "Remove-Item -Recurse C:\\"', ctx).decision === 'deny');
  check('evaluate: words inside strings/comments do not trigger', guard.evaluate('echo "rm -rf /"', ctx) === null && guard.evaluate('git commit -m "mkfs is bad"', ctx) === null && guard.evaluate('# rm -rf /', ctx) === null);
  const joined = 'rm -rf \\\n /'.replace(/\\\r?\n/g, ' '); // what the hook does before evaluate()
  check('evaluate: a line-continued rm -rf / is still denied once joined', guard.evaluate(joined, ctx) && guard.evaluate(joined, ctx).decision === 'deny', JSON.stringify(guard.evaluate(joined, ctx)));

  // ---- fsx path helpers (platform-aware) ----
  check('normPath: ~ expands to the home directory', fsx.normPath('~/x') === path.join(home, 'x') && fsx.normPath('~') === home);
  check('normPath: relative paths resolve against the base', fsx.normPath('a/b', FIX) === path.join(FIX, 'a', 'b'));
  if (WIN) {
    check('normPath (win32): git-bash style /c/Users/x -> C:/Users/x', /^C:\\Users\\x$/i.test(fsx.normPath('/c/Users/x')), fsx.normPath('/c/Users/x'));
    check('normPath (win32): forward slashes are normalized to backslashes', fsx.normPath('C:/a/b') === 'C:\\a\\b', fsx.normPath('C:/a/b'));
    check('normPath (win32): mixed separators in a relative path', fsx.normPath('broken\\bad.json', FIX) === path.join(FIX, 'broken', 'bad.json'));
  } else {
    check('normPath (posix): a backslash-only relative path is treated as a Windows-style path', fsx.normPath('broken\\bad.json', FIX) === path.join(FIX, 'broken', 'bad.json'), fsx.normPath('broken\\bad.json', FIX));
    check('normPath (posix): absolute paths pass through untouched', fsx.normPath('/tmp/x/../y') === '/tmp/y');
  }
  check('toPosix / relDisplay: forward slashes, outside-root paths shown absolute', fsx.toPosix('a\\b\\c') === 'a/b/c' && fsx.relDisplay(path.join(FIX, 'src', 'app.js'), FIX) === 'src/app.js' && fsx.relDisplay(path.join(os.tmpdir(), 'zzz'), FIX) === fsx.toPosix(path.join(os.tmpdir(), 'zzz')));
  check('humanSize / countLines', fsx.humanSize(1536) === '1.5KB' && fsx.humanSize(3 * 1048576) === '3.0MB' && fsx.countLines('a\nb\n') === 2 && fsx.countLines('a\nb') === 2 && fsx.countLines('') === 0);
  check('makeGlobMatcher: *.js, src/**, braces', fsx.makeGlobMatcher('*.js')('a/b.js') && !fsx.makeGlobMatcher('*.js')('a/b.ts') && fsx.makeGlobMatcher('src/**')('src/x/y.js') && !fsx.makeGlobMatcher('src/**')('lib/x.js') && fsx.makeGlobMatcher('*.{js,ts}')('q.ts'));
  check('findProjectRoot: walks up to the fixture git root', fsx.findProjectRoot(path.join(FIX, 'src')) === FIX, fsx.findProjectRoot(path.join(FIX, 'src')));

  // ---- project continuity record (lib/project.js) ----
  const project = require(path.join(PLUGIN, 'lib', 'project'));
  const tmpRoot = path.join(os.tmpdir(), `turbo-proj-${process.pid}`);
  check('project: key is stable and separator/trailing-slash insensitive', project.keyFor(tmpRoot) === project.keyFor(tmpRoot + path.sep) && project.keyFor(tmpRoot).length === 16 && (WIN ? project.keyFor(tmpRoot) === project.keyFor(tmpRoot.toUpperCase()) : project.keyFor(tmpRoot) !== project.keyFor(tmpRoot.toUpperCase())));
  check('project: empty record has zeroed stats and no sessions', JSON.stringify(project.load(tmpRoot).stats) === JSON.stringify({ sessions: 0, brokenEditsCaught: 0, commandsDenied: 0, commandsAsked: 0, writesAsked: 0, stopBlocks: 0 }) && Object.keys(project.load(tmpRoot).sessions).length === 0 && project.describe(project.load(tmpRoot), 'x') === '');
  project.startSession(tmpRoot, 'A'); project.startSession(tmpRoot, 'A');
  project.recordEdit(tmpRoot, 'A', path.join(tmpRoot, 'src', 'a.js'), true);
  project.recordEdit(tmpRoot, 'A', path.join(tmpRoot, 'src', 'b.js'), false);
  project.recordGuard(tmpRoot, 'A', 'commandsDenied'); project.recordGuard(tmpRoot, 'A', 'nonsense');
  let rec = project.recordStop(tmpRoot, 'A', ['src/b.js']);
  check('project: a session is counted once, edits keep the last known state, guards and stops are counted', rec.stats.sessions === 1 && rec.stats.brokenEditsCaught === 1 && rec.stats.commandsDenied === 1 && rec.stats.stopBlocks === 1 && rec.sessions.A.edited['src/a.js'].ok === true && rec.sessions.A.edited['src/b.js'].ok === false && rec.sessions.A.clean === false, JSON.stringify(rec));
  project.recordEdit(tmpRoot, 'A', path.join(tmpRoot, 'src', 'b.js'), false); project.recordEdit(tmpRoot, 'A', path.join(tmpRoot, 'src', 'b.js'), false);
  check('project: re-checking a still-broken file is not a new broken edit', project.load(tmpRoot).stats.brokenEditsCaught === 1);
  project.recordEdit(tmpRoot, 'A', path.join(tmpRoot, 'src', 'b.js'), true); project.recordEdit(tmpRoot, 'A', path.join(tmpRoot, 'src', 'b.js'), false);
  check('project: a file fixed and broken again counts once more', project.load(tmpRoot).stats.brokenEditsCaught === 2);
  const checkLib = require(path.join(PLUGIN, 'lib', 'check'));
  check('check: spawning checkers (py, ps1, sh) are ordered last by the Stop hook; in-process ones first', checkLib.isSlowToCheck('a.py') && checkLib.isSlowToCheck('b.PS1') && checkLib.isSlowToCheck('c.sh') && !checkLib.isSlowToCheck('d.js') && !checkLib.isSlowToCheck('e.html') && !checkLib.isSlowToCheck('f.json'));
  const capped = checkLib.checkFile(path.join(FIX, 'tools', 'gen.py'), { root: FIX, timeoutMs: 1 });
  check('check: a timeout budget below the floor still runs the checker (500 ms floor) or skips with a timeout, never errors', capped.ok === true && (!capped.skipped || capped.skipped === 'timeout'), JSON.stringify(capped));
  check('project: describe() for the next session names the last one, its files and how it ended', /^Last session \(\d+s ago\) edited src\/a\.js, src\/b\.js; ended with 1 broken file: src\/b\.js\. Turbo in this project \(1 session\): 1 broken edit caught, 1 command guarded\.$/.test(project.describe(rec, 'B')), project.describe(rec, 'B'));
  check('project: describe() ignores the current session and sessions without edits', project.describe(rec, 'A') === 'Turbo in this project (1 session): 1 broken edit caught, 1 command guarded.' && (project.startSession(tmpRoot, 'C'), /^Last session[^]*src\/a\.js/.test(project.describe(project.load(tmpRoot), 'C'))));
  rec = project.recordStop(tmpRoot, 'A', []);
  check('project: a later clean stop flips the session to clean', rec.sessions.A.clean === true && /ended clean/.test(project.describe(rec, 'Z')), project.describe(rec, 'Z'));
  for (let i = 0; i < 10; i++) project.recordEdit(tmpRoot, `S${i}`, path.join(tmpRoot, `f${i}.js`), true);
  check('project: only the 6 most recent sessions are kept', Object.keys(project.load(tmpRoot).sessions).length === 6 && !project.load(tmpRoot).sessions.A, Object.keys(project.load(tmpRoot).sessions).join(','));
  project.recordEdit(tmpRoot, 'EDITED', path.join(tmpRoot, 'keep.js'), false);
  for (let i = 0; i < 8; i++) project.startSession(tmpRoot, `EMPTY${i}`);
  check('project: sessions that edited nothing are evicted before one that did; the current session survives', project.load(tmpRoot).sessions.EDITED && project.load(tmpRoot).sessions.EMPTY7 && Object.keys(project.load(tmpRoot).sessions).length === 6 && /no Stop check ran; last known broken: keep\.js/.test(project.describe(project.load(tmpRoot), 'EMPTY7')) , Object.keys(project.load(tmpRoot).sessions).join(','));
  require('fs').writeFileSync(project.fileFor(tmpRoot), '{not json');
  check('project: a corrupt record is treated as empty, never thrown', project.load(tmpRoot).stats.sessions === 0 && project.startSession(tmpRoot, 'Q').stats.sessions === 1);

  // ---- security review round: one case per finding; the verdict is what the guard must return on every platform ----
  const fs = require('fs');
  const b64 = (s) => Buffer.from(s, 'utf16le').toString('base64');
  const sub = { ...ctx, cwd: path.join(FIX, 'src') };
  const SEC = [
    // 1. variables, substitutions and parameter forms are never "inside the project": ask (or deny when they name home/system)
    ['D=/; rm -rf $D', 'ask'], ['D=~; rm -rf "$D"', 'ask'], ['rm -rf $(echo ~)', 'ask'], ['rm -rf `echo ~`', 'ask'], ['rm -rf "$PWD"', 'ask'], ['rm -rf $PWD/*', 'ask'],
    ['rm -rf $HOME""', 'deny'], ['rm -rf ${HOME:-/}', 'ask'], ['rm -rf ~root', 'deny'], ['cd ${HOME} && rm -rf *', 'deny'], ['for d in ~ /; do rm -rf "$d"; done', 'ask'],
    ['Remove-Item -Recurse -Force $env:SystemRoot', 'deny'], ['Remove-Item -Recurse -Force $env:HOMEPATH', 'deny'], ['Remove-Item -Recurse -Force $env:APPDATA', 'deny'], ['Remove-Item -Recurse -Force $env:SystemDrive\\', 'deny'],
    ['rd /s /q %HOMEDRIVE%%HOMEPATH%', 'deny'], ['rd /s /q %SystemDrive%\\', 'deny'], ['Remove-Item -Recurse (Resolve-Path ~)', 'ask'],
    // 2. subshells and blocks: cd inside them is followed, and restored after
    ['(cd ~ && rm -rf *)', 'deny'], ['(cd .. && rm -rf *)', 'deny'], ['(cd src && ls) && rm -rf dist', null], ['{ cd ~ && rm -rf *; }', 'deny'],
    // 3. interpreters: the inner command is analyzed whether quoted, bare, $'…', wrapped in & { }, or base64-encoded
    ['powershell -Command Remove-Item -Recurse -Force ~', 'deny'], ['cmd /c rd /s /q C:\\Users', 'deny'], ['cmd /c rmdir /s /q %USERPROFILE%', 'deny'], ['bash -lc "rm -rf ~"', 'deny'], ["bash -c $'rm -rf ~'", 'deny'],
    ['powershell -Command "& { Remove-Item -Recurse -Force ~ }"', 'deny'], ['& { Remove-Item -Recurse -Force ~ }', 'deny'], ['eval rm -rf ~', 'deny'], ['bash -c "rm -rf \\"$HOME\\""', 'deny'],
    ['powershell -EncodedCommand ' + b64('Remove-Item -Recurse -Force ~'), 'deny'], ['pwsh -enc ' + b64('Remove-Item -Recurse -Force dist'), null], ['powershell -e notbase64!!', 'ask'],
    // 4. path-qualified, escaped or wrapped delete commands
    ['/bin/rm -rf /', 'deny'], ['/bin/rm -rf ~', 'deny'], ['\\rm -rf ~', 'deny'], ['env rm -rf ~', 'deny'], ['timeout 30 rm -rf ~', 'deny'], ['nice -n 10 rm -rf ~', 'deny'], ['doas rm -rf /', 'deny'],
    ['sudo -u root rm -rf /', 'deny'], ['sudo -E rm -rf ~', 'deny'], ['sudo -H rm -rf /home/user', 'deny'], ['find / -exec /bin/rm -rf {} +', 'deny'], ['find / -execdir rm -rf {} +', 'deny'], ['find ~ -execdir rm -rf {} +', 'deny'],
    ['echo ~ | xargs -n 1 rm -rf', 'deny'], ['echo ~ | xargs -I {} rm -rf {}', 'deny'], ["echo ~ | xargs -d '\\n' rm -rf", 'deny'], ['cat list.txt | xargs rm -rf', 'ask'], ['echo dist | xargs rm -rf', 'ask'],
    // 5. PowerShell pipelines that reach Remove-Item through ForEach-Object / Where-Object / Get-Item / a literal
    ['Get-ChildItem C:\\ -Recurse | ForEach-Object { Remove-Item $_.FullName -Recurse -Force }', 'deny'], ["Get-ChildItem ~ -Recurse | Where-Object Name -like '*' | Remove-Item -Recurse -Force", 'deny'],
    ['Get-Item ~ | Remove-Item -Recurse -Force', 'deny'], ['"$HOME" | Remove-Item -Recurse -Force', 'deny'], ['Get-ChildItem dist -Recurse | Remove-Item -Force', null], ['$x | Remove-Item -Recurse -Force', 'ask'],
    // 6. -Recurse:$true is recursion; a switch that merely contains an r is not
    ['Remove-Item C:\\ -Recurse:$true', 'deny'], ['Remove-Item -Recurse:$true -Path C:\\Users', 'deny'], ['Remove-Item ~ -Recurse:$true', 'deny'], ['Remove-Item -Force ~\\.npmrc', null],
    // 7. backslash-escaped quotes do not swallow the rest of the line
    ['echo "say \\"hi"; rm -rf ~', 'deny'], ["echo \\' ; rm -rf ~", 'deny'], ["echo it\\'s; rm -rf ~", 'deny'],
    // 8. cd forms: bare cd goes home, Push-Location / -Path are followed, an unresolvable cd makes later relative deletes ask
    ['cd && rm -rf *', 'deny', sub], ['Push-Location ~; Remove-Item -Recurse -Force *', 'deny', sub], ['Set-Location -Path ~; Remove-Item -Recurse -Force *', 'deny'], ['cd -Path ~; rm -r -fo *', 'deny'],
    ['cd $X && rm -rf *', 'ask'], ['cd - && rm -rf *', 'ask'], ['pushd && rm -rf *', 'ask'], ['cd src && rm -rf *', null],
    // 13. hard denies never fire on commit messages, grep patterns, comments or ordinary files under /dev/
    ['git commit -m "feat(mkfs): add mkfs wrapper"', null], ['grep -rn "(diskpart" docs/', null], ['git commit -m "fix: redirect output > /dev/sda1 handling"', null], ['diskutil list > /dev/disk_list.txt', null], ['chmod -R u+x bin/ # /', null],
    ['cat > /dev/sda', 'deny'], ['(mkfs.ext4 /dev/sdb1)', 'deny'],
    // 22. narrow gaps: recursive chmod/chown of system or home paths, more git spellings, del /s at the root, robocopy /MIR, interpreter one-liners
    ['chmod -R 000 ~', 'deny'], ['chmod -R 000 /*', 'deny'], ['chmod -R 777 /etc', 'deny'], ['chown -R nobody /usr', 'deny'], ['chmod -R 755 dist', null], ['chmod -R 700 ../other', 'ask'],
    ['git push -uf origin main', 'ask'], ['git reset -q --hard', 'ask'], ['git checkout -- :/', 'ask'], ['git restore :/', 'ask'], ['git checkout -- ./', 'ask'], ['git push origin --delete main', 'ask'], ['git push origin :master', 'ask'], ['git push origin --delete feature-x', null],
    ['del /s /q *.*', 'ask'], ['robocopy empty C:\\Users\\me /MIR', 'ask'], ['python -c "shutil.rmtree(\'/\')"', 'ask'], ['node -e "fs.rmSync(os.homedir(), {recursive:true})"', 'ask'], ['python -c "shutil.rmtree(\'build\')"', null],
    // 17. a shell redirect / truncate over a large existing file asks (like the Write guard); small or new files pass
    ['echo "<html></html>" > index.html', 'ask'], [': > index.html', 'ask'], ['truncate -s 0 index.html', 'ask'], ['cp /dev/null index.html', 'ask'], ['Set-Content -Path index.html -Value x', 'ask'],
    ['echo x > new-notes.txt', null], ['echo x >> index.html', null], ['cmd 2> index.html', null], ['Set-Content index.html -Value x -Append', null], ['cat index.html > /dev/null', null],
    // everyday commands stay silent
    ['rm -rf dist', null], ['rm -rf node_modules && npm i', null], ['ls -la | grep x', null], ['npm test', null], ['rm -rf dist 2>&1 | tee log', null], ['sleep 1 & rm -rf ~', 'deny'], ['find . -name "*.log" -delete', 'ask'],
  ];
  for (const [cmd, expected, c] of SEC) {
    const r = guard.evaluate(cmd, c || ctx);
    check(`security: ${JSON.stringify(cmd)} -> ${expected || 'silent'}`, (r ? r.decision : null) === expected, r ? `${r.decision}: ${r.why}` : 'null');
  }
  check('security: the Bash tool hint forces POSIX escapes, the PowerShell tool hint disables them', guard.evaluate("echo it\\'s; rm -rf ~", { ...ctx, shell: 'posix' }).decision === 'deny' && guard.tokens('Remove-Item C:\\my\\ dir', 'ps')[1] === 'C:\\my\\' && guard.tokens('rm -rf my\\ dir', 'posix')[2] === 'my dir');
  check('security: innerCommands also yields $(...) and `...` substitutions', JSON.stringify(guard.innerCommands('rm -rf $(cat list | head) && echo `whoami`')) === JSON.stringify(['cat list | head', 'whoami']), JSON.stringify(guard.innerCommands('rm -rf $(cat list | head) && echo `whoami`')));
  // 16. a symlink inside the project that points outside is judged by where it really points
  const outside = path.join(os.tmpdir(), `turbo-outside-${process.pid}`);
  const link = path.join(FIX, 'linkout');
  let linked = false;
  try { fs.mkdirSync(outside, { recursive: true }); fs.symlinkSync(outside, link, 'dir'); linked = true; } catch { /* no symlink privilege (Windows without developer mode) */ }
  if (linked) {
    check('security: rm -rf <symlink>/ pointing outside the project asks; a real in-project dir allows', guard.classifyTarget('linkout/', ctx) === 'ask' && guard.classifyTarget('linkout', ctx) === 'ask' && guard.classifyTarget('src', ctx) === 'allow', JSON.stringify([guard.classifyTarget('linkout/', ctx), guard.classifyTarget('src', ctx)]));
    check('realpathDeep: resolves the existing part of a path and keeps the rest', fsx.realpathDeep(path.join(link, 'nope', 'x.txt')) === path.join(fs.realpathSync.native(outside), 'nope', 'x.txt'), fsx.realpathDeep(path.join(link, 'nope', 'x.txt')));
    try { fs.unlinkSync(link); } catch { /* ignore */ }
  } else console.log('  skip symlink tests (cannot create symlinks here)');
  try { fs.rmSync(outside, { recursive: true, force: true }); } catch { /* ignore */ }
  // 14. a poisoned probes.json never becomes a command to run
  {
    const proc = path.join(PLUGIN, 'lib', 'proc');
    const dataDir = fsx.dataDir();
    const probeFile = path.join(dataDir, 'probes.json');
    const prev = fs.existsSync(probeFile) ? fs.readFileSync(probeFile, 'utf8') : null;
    fs.writeFileSync(probeFile, JSON.stringify({ ts: Date.now(), node: process.version, python: { cmd: path.join(dataDir, 'evil.sh'), pre: [] }, powershell: path.join(dataDir, 'evil.exe'), bash: '/tmp/evil' }));
    delete require.cache[require.resolve(proc)];
    const fresh = require(proc);
    const py = fresh.pythonCmd(), ps = fresh.powershellCmd(), sh = fresh.bashCmd();
    check('proc: cached probe commands outside the fixed candidate lists are ignored (re-probed), never spawned', (py === null || ['py', 'python', 'python3'].includes(py.cmd)) && (ps === null || ps === 'pwsh' || ps === 'powershell') && (sh === null || sh === 'bash' || (WIN && /bash\.exe$/i.test(sh))), JSON.stringify({ py, ps, sh }));
    if (prev != null) fs.writeFileSync(probeFile, prev); else { try { fs.unlinkSync(probeFile); } catch { /* ignore */ } }
    delete require.cache[require.resolve(proc)];
  }
  check('fsx: without CLAUDE_PLUGIN_DATA the data dir is a private per-user location, never a shared temp path', (() => { const saved = process.env.CLAUDE_PLUGIN_DATA; delete process.env.CLAUDE_PLUGIN_DATA; try { const d = fsx.dataDir(); return d !== path.join(os.tmpdir(), 'claude-turbo') && (d.startsWith(os.homedir()) || (process.env.XDG_CACHE_HOME && d.startsWith(process.env.XDG_CACHE_HOME)) || (process.env.LOCALAPPDATA && d.startsWith(process.env.LOCALAPPDATA)) || /claude-turbo-/.test(d)); } finally { if (saved !== undefined) process.env.CLAUDE_PLUGIN_DATA = saved; } })(), fsx.dataDir());
  // 15. the installer's user-scope allowlist holds read-only checks only, and requiring it installs nothing
  const installer = require(path.join(PLUGIN, '..', '..', 'install.js'));
  check('install: no test/build runner (npm test, npm run build, pytest) is allowed at user scope; node --check and py_compile are', !installer.ALLOW_RULES.some((r) => /npm (test|run)|pytest/.test(r)) && installer.ALLOW_RULES.some((r) => r === 'Bash(node --check *)') && installer.ALLOW_RULES.some((r) => r === 'PowerShell(python -m py_compile *)') && installer.PROJECT_HINT.length >= 4, installer.ALLOW_RULES.join(','));
  // 21. search regex filter and output cap
  const server = require(path.join(PLUGIN, 'mcp', 'server.js'));
  check('server: unsafeRegex rejects (a|aa)+$, (a?){30}a{30}, (a+)+ and [a-z]+* ; accepts ordinary patterns', server.unsafeRegex('(a|aa)+$') && server.unsafeRegex('(a?){30}a{30}') && server.unsafeRegex('(a+)+') && server.unsafeRegex('[a-z]+*') && !server.unsafeRegex('def \\w+\\(') && !server.unsafeRegex('(foo|bar)') && !server.unsafeRegex('^import .* from') && !server.unsafeRegex('\\bTODO\\b'));
  check('server: cap() clamps max_chars to 200,000 whatever the caller asks', server.cap('x'.repeat(300000), 1e9).length < 200500 && server.cap('x'.repeat(1000), 1e9).length === 1000);
  try { require('fs').unlinkSync(project.fileFor(tmpRoot)); } catch { /* ignore */ }

  // ---- user options (CLAUDE_PLUGIN_OPTION_<KEY>) ----
  const options = require(path.join(PLUGIN, 'lib', 'options'));
  const withEnv = (env, fn) => { const saved = {}; for (const k of Object.keys(env)) { saved[k] = process.env[k]; if (env[k] == null) delete process.env[k]; else process.env[k] = env[k]; } try { return fn(); } finally { for (const k of Object.keys(env)) { if (saved[k] == null) delete process.env[k]; else process.env[k] = saved[k]; } } };
  check('options: defaults when nothing is set', withEnv({ CLAUDE_PLUGIN_OPTION_BRIEF: null, CLAUDE_PLUGIN_OPTION_STOP_CHECK: null, CLAUDE_PLUGIN_OPTION_GUARD_LEVEL: null }, () => options.brief() === true && options.stopCheck() === true && options.guardLevel() === 'strict' && options.summary() === ''));
  check('options: boolean spellings false/0/off/no/disabled -> off, anything else -> on', ['false', '0', 'off', 'No', 'DISABLED', 'disable'].every((v) => withEnv({ CLAUDE_PLUGIN_OPTION_BRIEF: v }, () => options.brief() === false)) && ['true', '1', 'on', 'yes'].every((v) => withEnv({ CLAUDE_PLUGIN_OPTION_BRIEF: v }, () => options.brief() === true)));
  check('options: blank value means default', withEnv({ CLAUDE_PLUGIN_OPTION_STOP_CHECK: '   ' }, () => options.stopCheck() === true));
  check('options: guard_level normalizes case and underscores, rejects unknown values', withEnv({ CLAUDE_PLUGIN_OPTION_GUARD_LEVEL: 'Deny_Only' }, () => options.guardLevel() === 'deny-only') && withEnv({ CLAUDE_PLUGIN_OPTION_GUARD_LEVEL: 'lenient' }, () => options.guardLevel() === 'strict') && withEnv({ CLAUDE_PLUGIN_OPTION_GUARD_LEVEL: 'off' }, () => options.summary() === 'guards off'));
}

module.exports = { run };
