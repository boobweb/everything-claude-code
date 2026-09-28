'use strict';
// Exact JavaScript symbol extraction and syntax checking on a real AST (acorn, vendored).
// Replaces regex heuristics for .js/.mjs/.cjs and HTML inline scripts: every symbol carries
// its precise start and end line, methods are attributed to their class or object, exports
// are marked, and syntax errors come with line and column without spawning a process.

const acorn = require('../vendor/acorn/acorn');

const ECMA = 'latest';

/**
 * Parse text as a module or a classic script, trying the more likely mode first.
 * Returns { ast, sourceType } or { error: { line, col, message }, sourceType }.
 */
function parse(text, { module } = {}) {
  // Explicit mode (.mjs -> module, .cjs -> script, <script type=module>) is strict, like node.
  // Unknown (.js, inline scripts): try the likelier mode first, then the other.
  let order;
  if (module === true) order = ['module'];
  else if (module === false) order = ['script'];
  else order = /^\s*(import\s|import\(|export\s)/m.test(text) ? ['module', 'script'] : ['script', 'module'];
  let firstErr = null;
  for (const sourceType of order) {
    try {
      const ast = acorn.parse(text, { ecmaVersion: ECMA, sourceType, locations: true, allowHashBang: true, allowReturnOutsideFunction: sourceType === 'script', allowAwaitOutsideFunction: sourceType === 'module' });
      return { ast, sourceType };
    } catch (e) {
      const err = { line: e.loc ? e.loc.line : null, col: e.loc ? e.loc.column + 1 : null, message: `SyntaxError: ${String(e.message).replace(/\s*\(\d+:\d+\)\s*$/, '')}` };
      if (!firstErr) firstErr = { error: err, sourceType };
    }
  }
  return firstErr;
}

function paramSig(params) {
  return params.map((p) => {
    switch (p.type) {
      case 'Identifier': return p.name;
      case 'AssignmentPattern': return `${paramSig([p.left])} = …`;
      case 'RestElement': return `...${paramSig([p.argument])}`;
      case 'ObjectPattern': return `{${p.properties.slice(0, 4).map((q) => (q.type === 'RestElement' ? '...' : keyName(q.key))).join(', ')}${p.properties.length > 4 ? ', …' : ''}}`;
      case 'ArrayPattern': return `[${p.elements.filter(Boolean).slice(0, 4).map((q) => paramSig([q])).join(', ')}]`;
      default: return '?';
    }
  }).join(', ');
}

function keyName(key, computed) {
  if (!key) return '?';
  if (computed) return `[${key.type === 'Identifier' ? key.name : key.type === 'Literal' ? JSON.stringify(key.value) : '…'}]`;
  if (key.type === 'Identifier') return key.name;
  if (key.type === 'PrivateIdentifier') return `#${key.name}`;
  if (key.type === 'Literal') return String(key.value);
  return '?';
}

function memberName(node) {
  // window.foo.bar -> "window.foo.bar"; returns null for computed/complex chains
  if (node.type === 'Identifier') return node.name;
  if (node.type === 'ThisExpression') return 'this';
  if (node.type === 'MemberExpression' && !node.computed) { const o = memberName(node.object); return o ? `${o}.${node.property.name}` : null; }
  return null;
}

function isFn(n) { return n && (n.type === 'FunctionExpression' || n.type === 'ArrowFunctionExpression'); }

/**
 * Walk the AST and produce symbols: [{ name, kind, line, endLine, sig, mods, exported }].
 * For callables `sig` is the bare parameter list (rendered as name(sig)) and `mods` holds
 * modifiers such as "async", "static", "*" (rendered after the signature).
 * `lineOffset` shifts line numbers (for inline scripts inside HTML).
 */
function extractSymbols(ast, { lineOffset = 0, maxSymbols = 600 } = {}) {
  const syms = [];
  const L = (n) => n.loc.start.line + lineOffset;
  const E = (n) => n.loc.end.line + lineOffset;
  const push = (s) => { if (syms.length < maxSymbols) syms.push(s); };
  let imports = 0;

  const fnSig = (fn) => paramSig(fn.params);
  const fnMods = (fn, ...extra) => [...extra, fn.async ? 'async' : '', fn.generator ? '*' : ''].filter(Boolean).join(' ');

  function classMembers(cls, className) {
    for (const m of cls.body.body) {
      if (m.type === 'MethodDefinition') {
        const nm = keyName(m.key, m.computed);
        const kind = m.kind === 'constructor' ? 'constructor' : m.kind === 'get' || m.kind === 'set' ? `${m.kind}ter` : 'method';
        push({ name: `${className}.${nm}`, kind, line: L(m), endLine: E(m), sig: fnSig(m.value), mods: fnMods(m.value, m.static ? 'static' : '') });
      } else if (m.type === 'PropertyDefinition' && isFn(m.value)) {
        push({ name: `${className}.${keyName(m.key, m.computed)}`, kind: 'method', line: L(m), endLine: E(m), sig: fnSig(m.value), mods: fnMods(m.value, m.static ? 'static' : '') });
      } else if (m.type === 'PropertyDefinition' && m.static) {
        push({ name: `${className}.${keyName(m.key, m.computed)}`, kind: 'static', line: L(m), endLine: E(m), sig: '' });
      }
    }
  }

  function objectMembers(obj, objName, depth) {
    let count = 0;
    for (const p of obj.properties) {
      if (p.type !== 'Property') continue;
      const nm = keyName(p.key, p.computed);
      if (isFn(p.value)) { push({ name: `${objName}.${nm}`, kind: 'method', line: L(p), endLine: E(p), sig: fnSig(p.value), mods: fnMods(p.value) }); count++; }
      else if (p.value && p.value.type === 'ObjectExpression' && depth < 2 && p.value.properties.some((q) => q.type === 'Property' && isFn(q.value))) objectMembers(p.value, `${objName}.${nm}`, depth + 1);
    }
    return count;
  }

  function declarator(d, { exported, top, ctx }) {
    if (d.id.type !== 'Identifier') { // destructuring: const { a, b } = require(...)
      if (top && d.init && d.init.type === 'CallExpression' && d.init.callee.type === 'Identifier' && d.init.callee.name === 'require') imports++;
      return;
    }
    const name = ctx ? `${ctx}/${d.id.name}` : d.id.name;
    const init = d.init;
    if (!init) { if (top) push({ name, kind: 'state', line: L(d), endLine: E(d), sig: 'uninitialized', exported }); return; }
    if (isFn(init)) return push({ name, kind: 'function', line: L(d), endLine: E(d), sig: fnSig(init), mods: fnMods(init), exported });
    if (init.type === 'ClassExpression') { push({ name, kind: 'class', line: L(d), endLine: E(d), sig: init.superClass ? `extends ${memberName(init.superClass) || '…'}` : '', exported }); classMembers(init, name); return; }
    if (init.type === 'ArrayExpression') return push({ name, kind: 'array', line: L(d), endLine: E(d), sig: `${init.elements.length} items${init.elements[0] && init.elements[0].type === 'ObjectExpression' ? `, keys: ${init.elements[0].properties.filter((p) => p.type === 'Property').slice(0, 8).map((p) => keyName(p.key, p.computed)).join(',')}` : ''}`, exported });
    if (init.type === 'ObjectExpression') { push({ name, kind: 'object', line: L(d), endLine: E(d), sig: `${init.properties.length} keys`, exported }); objectMembers(init, name, 0); return; }
    if (init.type === 'Literal' && typeof init.value === 'string' && init.value.length > 1000) return push({ name, kind: 'const', line: L(d), endLine: E(d), sig: `blob ${init.value.length.toLocaleString('en-US')} chars`, exported });
    if (init.type === 'TemplateLiteral' && init.quasis.reduce((n, q) => n + q.value.raw.length, 0) > 1000) return push({ name, kind: 'const', line: L(d), endLine: E(d), sig: 'template blob', exported });
    if (init.type === 'CallExpression' && init.callee.type === 'Identifier' && init.callee.name === 'require') { imports++; return; }
    if (init.type === 'NewExpression') return top && push({ name, kind: 'state', line: L(d), endLine: E(d), sig: `new ${memberName(init.callee) || '…'}`, exported });
    if (top) {
      if (/^[A-Z][A-Z0-9_]{2,}$/.test(d.id.name)) return push({ name, kind: 'const', line: L(d), endLine: E(d), sig: init.type === 'Literal' ? String(init.raw).slice(0, 30) : init.type, exported });
      if (d.parentKind !== 'const') return push({ name, kind: 'state', line: L(d), endLine: E(d), sig: init.type === 'Literal' ? `= ${String(init.raw).slice(0, 20)}` : init.type === 'CallExpression' ? `= ${memberName(init.callee) || 'call'}(…)` : `= ${init.type}`, exported });
    }
  }

  function statement(node, { top, ctx = null, exported = false }) {
    switch (node.type) {
      case 'ImportDeclaration': imports++; return;
      case 'ExportNamedDeclaration':
        if (node.declaration) statement(node.declaration, { top, ctx, exported: true });
        return;
      case 'ExportDefaultDeclaration': {
        const d = node.declaration;
        if (d.type === 'FunctionDeclaration' || d.type === 'ClassDeclaration') { statement(d, { top, ctx, exported: true }); return; }
        if (isFn(d)) return push({ name: 'default', kind: 'function', line: L(node), endLine: E(node), sig: fnSig(d), mods: fnMods(d), exported: true });
        if (d.type === 'ObjectExpression') { push({ name: 'default', kind: 'object', line: L(node), endLine: E(node), sig: `${d.properties.length} keys`, exported: true }); objectMembers(d, 'default', 0); return; }
        return push({ name: 'default', kind: 'export', line: L(node), endLine: E(node), sig: d.type, exported: true });
      }
      case 'FunctionDeclaration': {
        const name = ctx ? `${ctx}/${node.id ? node.id.name : 'anonymous'}` : node.id ? node.id.name : 'anonymous';
        push({ name, kind: 'function', line: L(node), endLine: E(node), sig: fnSig(node), mods: fnMods(node), exported });
        // one level of nested named functions
        if (!ctx) for (const inner of node.body.body || []) if (inner.type === 'FunctionDeclaration') statement(inner, { top: false, ctx: name });
        return;
      }
      case 'ClassDeclaration': {
        const name = node.id ? node.id.name : 'AnonymousClass';
        push({ name, kind: 'class', line: L(node), endLine: E(node), sig: node.superClass ? `extends ${memberName(node.superClass) || '…'}` : '', exported });
        classMembers(node, name);
        return;
      }
      case 'VariableDeclaration':
        for (const d of node.declarations) { d.parentKind = node.kind; declarator(d, { exported, top, ctx }); }
        return;
      case 'ExpressionStatement': {
        const e = node.expression;
        if (e.type === 'AssignmentExpression' && e.left.type === 'MemberExpression') {
          const target = memberName(e.left);
          if (!target) return;
          if (isFn(e.right) || e.right.type === 'ClassExpression') {
            const fn = isFn(e.right) ? e.right : null;
            const protoMatch = /^(.+)\.prototype\.([^.]+)$/.exec(target);
            if (protoMatch) return push({ name: `${protoMatch[1]}.${protoMatch[2]}`, kind: fn ? 'method' : 'class', line: L(node), endLine: E(node), sig: fn ? fnSig(fn) : '', mods: fn ? fnMods(fn) : '' });
            const globalMatch = /^(?:window|globalThis|self|module\.exports|exports)\.(.+)$/.exec(target);
            if (/^window\.on(load|ready)$/.test(target)) return push({ name: target, kind: 'boot', line: L(node), endLine: E(node), sig: '' });
            if (globalMatch) return push({ name: globalMatch[1], kind: fn ? 'function' : 'class', line: L(node), endLine: E(node), sig: fn ? fnSig(fn) : '', mods: fn ? fnMods(fn, 'global') : 'global', exported: /^(module\.exports|exports)\./.test(target) });
            return push({ name: target, kind: fn ? 'function' : 'class', line: L(node), endLine: E(node), sig: fn ? fnSig(fn) : '', mods: fn ? fnMods(fn) : '' });
          }
          if (target === 'module.exports' && e.right.type === 'ObjectExpression') { push({ name: 'module.exports', kind: 'object', line: L(node), endLine: E(node), sig: `${e.right.properties.length} keys`, exported: true }); objectMembers(e.right, 'exports', 0); return; }
          if (/^(?:window|globalThis)\.[A-Za-z_$][\w$]*$/.test(target) && top) return push({ name: target.split('.')[1], kind: 'state', line: L(node), endLine: E(node), sig: 'global' });
          return;
        }
        if (e.type === 'CallExpression') {
          const callee = e.callee;
          // IIFE: (function name(){})() or (() => {})() or (async () => {})()
          if (isFn(callee) && top) return push({ name: callee.id ? `(iife ${callee.id.name})` : '(iife)', kind: 'iife', line: L(node), endLine: E(node), sig: '', mods: fnMods(callee) });
          const cname = memberName(callee);
          if (cname && /^(document|window|globalThis)\.addEventListener$/.test(cname) && e.arguments[0] && e.arguments[0].type === 'Literal') {
            const ev = String(e.arguments[0].value);
            if (/^(DOMContentLoaded|load|readystatechange|pageshow)$/.test(ev)) return push({ name: `on ${ev}`, kind: 'boot', line: L(node), endLine: E(node), sig: '' });
          }
          if (cname === 'requestAnimationFrame' && top) return push({ name: 'requestAnimationFrame', kind: 'boot', line: L(node), endLine: E(node), sig: '' });
        }
        return;
      }
      default: return;
    }
  }

  for (const node of ast.body) statement(node, { top: true });
  return { symbols: syms, imports, truncated: syms.length >= maxSymbols };
}

/**
 * Outline for JS text: exact symbols when it parses, otherwise null (caller falls back to heuristics).
 */
function outlineJS(text, { lineOffset = 0, maxSymbols = 600, module } = {}) {
  const r = parse(text, { module });
  if (!r.ast) return { symbols: null, error: r.error, sourceType: r.sourceType };
  const out = extractSymbols(r.ast, { lineOffset, maxSymbols });
  return { ...out, sourceType: r.sourceType, parser: 'acorn' };
}

/** In-process syntax check. Returns { ok, error: {line,col,message}|null, sourceType }. */
function checkJS(text, { module } = {}) {
  const r = parse(text, { module });
  if (r.ast) return { ok: true, error: null, sourceType: r.sourceType };
  return { ok: false, error: r.error, sourceType: r.sourceType };
}

module.exports = { parse, extractSymbols, outlineJS, checkJS, acornVersion: acorn.version };
