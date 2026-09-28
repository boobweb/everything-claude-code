'use strict';
// Exact TypeScript symbols using the project's own `typescript` package when it is installed
// (no bundled compiler: it is 8MB+). Returns null when TypeScript is not resolvable.

const path = require('path');

let tsCache = new Map(); // root -> ts | null

function loadTS(root) {
  const key = root || '';
  if (tsCache.has(key)) return tsCache.get(key);
  let ts = null;
  try { ts = require(require.resolve('typescript', { paths: [root || process.cwd(), process.cwd()] })); } catch { ts = null; }
  tsCache.set(key, ts);
  return ts;
}

function outlineTS(text, file, { root, maxSymbols = 600 } = {}) {
  const ts = loadTS(root || (file ? path.dirname(file) : undefined));
  if (!ts) return null;
  let sf;
  try {
    const kind = /\.tsx$/i.test(file || '') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
    sf = ts.createSourceFile(file || 'x.ts', text, ts.ScriptTarget.Latest, true, kind);
  } catch { return null; }
  const syms = [];
  const line = (pos) => sf.getLineAndCharacterOfPosition(pos).line + 1;
  const push = (s) => { if (syms.length < maxSymbols) syms.push(s); };
  const nameOf = (n) => (n && n.name ? n.name.getText(sf) : null);
  const isExported = (n) => !!(ts.getCombinedModifierFlags(n) & ts.ModifierFlags.Export);
  const params = (n) => (n.parameters || []).map((p) => p.name.getText(sf) + (p.questionToken ? '?' : '')).join(', ');
  const sigOf = (n) => `(${params(n)})${n.type ? `: ${n.type.getText(sf).slice(0, 30)}` : ''}`;
  let imports = 0;

  function members(node, owner) {
    for (const m of node.members || []) {
      const nm = nameOf(m);
      if (!nm) continue;
      if (ts.isMethodDeclaration(m) || ts.isMethodSignature(m)) push({ name: `${owner}.${nm}`, kind: 'method', line: line(m.getStart(sf)), endLine: line(m.end), sig: sigOf(m) });
      else if (ts.isConstructorDeclaration(m)) push({ name: `${owner}.constructor`, kind: 'constructor', line: line(m.getStart(sf)), endLine: line(m.end), sig: sigOf(m) });
      else if (ts.isGetAccessor(m) || ts.isSetAccessor(m)) push({ name: `${owner}.${nm}`, kind: ts.isGetAccessor(m) ? 'getter' : 'setter', line: line(m.getStart(sf)), endLine: line(m.end), sig: '' });
      else if (ts.isPropertyDeclaration(m) && m.initializer && (ts.isArrowFunction(m.initializer) || ts.isFunctionExpression(m.initializer))) push({ name: `${owner}.${nm}`, kind: 'method', line: line(m.getStart(sf)), endLine: line(m.end), sig: sigOf(m.initializer) });
    }
  }

  function visit(node, ctx) {
    const start = () => line(node.getStart(sf));
    if (ts.isImportDeclaration(node) || ts.isImportEqualsDeclaration(node)) { imports++; return; }
    if (ts.isFunctionDeclaration(node) && node.name) { push({ name: ctx ? `${ctx}/${nameOf(node)}` : nameOf(node), kind: 'function', line: start(), endLine: line(node.end), sig: sigOf(node), exported: isExported(node) }); return; }
    if (ts.isClassDeclaration(node)) { const nm = nameOf(node) || 'AnonymousClass'; push({ name: nm, kind: 'class', line: start(), endLine: line(node.end), sig: node.heritageClauses ? node.heritageClauses.map((h) => h.getText(sf)).join(' ').slice(0, 40) : '', exported: isExported(node) }); members(node, nm); return; }
    if (ts.isInterfaceDeclaration(node)) { push({ name: nameOf(node), kind: 'interface', line: start(), endLine: line(node.end), sig: `${node.members.length} members`, exported: isExported(node) }); return; }
    if (ts.isTypeAliasDeclaration(node)) { push({ name: nameOf(node), kind: 'type', line: start(), endLine: line(node.end), sig: '', exported: isExported(node) }); return; }
    if (ts.isEnumDeclaration(node)) { push({ name: nameOf(node), kind: 'enum', line: start(), endLine: line(node.end), sig: `${node.members.length} members`, exported: isExported(node) }); return; }
    if (ts.isModuleDeclaration(node)) { push({ name: nameOf(node), kind: 'namespace', line: start(), endLine: line(node.end), sig: '', exported: isExported(node) }); if (node.body && node.body.statements) node.body.statements.forEach((s) => visit(s, nameOf(node))); return; }
    if (ts.isVariableStatement(node)) {
      const exported = isExported(node);
      for (const d of node.declarationList.declarations) {
        const nm = d.name.getText(sf);
        const init = d.initializer;
        const s = { line: line(d.getStart(sf)), endLine: line(d.end), exported };
        if (!init) { if (!ctx) push({ ...s, name: nm, kind: 'state', sig: d.type ? `: ${d.type.getText(sf).slice(0, 30)}` : '' }); continue; }
        if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) push({ ...s, name: nm, kind: 'function', sig: sigOf(init) });
        else if (ts.isArrayLiteralExpression(init)) push({ ...s, name: nm, kind: 'array', sig: `${init.elements.length} items` });
        else if (ts.isObjectLiteralExpression(init)) { push({ ...s, name: nm, kind: 'object', sig: `${init.properties.length} keys` }); for (const p of init.properties) if (ts.isMethodDeclaration(p) || (ts.isPropertyAssignment(p) && p.initializer && (ts.isArrowFunction(p.initializer) || ts.isFunctionExpression(p.initializer)))) push({ name: `${nm}.${p.name.getText(sf)}`, kind: 'method', line: line(p.getStart(sf)), endLine: line(p.end), sig: '' }); }
        else if (ts.isClassExpression(init)) { push({ ...s, name: nm, kind: 'class', sig: '' }); members(init, nm); }
        else if (!ctx && /^[A-Z][A-Z0-9_]{2,}$/.test(nm)) push({ ...s, name: nm, kind: 'const', sig: init.getText(sf).slice(0, 30) });
        else if (!ctx && ts.isNewExpression(init)) push({ ...s, name: nm, kind: 'state', sig: `new ${init.expression.getText(sf).slice(0, 30)}` });
      }
      return;
    }
    if (ts.isExpressionStatement(node) && ts.isCallExpression(node.expression) && !ctx) {
      const callee = node.expression.expression.getText(sf);
      if (/^(document|window)\.addEventListener$/.test(callee)) push({ name: `on ${node.expression.arguments[0] ? node.expression.arguments[0].getText(sf).replace(/['"]/g, '') : '?'}`, kind: 'boot', line: start(), endLine: line(node.end), sig: '' });
      return;
    }
    if (ts.isExportAssignment(node)) { push({ name: 'default', kind: 'export', line: start(), endLine: line(node.end), sig: '', exported: true }); return; }
  }
  sf.statements.forEach((s) => visit(s, null));
  return { symbols: syms, imports, truncated: syms.length >= maxSymbols, parser: 'typescript' };
}

module.exports = { outlineTS, loadTS };
