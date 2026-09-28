'use strict';
// Fast syntax / integrity checks per file type. Used by the PostToolUse hook, the Stop
// hook and the MCP `syntax_check` tool. Every checker is bounded by a timeout and never
// throws: the result always has { ok, checker, errors: [{line, col, message}] }.

const fs = require('fs');
const path = require('path');
const { scriptBlocks, stripJsonComments } = require('./lang');
const fsx = require('./fsx');

const MAX_CHECK_BYTES = 64 * 1024 * 1024; // above this we skip (would be too slow)
const { run, pythonCmd, powershellCmd, bashCmd, NODE } = require('./proc');

// ---------- JavaScript via `node --check` ----------
function parseNodeCheck(stderr, filePath) {
  // Format:
  //   <path>:<line>\n<code>\n<caret>\n\nSyntaxError: <message>\n    at ...
  const lines = stderr.split(/\r?\n/);
  let line = null, col = null, message = null;
  const first = lines.findIndex((l) => l.startsWith(filePath) || /:\d+$/.test(l));
  if (first >= 0) {
    const m = /:(\d+)\s*$/.exec(lines[first]);
    if (m) line = Number(m[1]);
    const caret = lines[first + 2] || '';
    const ci = caret.indexOf('^');
    if (ci >= 0) col = ci + 1;
  }
  const em = /^(\w*Error): (.*)$/m.exec(stderr);
  if (em) message = `${em[1]}: ${em[2]}`;
  if (!message) message = stderr.split(/\r?\n/).filter(Boolean).slice(0, 3).join(' | ') || 'syntax error';
  return { line, col, message };
}

let jsAst = null;
try { jsAst = require('./js-ast'); } catch { jsAst = null; }

const JSX_LIKE = /<[A-Z][A-Za-z0-9]*[\s/>]|<\/[a-z][a-z0-9-]*>\s*[);,]|^\s*\/\/\s*@flow\b|^\s*\/\*\s*@flow\b/m;

/** node --check on a file path (spawned). */
function nodeCheckFile(file, timeout = 20000) {
  const r = run(NODE, ['--check', file], { timeout });
  if (r.timedOut) return { ok: true, skipped: 'timeout' };
  if (r.error) return { ok: true, skipped: `could not run node: ${r.error.message}` };
  if (r.status === 0) return { ok: true };
  return { ok: false, error: parseNodeCheck(r.stderr, file) };
}

/**
 * node --check on text, written to a temp file with an explicit module kind (.cjs or .mjs).
 * Never .js: with module auto-detection (Node 22+) `node --check some.js` exits 0 for files it
 * classifies as ESM even when they contain syntax errors or JSX, so a .js check proves nothing.
 */
function nodeCheckText(text, kind, timeout) {
  const dir = fsx.tmpDir();
  const tmp = path.join(dir, `chk-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.${kind === 'module' ? 'mjs' : 'cjs'}`);
  try { fs.writeFileSync(tmp, text); return nodeCheckFile(tmp, timeout); }
  finally { try { fs.unlinkSync(tmp); } catch { /* ignore */ } }
}

/** Ask node whether the text parses in any of the allowed module kinds. Returns 'ok' | 'fail' | 'skipped'. */
function nodeConfirm(text, module, timeout) {
  const kinds = module === true ? ['module'] : module === false ? ['script'] : ['script', 'module'];
  let verdict = 'fail';
  for (const k of kinds) {
    const r = nodeCheckText(text, k, timeout);
    if (r.skipped) return 'skipped';
    if (r.ok) return 'ok';
  }
  return verdict;
}

/**
 * Check JavaScript source. Fast path: acorn in-process (no spawn, exact line/col). If acorn
 * rejects the code, node confirms in strict .cjs/.mjs form (acorn may trail brand-new syntax);
 * JSX/Flow-looking files are skipped instead of reported, since neither parser can judge them.
 * module: true (.mjs / <script type=module>), false (.cjs / classic <script>), undefined (.js: either).
 */
