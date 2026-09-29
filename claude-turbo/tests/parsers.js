'use strict';
// Unit tests for the real parsers (js-ast / py-ast / ts-ast) and the checker integration.
// Called by run-tests.js with its check() function; needs no MCP server.

const fs = require('fs');
const path = require('path');
const os = require('os');

function tsResolvable(root) {
  try { require.resolve('typescript', { paths: [root, process.cwd()] }); return true; } catch { return false; }
}

function run(check, { PLUGIN, FIX, DATA }) {
  const jsAst = require(path.join(PLUGIN, 'lib', 'js-ast'));
  const pyAst = require(path.join(PLUGIN, 'lib', 'py-ast'));
  const tsAst = require(path.join(PLUGIN, 'lib', 'ts-ast'));
  const lang = require(path.join(PLUGIN, 'lib', 'lang'));
  const checkLib = require(path.join(PLUGIN, 'lib', 'check'));
  const byName = (r, n) => (r.symbols || []).find((s) => s.name === n);

  console.log('\n# Parsers (unit)');

  // ---- js-ast: exact start/end lines, signatures, modifiers ----
  const js = [
    'function outer(a, b = 1, ...rest) {',   // 1
    '  function inner() {}',                  // 2
    '  return a;',                            // 3
    '}',                                      // 4
    'class K extends Base {',                 // 5
    '  constructor(x) { this.x = x; }',       // 6
    '  static async make() {',                // 7
    '    return new K(1);',                   // 8
    '  }',                                    // 9
    '  *gen() { yield 1; }',                  // 10
    '  get v() { return 1; }',                // 11
    '}',                                      // 12
    'const O = {',                            // 13
    '  go: async (p) => p,',                  // 14
    '  nested: { deep() { return 2; } },',    // 15
    '};',                                     // 16
    'const BIG = [',                          // 17
    '  { id: 1, q: "a" },',                   // 18
    '];',                                     // 19
    'K.prototype.reset = function () {};',    // 20
    'window.boot = () => {};',                // 21
    'document.addEventListener("load", () => {});', // 22
    '(async function main() {',               // 23
    '  await 1;',                             // 24
    '})();',                                  // 25
  ].join('\n');
  const o = jsAst.outlineJS(js, { module: false });
  check('js-ast: parses as a script with exact symbol count', o.parser === 'acorn' && o.sourceType === 'script' && o.symbols.length === 15, JSON.stringify(o.symbols && o.symbols.map((s) => s.name)));
  const outer = byName(o, 'outer');
  check('js-ast: function has exact start/end lines and a bare param signature', outer && outer.line === 1 && outer.endLine === 4 && outer.sig === 'a, b = …, ...rest' && !outer.mods, JSON.stringify(outer));
  check('js-ast: nested function is attributed to its parent', byName(o, 'outer/inner') && byName(o, 'outer/inner').line === 2, JSON.stringify(o.symbols.map((s) => s.name)));
  const k = byName(o, 'K');
  check('js-ast: class spans its whole body and records the superclass', k && k.line === 5 && k.endLine === 12 && k.sig === 'extends Base', JSON.stringify(k));
  const make = byName(o, 'K.make');
  check('js-ast: static async method -> mods "static async", exact range', make && make.kind === 'method' && make.mods === 'static async' && make.line === 7 && make.endLine === 9 && make.sig === '', JSON.stringify(make));
  check('js-ast: generator, getter and constructor kinds', byName(o, 'K.gen').mods === '*' && byName(o, 'K.v').kind === 'getter' && byName(o, 'K.constructor').kind === 'constructor' && byName(o, 'K.constructor').sig === 'x', JSON.stringify(o.symbols.filter((s) => s.name.startsWith('K.'))));
  check('js-ast: object methods incl. one nested level, async arrow mods', byName(o, 'O.go') && byName(o, 'O.go').mods === 'async' && byName(o, 'O.go').sig === 'p' && byName(o, 'O.nested.deep'), JSON.stringify(o.symbols.filter((s) => s.name.startsWith('O'))));
  check('js-ast: data array with element keys and exact range', byName(o, 'BIG') && byName(o, 'BIG').kind === 'array' && byName(o, 'BIG').endLine === 19 && /keys: id,q/.test(byName(o, 'BIG').sig), JSON.stringify(byName(o, 'BIG')));
  check('js-ast: prototype method, global function, boot listener, named iife', byName(o, 'K.reset') && byName(o, 'K.reset').kind === 'method' && byName(o, 'boot') && byName(o, 'boot').mods === 'global' && byName(o, 'on load') && byName(o, '(iife main)') && byName(o, '(iife main)').endLine === 25 && byName(o, '(iife main)').mods === 'async', JSON.stringify(o.symbols.slice(-4)));

  // ---- js-ast: module / script detection ----
  const esm = jsAst.outlineJS('import a from "a";\nexport const x = 1;\nexport default function f() {}\nexport class C {}\nexport default () => 1;\n'.replace('export default () => 1;\n', ''));
  check('js-ast: import/export text is detected as a module and exports are flagged', esm.sourceType === 'module' && esm.imports === 1 && byName(esm, 'f') && byName(esm, 'f').exported && byName(esm, 'C').exported && byName(esm, 'f').kind === 'function', JSON.stringify(esm));
  const anonDefault = jsAst.outlineJS('export default async () => 1;\nexport default_ = 2;\n'.split('\n')[0]);
  check('js-ast: anonymous default export is listed as "default" with its mods', byName(anonDefault, 'default') && byName(anonDefault, 'default').exported && byName(anonDefault, 'default').mods === 'async', JSON.stringify(anonDefault));
  const cjs = jsAst.outlineJS('const a = require("a");\nmodule.exports = { a, b() {} };\n');
  check('js-ast: require/module.exports text is a script; exports object and its methods are listed', cjs.sourceType === 'script' && cjs.imports === 1 && byName(cjs, 'module.exports') && byName(cjs, 'exports.b'), JSON.stringify(cjs));
  const tla = jsAst.checkJS('const v = await fetch("x");\nexport { v };\n');
  check('js-ast: top-level await parses only as a module', tla.ok && tla.sourceType === 'module', JSON.stringify(tla));
  const strictCjs = jsAst.checkJS('import x from "y";', { module: false });
  check('js-ast: module:false is strict (import in a script is an error with line/col)', !strictCjs.ok && strictCjs.error.line === 1 && strictCjs.error.col === 1, JSON.stringify(strictCjs));
  const strictMjs = jsAst.checkJS('return 1;', { module: true });
  check('js-ast: module:true is strict (top-level return is an error)', !strictMjs.ok && /return/i.test(strictMjs.error.message), JSON.stringify(strictMjs));
  const broken = jsAst.checkJS('function f() {\n  return [1, 2;\n}\n');
  check('js-ast: syntax error carries 1-based line and column', !broken.ok && broken.error.line === 2 && broken.error.col === 15 && /^SyntaxError: /.test(broken.error.message), JSON.stringify(broken));
  check('js-ast: hashbang and JSON-ish data parse', jsAst.checkJS('#!/usr/bin/env node\nconsole.log(1)\n').ok && jsAst.outlineJS('const D = {"a": [1,2,3]};').symbols.length === 1);

  // ---- lang.outline routing: .mjs / .cjs / .js / html inline ----
  check('outline: .mjs is parsed as a module, .cjs as a script', lang.outline('export const a = 1;', 'x.mjs').sourceType === 'module' && lang.outline('exports.a = 1;', 'x.cjs').sourceType === 'script');
  const htmlO = lang.outline('<html><body><script>\nfunction a() {\n  return 1;\n}\n</script><script type="module">\nexport const b = 2;\nconst c = 3;\n</script></body></html>', 'p.html');
  check('outline: html inline scripts get exact ranges offset to html lines; module script honoured', htmlO.parser === 'acorn' && byName(htmlO, 'a').line === 2 && byName(htmlO, 'a').endLine === 4 && byName(htmlO, 'b') && byName(htmlO, 'b').exported && byName(htmlO, 'b').line === 6 && !byName(htmlO, 'c'), JSON.stringify(htmlO.symbols));
  const fallback = lang.outline('function a( {\n', 'x.js');
  check('outline: unparsable JS falls back to heuristics and reports the parse error', fallback.parser === 'heuristic' && fallback.parseError && fallback.parseError.line >= 1 && /SyntaxError/.test(fallback.parseError.message), JSON.stringify(fallback));

  // ---- checker integration: JSX skip, strict cjs, temp-file confirm path ----
  const jsxRes = checkLib.checkFile(path.join(FIX, 'src', 'widget.js'));
  check('check: JSX in a .js file is skipped with an explanation, never reported as an error', jsxRes.ok && /JSX/.test(jsxRes.skipped || ''), JSON.stringify(jsxRes));
  const cjsRes = checkLib.checkFile(path.join(FIX, 'broken', 'esm-in.cjs'));
  check('check: import inside .cjs is reported (no silent auto-detect to module)', !cjsRes.ok && cjsRes.errors[0].line === 1, JSON.stringify(cjsRes));
  const tlaRes = checkLib.checkFile(path.join(FIX, 'src', 'tla.mjs'));
  check('check: top-level await in .mjs passes', tlaRes.ok && tlaRes.checker === 'acorn', JSON.stringify(tlaRes));
  const htmlBad = checkLib.checkHTML('<script>\nimport x from "y";\n</script>', 'p.html');
  check('check: import inside a classic <script> is an error mapped to the html line', !htmlBad.ok && htmlBad.errors[0].line === 2, JSON.stringify(htmlBad));
  const htmlMod = checkLib.checkHTML('<script type="module">\nimport x from "./y.js";\n</script>', 'p.html');
  check('check: import inside <script type=module> is fine', htmlMod.ok, JSON.stringify(htmlMod));
  check('check: a "<style" inside a JS string does not count as a tag', checkLib.checkHTML('<script>if (s.startsWith("<style")) x();</script>', 'p.html').ok);
  const commented = checkLib.checkHTML('<!-- <script>function broken( {</script> -->\n<script>ok();</script>', 'p.html');
  check('check: a commented-out <script> is neither checked nor paired with the real closer', commented.ok && /1 inline script/.test(commented.checker), JSON.stringify(commented));
  check('check: a commented-out <script src> does not hide the real inline script', !checkLib.checkHTML('<!-- <script src="old.js"> -->\n<script>function broken( {</script>', 'p.html').ok);
  check('check: data-src is not src: the inline script is still checked', !checkLib.checkHTML('<script data-src="lazy.js">function f( {</script>', 'p.html').ok);
  check('check: top-level return in a classic <script> is an error; in .cjs it is fine', !checkLib.checkHTML('<script>\nreturn 1;\n</script>', 'p.html').ok && checkLib.checkJSSource('return 1;', { module: false }).ok);
  const idO = lang.outline('<!-- <div id="ghost"></div> -->\n<div data-id="5" id="real"></div>', 'p.html');
  check('outline: data-id is not an id and commented-out ids are skipped', idO.symbols.some((s) => s.name === '#real') && !idO.symbols.some((s) => s.name === '#5' || s.name === '#ghost'), JSON.stringify(idO.symbols));
  const ls = jsAst.outlineJS('const s = "a\u2028b";\nfunction f() {}');
  check('js-ast: U+2028 inside a string does not shift line numbers (matches Read/read_range)', byName(ls, 'f') && byName(ls, 'f').line === 2, JSON.stringify(ls.symbols));

  // ---- py-ast: exact outline via the interpreter's ast module ----
  if (!pyAst.available()) console.log('  skip python 3 not found: py-ast exact outline tests');
  else {
    const svc = pyAst.outlineFile(path.join(FIX, 'tools', 'svc.py'));
    const sy = (n) => (svc.symbols || []).find((s) => s.name === n);
    check('py-ast: class range and methods with bare signatures', svc && sy('Service') && sy('Service').line === 4 && sy('Service').endLine === 17 && sy('Service.fetch') && sy('Service.fetch').sig === 'self, url, retries', JSON.stringify(svc));
    check('py-ast: async and decorators land in mods', sy('Service.fetch').mods === 'async' && sy('Service.build').mods === '@staticmethod' && sy('run').mods === 'async' && sy('run').kind === 'function', JSON.stringify(svc && svc.symbols));
    check('py-ast: nested class methods are qualified', sy('Service.Inner') && sy('Service.Inner.ping') && sy('Service.Inner.ping').line === 16, JSON.stringify(svc && svc.symbols.map((s) => s.name)));
    check('py-ast: imports counted, kwonly args kept', svc.imports === 1 && sy('Service.fetch').endLine === 13, JSON.stringify(svc));
    const badPy = pyAst.outlineFile(path.join(FIX, 'broken', 'bad.py'));
    check('py-ast: syntax error returns {error:{line,col,message}} instead of symbols', badPy && badPy.error && badPy.error.line === 1 && /SyntaxError/.test(badPy.error.message), JSON.stringify(badPy));
    const t0 = Date.now();
    const batch = pyAst.outlineBatch([path.join(FIX, 'tools', 'gen.py'), path.join(FIX, 'tools', 'svc.py'), path.join(FIX, 'nope.py')]);
    check('py-ast: batch outlines several files in one run and skips missing ones', batch.size === 2 && batch.get(path.join(FIX, 'tools', 'gen.py')).symbols.length === 7, `${batch.size} in ${Date.now() - t0}ms`);
    const t1 = Date.now(); pyAst.outlineFile(path.join(FIX, 'tools', 'gen.py'));
    check('py-ast: cached by mtime (second outline needs no interpreter run, <20ms)', Date.now() - t1 < 20, String(Date.now() - t1));
  }

  // ---- ts-ast: exact outline when the project's typescript is resolvable ----
  if (!tsResolvable(FIX)) console.log('  skip typescript not resolvable (npm i typescript or set NODE_PATH): ts-ast exact outline tests');
  else {
    const src = fs.readFileSync(path.join(FIX, 'src', 'types.ts'), 'utf8');
    const t = tsAst.outlineTS(src, path.join(FIX, 'src', 'types.ts'), { root: FIX });
    const ts = (n) => (t.symbols || []).find((s) => s.name === n);
    check('ts-ast: parser typescript, interface/type/enum exported with member counts', t && t.parser === 'typescript' && ts('Question').exported && ts('Question').sig === '3 members' && ts('Theme').kind === 'enum' && ts('Mode').kind === 'type', JSON.stringify(t));
    check('ts-ast: function signature is bare params, return type in mods', ts('score').sig === 'q, pick' && ts('score').mods === '-> number' && ts('score').exported, JSON.stringify(ts('score')));
    check('ts-ast: class constructor and method are listed with exact lines', ts('Bank.constructor') && ts('Bank.constructor').sig === 'items' && ts('Bank.size') && ts('Bank.size').mods === '-> number' && ts('Bank.size').line === 5, JSON.stringify(t.symbols));
    const tsRes = checkLib.checkFile(path.join(FIX, 'src', 'types.ts'), { root: FIX });
    check('check: typescript syntax check passes on the fixture', tsRes.ok && /typescript/.test(tsRes.checker), JSON.stringify(tsRes));
    const tmp = path.join(DATA, 'bad.ts');
    fs.writeFileSync(tmp, 'export function f(a: number): number {\n  return a +;\n}\n');
    const tsBad = checkLib.checkFile(tmp, { root: FIX });
    check('check: typescript syntax error has line and TS code', !tsBad.ok && tsBad.errors[0].line === 2 && /^TS\d+/.test(tsBad.errors[0].message), JSON.stringify(tsBad));
  }

  // ---- heuristics still cover languages without a parser ----
  const goO = lang.outline('package main\n\nfunc (s *Store) Save(k string) error {\n\treturn nil\n}\n\nfunc main() {}\n', 'main.go');
  check('heuristic outline: go methods and functions', byName(goO, 'Store.Save') && byName(goO, 'main') && !goO.parser, JSON.stringify(goO));
  const endGo = lang.symbolEnd(['func a() {', '  if x {', '  }', '}', 'func b() {}'], 1, 'go');
  check('symbolEnd: bracket matching for brace languages', endGo === 4, String(endGo));
  const endPy = lang.symbolEnd(['def a():', '    x = 1', '', '    return x', 'def b():'], 1, 'python');
  check('symbolEnd: indentation for python', endPy === 4, String(endPy));
  void os;
}

module.exports = { run, tsResolvable };
