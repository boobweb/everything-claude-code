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
  check('classifyTarget: explicit temp path -> allow, temp root -> ask', guard.classifyTarget(path.join(os.tmpdir(), 'scratch-abc'), ctx) === 'allow' && guard.classifyTarget(os.tmpdir(), ctx) !== 'allow', JSON.stringify([guard.classifyTarget(path.join(os.tmpdir(), 'scratch-abc'), ctx), guard.classifyTarget(os.tmpdir(), ctx)]));
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
}

module.exports = { run };