function checkJSSource(text, { module, label, timeout } = {}) {
  if (jsAst) {
    const a = jsAst.checkJS(text, { module });
    if (a.ok) return { ok: true, checker: 'acorn', errors: [] };
    const confirm = nodeConfirm(text, module, timeout);
    if (confirm === 'ok') return { ok: true, checker: 'node --check (acorn disagreed)', errors: [] };
    if (JSX_LIKE.test(text)) return { ok: true, checker: 'acorn', skipped: 'looks like JSX or Flow, which plain JavaScript parsers cannot check', errors: [] };
    return { ok: false, checker: 'acorn', errors: [{ ...a.error, label }] };
  }
  const confirm = nodeConfirm(text, module, timeout);
  if (confirm === 'skipped') return { ok: true, checker: 'node --check', skipped: 'could not run node --check', errors: [] };
  if (confirm === 'ok') return { ok: true, checker: 'node --check', errors: [] };
  if (JSX_LIKE.test(text)) return { ok: true, checker: 'node --check', skipped: 'looks like JSX or Flow, which plain JavaScript parsers cannot check', errors: [] };
  const r = nodeCheckText(text, module === true ? 'module' : 'script', timeout);
  return { ok: false, checker: 'node --check', errors: [{ ...(r.error || { line: null, col: null, message: 'syntax error' }), label }] };
}

function checkJSText(text, { module = false, label = 'inline script', timeout } = {}) {
  return checkJSSource(text, { module, label, timeout });
}

function checkJSFile(file, timeout) {
  const text = fs.readFileSync(file, 'utf8');
  const module = /\.mjs$/i.test(file) ? true : /\.cjs$/i.test(file) ? false : undefined;
  return checkJSSource(text, { module, timeout });
}

// ---------- JSON (with precise error location) ----------
function jsonErrorLocation(text) {
  // Minimal recursive-descent validator that reports the first error position.
  let i = 0;
  const n = text.length;
  const fail = (msg) => { const e = new Error(msg); e.pos = i; throw e; };
  const ws = () => { while (i < n && (text[i] === ' ' || text[i] === '\n' || text[i] === '\r' || text[i] === '\t')) i++; };
  const value = () => {
    ws();
    if (i >= n) fail('Unexpected end of JSON input');
    const c = text[i];
    if (c === '{') {
      i++; ws();
      if (text[i] === '}') { i++; return; }
      for (;;) {
        ws();
        if (text[i] !== '"') fail(text[i] === '}' ? 'Trailing comma before }' : `Expected property name in double quotes, got '${text[i]}'`);
        str(); ws();
        if (text[i] !== ':') fail(`Expected ':' after property name, got '${text[i]}'`);
        i++; value(); ws();
        if (text[i] === ',') { i++; continue; }
        if (text[i] === '}') { i++; return; }
        fail(`Expected ',' or '}' after property value, got '${text[i] === undefined ? 'end of input' : text[i]}'`);
      }
    }
    if (c === '[') {
      i++; ws();
      if (text[i] === ']') { i++; return; }
      for (;;) {
        ws();
        if (text[i] === ']') fail('Trailing comma before ]');
        value(); ws();
        if (text[i] === ',') { i++; continue; }
        if (text[i] === ']') { i++; return; }
        fail(`Expected ',' or ']' after array element, got '${text[i] === undefined ? 'end of input' : text[i]}'`);
      }
    }
    if (c === '"') return str();
    if (c === 't') { if (text.startsWith('true', i)) { i += 4; return; } fail('Invalid literal'); }
    if (c === 'f') { if (text.startsWith('false', i)) { i += 5; return; } fail('Invalid literal'); }
    if (c === 'n') { if (text.startsWith('null', i)) { i += 4; return; } fail('Invalid literal'); }
    if (c === '-' || (c >= '0' && c <= '9')) {
      const m = /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?/.exec(text.slice(i, i + 64));
      if (!m) fail('Invalid number');
      i += m[0].length; return;
    }
    if (c === "'") fail("Single quotes are not valid JSON (use double quotes)");
    fail(`Unexpected token '${c}'`);
  };
  const str = () => {
    i++; // opening quote
    for (;;) {
      if (i >= n) fail('Unterminated string');
      const c = text[i];
      if (c === '"') { i++; return; }
      if (c === '\\') { i += 2; continue; }
      if (c === '\n') fail('Unterminated string (newline inside string)');
      i++;
    }
  };
  try {
    value(); ws();
    if (i < n) fail(`Unexpected content after JSON value: '${text[i]}'`);
    return null;
  } catch (e) {
    const pos = Math.min(e.pos || 0, n);
    const before = text.slice(0, pos);
    const line = (before.match(/\n/g) || []).length + 1;
    const col = pos - before.lastIndexOf('\n');
    return { line, col, message: e.message };
  }
}

function checkJSON(text, file) {
  text = text.replace(/^\uFEFF/, ''); // a UTF-8 BOM is common on Windows and is not an error
  try { JSON.parse(text); return { ok: true, checker: 'JSON.parse', errors: [] }; } catch { /* fallthrough */ }
  // JSON with comments / trailing commas is common for config files (tsconfig, .vscode, settings.json)
  const base = path.basename(file).toLowerCase();
  const lenientOk = /(^|\.)(jsonc|json5)$|tsconfig|jsconfig|settings\.json|launch\.json|tasks\.json|\.vscode|devcontainer/.test(base) || /\.vscode/.test(file);
  if (lenientOk) {
    try { JSON.parse(stripJsonComments(text)); return { ok: true, checker: 'JSON (comments allowed)', errors: [] }; } catch { /* report below */ }
  }
  const loc = text.length < 8 * 1024 * 1024 ? jsonErrorLocation(text) : null;
  return { ok: false, checker: 'JSON.parse', errors: [loc || { line: null, col: null, message: 'invalid JSON' }] };
}

// ---------- Python via ast.parse ----------
function checkPython(file, timeout = 20000) {
  const py = pythonCmd();
  if (!py) return { ok: true, checker: 'python ast', skipped: 'python 3 not found', errors: [] };
  const code = 'import ast,sys\nsrc=open(sys.argv[1],"rb").read()\ntry:\n    ast.parse(src, sys.argv[1])\nexcept SyntaxError as e:\n    print("SYNTAX\\t%s\\t%s\\t%s" % (e.lineno or 0, e.offset or 0, e.msg))\n    sys.exit(3)\n';
  const r = run(py.cmd, [...py.pre, '-c', code, file], { timeout });
  if (r.timedOut) return { ok: true, checker: 'python ast', skipped: 'timeout', errors: [] };
  if (r.error) return { ok: true, checker: 'python ast', skipped: r.error.message, errors: [] };
  if (r.status === 0) return { ok: true, checker: 'python ast', errors: [] };
  const m = /^SYNTAX\t(\d+)\t(\d+)\t(.*?)\r?$/m.exec(r.stdout);
  if (m) return { ok: false, checker: 'python ast', errors: [{ line: Number(m[1]) || null, col: Number(m[2]) || null, message: `SyntaxError: ${m[3].trim()}` }] };
  return { ok: true, checker: 'python ast', skipped: `unexpected python exit ${r.status}: ${(r.stderr || '').split('\n').slice(-2).join(' ')}`, errors: [] };
}

// ---------- CSS: structural balance ----------
function checkCSS(text) {
  let depth = 0, line = 1, inStr = null, inComment = false, lastOpenLine = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '\n') { line++; continue; }
    if (inComment) { if (c === '*' && text[i + 1] === '/') { inComment = false; i++; } continue; }
    if (inStr) { if (c === '\\') { i++; continue; } if (c === inStr) inStr = null; continue; }
    if (c === '/' && text[i + 1] === '*') { inComment = true; i++; continue; }
    if (c === '"' || c === "'") { inStr = c; continue; }
    if (c === '{') { depth++; lastOpenLine = line; }
    else if (c === '}') { depth--; if (depth < 0) return { ok: false, checker: 'css balance', errors: [{ line, col: null, message: "Unexpected '}' (no matching '{')" }] }; }
  }
  if (inComment) return { ok: false, checker: 'css balance', errors: [{ line, col: null, message: 'Unterminated /* comment */' }] };
  if (depth > 0) return { ok: false, checker: 'css balance', errors: [{ line: lastOpenLine, col: null, message: `${depth} unclosed '{' (block opened here is never closed)` }] };
  return { ok: true, checker: 'css balance', errors: [] };
}

// ---------- HTML: check every inline script, report with HTML line numbers ----------
function checkHTML(text, file, timeout) {
  const all = scriptBlocks(text);
  const blocks = all.filter((b) => b.isJS && b.content.trim());
  const errors = [];
  let checked = 0;
  const checkers = new Set();
  const componentFile = /\.(vue|svelte|astro)$/i.test(file); // component scripts use import/export
  for (const b of blocks) {
    // Guard: `</script>` inside a JS string would have split the block early; we still check what we have.
    // Classic <script> is parsed as a script (undefined lets .js files auto-detect; here the tag decides).
    const r = checkJSText(b.content, { module: b.isModule || componentFile ? true : false, label: `<script #${b.index}>`, timeout });
    checked++;
    checkers.add(r.checker);
    if (!r.ok) {
      for (const e of r.errors) {
        const line = e.line != null ? b.contentStartLine + e.line - 1 : b.startLine;
        errors.push({ line, col: e.col, message: `${e.message} (in <script #${b.index}>, script line ${e.line})` });
      }
    }
  }
  // Cheap structural sanity: unclosed <script>/<style> tags, counting only tags outside script content
  // (a JS string such as "<script src=x><\/script>" must not count)
  const insideScript = (idx) => all.some((b) => idx >= b.contentStart && idx < b.contentEnd);
  let opens = 0, closes = 0, mm;
  const openRe = /<script\b/gi, closeRe = /<\/script\s*>/gi;
  while ((mm = openRe.exec(text))) if (!insideScript(mm.index)) opens++;
  while ((mm = closeRe.exec(text))) if (!insideScript(mm.index)) closes++;
  if (opens !== closes) errors.push({ line: null, col: null, message: `Unbalanced <script> tags: ${opens} opening, ${closes} closing` });
  const so = (text.match(/<style\b/gi) || []).length, sc = (text.match(/<\/style\s*>/gi) || []).length;
  if (so !== sc) errors.push({ line: null, col: null, message: `Unbalanced <style> tags: ${so} opening, ${sc} closing` });
  return { ok: errors.length === 0, checker: `html (${checked} inline script${checked === 1 ? '' : 's'}${checkers.size ? ` via ${[...checkers].join(', ')}` : ''})`, errors };
}

// ---------- PowerShell via the real parser ----------
function checkPowerShell(file, timeout = 15000) {
  const ps = powershellCmd();
  if (!ps) return { ok: true, checker: 'powershell parser', skipped: 'no PowerShell found', errors: [] };
  // The path is embedded as a single-quoted PowerShell literal (quotes doubled): with -Command,
  // trailing arguments are appended to the command text rather than bound to $args.
  const lit = `'${String(file).replace(/'/g, "''")}'`;
  const script = `$p=${lit};$t=$null;$e=$null;[System.Management.Automation.Language.Parser]::ParseFile($p,[ref]$t,[ref]$e)|Out-Null;if($e){foreach($x in $e){Write-Output ("PSERR\`t"+$x.Extent.StartLineNumber+"\`t"+$x.Extent.StartColumnNumber+"\`t"+$x.Message)};exit 3}`;
  const r = run(ps, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { timeout });
  if (r.timedOut) return { ok: true, checker: 'powershell parser', skipped: 'timeout', errors: [] };
  if (r.error) return { ok: true, checker: 'powershell parser', skipped: r.error.message, errors: [] };
  const errs = [];
  for (const l of r.stdout.split(/\r?\n/)) {
    const m = /^PSERR\t(\d+)\t(\d+)\t(.*)$/.exec(l);
    if (m) errs.push({ line: Number(m[1]), col: Number(m[2]), message: m[3] });
  }
  if (errs.length) return { ok: false, checker: 'powershell parser', errors: errs.slice(0, 10) };
  return { ok: true, checker: 'powershell parser', errors: [] };
}

// ---------- Shell via bash -n ----------
function checkShell(file, timeout = 10000) {
  const bash = bashCmd();
  if (!bash) return { ok: true, checker: 'bash -n', skipped: process.platform === 'win32' ? 'no Git Bash found (WSL bash cannot read Windows paths)' : 'bash not available', errors: [] };
  const r = run(bash, ['-n', file], { timeout });
  if (r.error || r.timedOut) return { ok: true, checker: 'bash -n', skipped: 'bash not available', errors: [] };
  if (r.status === 0) return { ok: true, checker: 'bash -n', errors: [] };
  const m = /line (\d+): (.*?)\r?$/m.exec(r.stderr);
  return { ok: false, checker: 'bash -n', errors: [{ line: m ? Number(m[1]) : null, col: null, message: (m ? m[2] : r.stderr.trim().split(/\r?\n/)[0]).trim() }] };
}

// ---------- TypeScript via the project's own `typescript` package (syntax diagnostics only) ----------
function checkTypeScript(file, text, root) {
  let ts;
  try {
    const resolved = require.resolve('typescript', { paths: [root || path.dirname(file), process.cwd()] });
    ts = require(resolved);
  } catch { return { ok: true, checker: 'typescript', skipped: 'typescript package not installed in project', errors: [] }; }
  try {
    const isTsx = /\.tsx$/i.test(file);
    const compilerOptions = { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext };
    if (isTsx) compilerOptions.jsx = ts.JsxEmit.Preserve;
    const out = ts.transpileModule(text, { reportDiagnostics: true, fileName: file, compilerOptions });
    const diags = (out.diagnostics || []).filter((d) => d.category === ts.DiagnosticCategory.Error);
    if (!diags.length) return { ok: true, checker: 'typescript (syntax)', errors: [] };
    const errors = diags.slice(0, 10).map((d) => {
      let line = null, col = null;
      if (d.file && d.start != null) { const p = d.file.getLineAndCharacterOfPosition(d.start); line = p.line + 1; col = p.character + 1; }
      return { line, col, message: `TS${d.code}: ${ts.flattenDiagnosticMessageText(d.messageText, ' ')}` };
    });
    return { ok: false, checker: 'typescript (syntax)', errors };
  } catch (e) {
    return { ok: true, checker: 'typescript', skipped: `typescript failed: ${e.message}`, errors: [] };
  }
}

// ---------- YAML: cheap structural checks (tabs, unbalanced quotes are the common breakages) ----------
function checkYAML(text) {
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (/^\t+(?:- |[\w"'][^:\n]*:\s)/.test(l)) return { ok: false, checker: 'yaml (basic)', errors: [{ line: i + 1, col: 1, message: 'Tab used for indentation (YAML requires spaces)' }] };
  }
  return { ok: true, checker: 'yaml (basic: tabs only)', errors: [] };
}

// ---------- XML / SVG: tag balance ----------
function checkXML(text) {
  const stack = [];
  const re = /<(\/)?([A-Za-z_][\w:.-]*)\b[^>]*?(\/)?>|<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>/g;
  let m;
  const lineAt = (idx) => (text.slice(0, idx).match(/\n/g) || []).length + 1;
  while ((m = re.exec(text))) {
    if (!m[2]) continue;
    if (m[3]) continue;
    if (m[1]) {
      const open = stack.pop();
      if (!open || open.name !== m[2]) return { ok: false, checker: 'xml balance', errors: [{ line: lineAt(m.index), col: null, message: `Closing </${m[2]}> does not match open <${open ? open.name : 'nothing'}>` }] };
    } else stack.push({ name: m[2], idx: m.index });
  }
  if (stack.length) return { ok: false, checker: 'xml balance', errors: [{ line: lineAt(stack[stack.length - 1].idx), col: null, message: `<${stack[stack.length - 1].name}> is never closed` }] };
  return { ok: true, checker: 'xml balance', errors: [] };
}

const CHECKABLE_EXT = new Set(['.js', '.mjs', '.cjs', '.json', '.jsonc', '.py', '.pyw', '.html', '.htm', '.xhtml', '.css', '.ps1', '.psm1', '.psd1', '.sh', '.bash', '.ts', '.tsx', '.mts', '.cts', '.yaml', '.yml', '.xml', '.svg', '.vue', '.svelte']);

function isCheckable(file) {
  return CHECKABLE_EXT.has(path.extname(file).toLowerCase());
}

/** Checkers that spawn a process (python, PowerShell, bash, node confirmation) are slow; everything else is in-process. */
const SPAWNING_EXT = new Set(['.py', '.pyw', '.ps1', '.psm1', '.psd1', '.sh', '.bash']);
function isSlowToCheck(file) { return SPAWNING_EXT.has(path.extname(file).toLowerCase()); }

/**
 * Check one file. Returns { ok, checker, errors:[{line,col,message}], skipped?, file }.
 * Never throws. `timeoutMs` caps every spawned checker so a caller with a time budget (the Stop
 * hook) can never be overrun by one slow file; spawn-based checkers report `skipped: 'timeout'`.
 */
function checkFile(file, { root, timeoutMs } = {}) {
  const t0 = Date.now();
  const cap = (def) => (timeoutMs ? Math.max(500, Math.min(def, timeoutMs)) : def);
  try {
    const st = fsx.statSafe(file);
    if (!st || !st.isFile()) return { ok: true, checker: 'none', skipped: 'file not found', errors: [], file };
    if (st.size > MAX_CHECK_BYTES) return { ok: true, checker: 'none', skipped: `file too large (${fsx.humanSize(st.size)})`, errors: [], file };
    const ext = path.extname(file).toLowerCase();
    let res;
    switch (ext) {
      case '.js': case '.cjs': case '.mjs':
        res = checkJSFile(file, cap(20000)); break;
      case '.json': case '.jsonc':
        res = checkJSON(fs.readFileSync(file, 'utf8'), file); break;
      case '.py': case '.pyw':
        res = checkPython(file, cap(20000)); break;
      case '.html': case '.htm': case '.xhtml': case '.vue': case '.svelte':
        res = checkHTML(fs.readFileSync(file, 'utf8'), file, cap(20000)); break;
      case '.css':
        res = checkCSS(fs.readFileSync(file, 'utf8')); break;
      case '.ps1': case '.psm1': case '.psd1':
        res = checkPowerShell(file, cap(15000)); break;
      case '.sh': case '.bash':
        res = checkShell(file, cap(10000)); break;
      case '.ts': case '.tsx': case '.mts': case '.cts':
        res = checkTypeScript(file, fs.readFileSync(file, 'utf8'), root); break;
      case '.yaml': case '.yml':
        res = checkYAML(fs.readFileSync(file, 'utf8')); break;
      case '.xml': case '.svg':
        res = checkXML(fs.readFileSync(file, 'utf8')); break;
      default:
        res = { ok: true, checker: 'none', skipped: 'no checker for this file type', errors: [] };
    }
    res.file = file;
    res.ms = Date.now() - t0;
    return res;
  } catch (e) {
    return { ok: true, checker: 'none', skipped: `checker crashed: ${e.message}`, errors: [], file, ms: Date.now() - t0 };
  }
}

function formatResult(res, root) {
  const rel = root ? fsx.relDisplay(res.file, root) : fsx.toPosix(res.file);
  if (res.skipped) return `${rel}: not checked (${res.skipped})`;
  if (res.ok) return `${rel}: OK (${res.checker}${res.ms != null ? `, ${res.ms}ms` : ''})`;
  const lines = res.errors.map((e) => `  ${rel}${e.line != null ? `:${e.line}${e.col != null ? `:${e.col}` : ''}` : ''}  ${e.message}`);
  return `${rel}: ${res.errors.length} error${res.errors.length === 1 ? '' : 's'} (${res.checker})\n${lines.join('\n')}`;
}

module.exports = { checkFile, isCheckable, isSlowToCheck, formatResult, checkJSText, checkJSSource, checkJSON, checkCSS, checkHTML, jsonErrorLocation, CHECKABLE_EXT, pythonCmd, powershellCmd, bashCmd, run };
