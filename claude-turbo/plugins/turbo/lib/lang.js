'use strict';
// Language detection and symbol extraction. JavaScript, Python and TypeScript go through real
// parsers (js-ast: vendored acorn; py-ast: the interpreter's ast module; ts-ast: the project's
// own typescript package) and fall back to the regex heuristics below when a parser is not
// available or the file does not parse. Goal: a compact, line-numbered outline of any source
// file so the model can jump straight to the right place instead of reading the whole file.

const path = require('path');
const fs = require('fs');
let jsAst = null, pyAst = null, tsAst = null;
try { jsAst = require('./js-ast'); } catch { jsAst = null; }
try { pyAst = require('./py-ast'); } catch { pyAst = null; }
try { tsAst = require('./ts-ast'); } catch { tsAst = null; }

const LANG_BY_EXT = {
  '.js': 'js', '.mjs': 'js', '.cjs': 'js', '.jsx': 'js',
  '.ts': 'ts', '.tsx': 'ts', '.mts': 'ts', '.cts': 'ts',
  '.py': 'python', '.pyw': 'python', '.pyi': 'python',
  '.go': 'go', '.rs': 'rust',
  '.java': 'java', '.kt': 'kotlin', '.kts': 'kotlin', '.cs': 'csharp', '.swift': 'swift',
  '.dart': 'dart', '.scala': 'scala', '.groovy': 'groovy',
  '.c': 'c', '.h': 'c', '.cpp': 'cpp', '.cc': 'cpp', '.cxx': 'cpp', '.hpp': 'cpp', '.hh': 'cpp', '.hxx': 'cpp',
  '.m': 'objc', '.mm': 'objc',
  '.ps1': 'powershell', '.psm1': 'powershell', '.psd1': 'powershell',
  '.sh': 'shell', '.bash': 'shell', '.zsh': 'shell', '.bat': 'batch', '.cmd': 'batch',
  '.rb': 'ruby', '.php': 'php', '.lua': 'lua', '.pl': 'perl', '.r': 'r', '.jl': 'julia', '.ex': 'elixir', '.exs': 'elixir',
  '.md': 'markdown', '.mdx': 'markdown', '.markdown': 'markdown', '.txt': 'text', '.rst': 'text',
  '.json': 'json', '.jsonc': 'json', '.json5': 'json', '.yaml': 'yaml', '.yml': 'yaml', '.toml': 'toml', '.ini': 'ini', '.env': 'ini',
  '.sql': 'sql', '.graphql': 'graphql', '.gql': 'graphql', '.proto': 'proto',
  '.html': 'html', '.htm': 'html', '.xhtml': 'html', '.vue': 'html', '.svelte': 'html', '.astro': 'html',
  '.css': 'css', '.scss': 'css', '.sass': 'css', '.less': 'css',
  '.xml': 'xml', '.svg': 'xml', '.csproj': 'xml', '.plist': 'xml',
  '.dockerfile': 'docker',
};

const SPECIAL_NAMES = {
  'dockerfile': 'docker', 'makefile': 'make', 'cmakelists.txt': 'cmake', 'gemfile': 'ruby', 'rakefile': 'ruby',
  'package.json': 'json', 'tsconfig.json': 'json', '.gitignore': 'text', '.env': 'ini', 'procfile': 'text',
};

function detectLang(file) {
  const base = path.basename(file).toLowerCase();
  if (SPECIAL_NAMES[base]) return SPECIAL_NAMES[base];
  const ext = path.extname(base);
  return LANG_BY_EXT[ext] || null;
}

const CODE_LANGS = new Set(['js', 'ts', 'python', 'go', 'rust', 'java', 'kotlin', 'csharp', 'swift', 'dart', 'scala', 'groovy', 'c', 'cpp', 'objc', 'powershell', 'shell', 'ruby', 'php', 'lua', 'perl', 'r', 'julia', 'elixir', 'sql', 'graphql', 'proto', 'html', 'css']);

const JS_KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'function', 'return', 'else', 'do', 'try', 'new', 'typeof', 'await', 'yield', 'import', 'export', 'delete', 'void', 'in', 'of', 'instanceof', 'throw', 'case', 'default', 'with', 'super', 'this']);

function trimSig(s, n = 70) {
  s = (s || '').replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

/**
 * Strip strings and comments from one line for brace counting.
 * `st` carries multi-line state: { block: bool, tpl: bool }.
 */
function codeOnly(line, st) {
  let out = '';
  let i = 0;
  const n = line.length;
  while (i < n) {
    const c = line[i];
    const d = line[i + 1];
    if (st.block) {
      if (c === '*' && d === '/') { st.block = false; i += 2; continue; }
      i++; continue;
    }
    if (st.tpl) {
      if (c === '\\') { i += 2; continue; }
      if (c === '`') { st.tpl = false; i++; continue; }
      i++; continue;
    }
    if (c === '/' && d === '*') { st.block = true; i += 2; continue; }
    if (c === '/' && d === '/') break;
    if (c === '#' && st.hashComments) break;
    if (c === '`') { st.tpl = true; i++; continue; }
    if (c === '"' || c === "'") {
      const q = c; i++;
      while (i < n && line[i] !== q) { if (line[i] === '\\') i++; i++; }
      i++; continue;
    }
    out += c; i++;
  }
  return out;
}

function braceDelta(code) {
  let open = 0, close = 0;
  for (let i = 0; i < code.length; i++) {
    const c = code[i];
    if (c === '{') open++; else if (c === '}') close++;
  }
  return { open, close };
}

// ---------------- JS / TS ----------------
const JS_RES = {
  func: /^\s*(?:export\s+(?:default\s+)?)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*\(([^)]*)\)?/,
  klass: /^\s*(?:export\s+(?:default\s+)?)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)(?:\s*<[^>]*>)?(?:\s+extends\s+([\w$.<>]+))?/,
  arrow: /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:function\b\s*\*?\s*(?:[A-Za-z_$][\w$]*)?\s*\(([^)]*)\)?|\(([^)]*)\)\s*(?::[^=]+)?=>|([A-Za-z_$][\w$]*)\s*=>)/,
  data: /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(\[|\{|new\s+[\w$.]+|`|"|'|\d|true\b|false\b|null\b|require\(|await\s+import\(|Object\.freeze\()/,
  proto: /^\s*([A-Za-z_$][\w$.]*)\.prototype\.([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function|\(|[A-Za-z_$][\w$]*\s*=>)/,
  global: /^\s*(?:window|globalThis|self|module\.exports|exports)\.([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function\b|\(|[A-Za-z_$][\w$]*\s*=>|class\b)/,
  method: /^\s*(?:(?:static|async|get|set|public|private|protected|readonly|override|abstract)\s+)*\*?\s*([A-Za-z_$#][\w$]*|\[[^\]]+\])\s*(?:<[^>]*>)?\s*\(([^)]*)\)\s*(?::\s*[^{;=]+)?\s*\{/,
  objMethod: /^\s*(?:"[^"]+"|'[^']+'|[A-Za-z_$][\w$]*)\s*:\s*(?:async\s*)?(?:function\s*\*?\s*\(([^)]*)\)|\(([^)]*)\)\s*=>|[A-Za-z_$][\w$]*\s*=>)/,
  tsType: /^\s*(?:export\s+)?(?:declare\s+)?(interface|type|enum|namespace|module)\s+([A-Za-z_$][\w$]*)/,
  iife: /^\s*[;!+]?\s*\(\s*(?:async\s+)?(?:function\s*\*?\s*([A-Za-z_$][\w$]*)?\s*\(|\([^)]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)/,
  boot: /^\s*(?:document|window)\.addEventListener\(\s*['"](DOMContentLoaded|load|readystatechange)['"]/,
  onload: /^\s*window\.(onload|onready)\s*=/,
  imp: /^\s*(?:import\b|const\s+.*=\s*require\()/,
};

function extractJS(lines, { lang = 'js', lineOffset = 0, maxSymbols = 400 } = {}) {
  const syms = [];
  const st = { block: false, tpl: false };
  let depth = 0;
  const containers = []; // { name, depthInside, kind }
  let imports = 0;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const ln = i + 1 + lineOffset;
    const isBlob = raw.length > 2000;
    const line = isBlob ? raw.slice(0, 300) : raw;
    const depthBefore = depth;
    // pop containers we've left
    while (containers.length && depthBefore < containers[containers.length - 1].depthInside) containers.pop();
    const top = containers.length ? containers[containers.length - 1] : null;
    let m;
    if (syms.length < maxSymbols && !st.block) {
      if (JS_RES.imp.test(line)) imports++;
      if ((m = JS_RES.func.exec(line))) {
        syms.push({ name: qualify(top, depthBefore, m[1]), kind: 'function', line: ln, sig: trimSig(m[2]) });
      } else if ((m = JS_RES.klass.exec(line))) {
        syms.push({ name: m[1], kind: 'class', line: ln, sig: m[2] ? `extends ${m[2]}` : '' });
        containers.push({ name: m[1], depthInside: depthBefore + 1, kind: 'class' });
      } else if ((m = JS_RES.arrow.exec(line))) {
        syms.push({ name: qualify(top, depthBefore, m[1]), kind: 'function', line: ln, sig: trimSig(m[2] || m[3] || m[4] || '') });
      } else if ((m = JS_RES.proto.exec(line))) {
        syms.push({ name: `${m[1]}.${m[2]}`, kind: 'method', line: ln, sig: '' });
      } else if ((m = JS_RES.global.exec(line))) {
        syms.push({ name: m[1], kind: 'function', line: ln, sig: 'global' });
      } else if (lang === 'ts' && (m = JS_RES.tsType.exec(line))) {
        syms.push({ name: m[2], kind: m[1], line: ln, sig: '' });
      } else if (depthBefore === 0 && (m = JS_RES.data.exec(line))) {
        const opener = m[2];
        const kind = opener === '[' ? 'array' : opener === '{' ? 'object' : 'const';
        if (kind !== 'const' || isBlob) syms.push({ name: m[1], kind, line: ln, sig: isBlob ? `blob ${raw.length.toLocaleString('en-US')} chars` : '' });
        if (kind === 'object' && /\{\s*$/.test(line)) containers.push({ name: m[1], depthInside: depthBefore + 1, kind: 'object' });
      } else if (top && depthBefore === top.depthInside && (m = JS_RES.method.exec(line)) && !JS_KEYWORDS.has(m[1])) {
        syms.push({ name: `${top.name}.${m[1]}`, kind: m[1] === 'constructor' ? 'constructor' : 'method', line: ln, sig: trimSig(m[2]) });
      } else if (top && top.kind === 'object' && depthBefore === top.depthInside && (m = JS_RES.objMethod.exec(line))) {
        const nm = line.match(/^\s*(?:"([^"]+)"|'([^']+)'|([A-Za-z_$][\w$]*))/);
        const name = nm ? (nm[1] || nm[2] || nm[3]) : '?';
        syms.push({ name: `${top.name}.${name}`, kind: 'method', line: ln, sig: trimSig(m[1] || m[2] || '') });
      } else if (depthBefore === 0 && (m = JS_RES.iife.exec(line)) && !/^\s*(?:if|for|while|switch|return)\b/.test(line)) {
        syms.push({ name: m[1] ? `(iife ${m[1]})` : '(iife)', kind: 'iife', line: ln, sig: trimSig(line, 50) });
      } else if ((m = JS_RES.boot.exec(line))) {
        syms.push({ name: `on ${m[1]}`, kind: 'boot', line: ln, sig: '' });
      } else if ((m = JS_RES.onload.exec(line))) {
        syms.push({ name: `window.${m[1]}`, kind: 'boot', line: ln, sig: '' });
      }
    }
    if (!isBlob) {
      const code = codeOnly(line, st);
      const d = braceDelta(code);
      depth = Math.max(0, depth + d.open - d.close);
    }
  }
  return { symbols: syms, imports, truncated: syms.length >= maxSymbols };
}

function qualify(top, depth, name) {
  if (top && depth >= top.depthInside) return `${top.name}.${name}`;
  return depth > 0 ? `${name} (nested)` : name;
}

// ---------------- Python ----------------
function extractPython(lines, { lineOffset = 0, maxSymbols = 400 } = {}) {
  const syms = [];
  let currentClass = null; // { name, indent }
  for (let i = 0; i < lines.length && syms.length < maxSymbols; i++) {
    const line = lines[i];
    const ln = i + 1 + lineOffset;
    let m;
    if ((m = /^(\s*)class\s+(\w+)\s*(\([^)]*\))?\s*:/.exec(line))) {
      const indent = m[1].length;
      syms.push({ name: m[2], kind: 'class', line: ln, sig: trimSig(m[3] || '') });
      currentClass = { name: m[2], indent };
    } else if ((m = /^(\s*)(?:async\s+)?def\s+(\w+)\s*\(([^)]*)\)?/.exec(line))) {
      const indent = m[1].length;
      if (currentClass && indent > currentClass.indent) {
        syms.push({ name: `${currentClass.name}.${m[2]}`, kind: 'method', line: ln, sig: trimSig(m[3]) });
      } else {
        if (indent === 0) currentClass = null;
        syms.push({ name: indent === 0 ? m[2] : `${m[2]} (nested)`, kind: 'function', line: ln, sig: trimSig(m[3]) });
      }
    } else if ((m = /^([A-Z][A-Z0-9_]{2,})\s*(?::[^=]+)?=\s*(\[|\{|\(|"|')/.exec(line))) {
      syms.push({ name: m[1], kind: m[2] === '[' ? 'array' : m[2] === '{' ? 'object' : 'const', line: ln, sig: '' });
    } else if (/^if\s+__name__\s*==/.test(line)) {
      syms.push({ name: '__main__', kind: 'boot', line: ln, sig: '' });
    } else if (currentClass && /^\S/.test(line) && !/^\s*[@#]/.test(line) && !/^\s*$/.test(line) && !/^(class|def|async)\b/.test(line)) {
      currentClass = null;
    }
  }
  return { symbols: syms, truncated: syms.length >= maxSymbols };
}

// ---------------- Generic regex-driven languages ----------------
const GENERIC = {
  go: [
    { re: /^func\s+\(\s*\w+\s+\*?(\w+)\s*\)\s*(\w+)\s*\(([^)]*)\)?/, kind: 'method', name: (m) => `${m[1]}.${m[2]}`, sig: 3 },
    { re: /^func\s+(\w+)\s*(?:\[[^\]]*\])?\s*\(([^)]*)\)?/, kind: 'function', name: 1, sig: 2 },
    { re: /^type\s+(\w+)\s+(struct|interface)\b/, kind: (m) => m[2], name: 1 },
    { re: /^type\s+(\w+)\s+/, kind: 'type', name: 1 },
  ],
  rust: [
    { re: /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:unsafe\s+)?(?:const\s+)?fn\s+(\w+)\s*(?:<[^>]*>)?\s*\(([^)]*)\)?/, kind: 'function', name: 1, sig: 2 },
    { re: /^\s*(?:pub(?:\([^)]*\))?\s+)?(struct|enum|trait|mod|type|union)\s+(\w+)/, kind: (m) => m[1], name: 2 },
    { re: /^\s*impl(?:<[^>]*>)?\s+(?:(\w+)\s+for\s+)?([\w:<>]+)/, kind: 'impl', name: (m) => (m[1] ? `${m[1]} for ${m[2]}` : m[2]) },
    { re: /^\s*(?:pub\s+)?(?:static|const)\s+([A-Z][A-Z0-9_]+)\s*:/, kind: 'const', name: 1 },
    { re: /^\s*macro_rules!\s+(\w+)/, kind: 'macro', name: 1 },
  ],
  java: [
    { re: /^\s*(?:(?:public|private|protected|static|final|abstract|sealed|non-sealed|strictfp)\s+)*(class|interface|enum|record|@interface)\s+(\w+)/, kind: (m) => m[1].replace('@', ''), name: 2 },
    { re: /^\s*(?:(?:public|private|protected|static|final|abstract|synchronized|native|default)\s+)+(?:<[^>]+>\s*)?[\w<>\[\],.?\s]+?\s+(\w+)\s*\(([^)]*)\)?/, kind: 'method', name: 1, sig: 2, notKw: true },
  ],
  kotlin: [
    { re: /^\s*(?:(?:public|private|protected|internal|open|abstract|sealed|data|enum|annotation|inner|final)\s+)*(class|interface|object)\s+(\w+)/, kind: (m) => m[1], name: 2 },
    { re: /^\s*(?:(?:public|private|protected|internal|open|override|suspend|inline|abstract|operator|infix)\s+)*fun\s+(?:<[^>]+>\s+)?(?:[\w.]+\.)?(\w+)\s*\(([^)]*)\)?/, kind: 'function', name: 1, sig: 2 },
  ],
  csharp: [
    { re: /^\s*(?:(?:public|private|protected|internal|static|abstract|sealed|partial|readonly|ref|record)\s+)*(class|interface|enum|struct|record)\s+(\w+)/, kind: (m) => m[1], name: 2 },
    { re: /^\s*(?:(?:public|private|protected|internal|static|virtual|override|abstract|async|sealed|extern|unsafe|partial|new)\s+)+(?:[\w<>\[\],.?\s]+?)\s+(\w+)\s*\(([^)]*)\)?/, kind: 'method', name: 1, sig: 2, notKw: true },
    { re: /^\s*namespace\s+([\w.]+)/, kind: 'namespace', name: 1 },
  ],
  swift: [
    { re: /^\s*(?:(?:public|private|fileprivate|internal|open|final|static)\s+)*(class|struct|enum|protocol|extension|actor)\s+(\w+)/, kind: (m) => m[1], name: 2 },
    { re: /^\s*(?:(?:public|private|fileprivate|internal|open|static|override|mutating|class|convenience|required)\s+)*(?:func|init)\s*(\w*)\s*(?:<[^>]+>)?\s*\(([^)]*)\)?/, kind: 'function', name: (m) => m[1] || 'init', sig: 2 },
  ],
  dart: [
    { re: /^\s*(?:abstract\s+)?(class|mixin|enum|extension)\s+(\w+)/, kind: (m) => m[1], name: 2 },
    { re: /^\s*(?:static\s+)?(?:[\w<>\[\],.?]+\s+)?(\w+)\s*\(([^)]*)\)\s*(?:async\s*)?\{/, kind: 'function', name: 1, sig: 2, notKw: true },
  ],
  scala: [
    { re: /^\s*(?:(?:case|abstract|final|sealed|implicit)\s+)*(class|object|trait)\s+(\w+)/, kind: (m) => m[1], name: 2 },
    { re: /^\s*(?:(?:private|protected|override|implicit|final)\s+)*def\s+(\w+)/, kind: 'function', name: 1 },
  ],
  groovy: [
    { re: /^\s*(?:(?:public|private|protected|static|abstract|final)\s+)*(class|interface|enum|trait)\s+(\w+)/, kind: (m) => m[1], name: 2 },
    { re: /^\s*(?:(?:public|private|protected|static|def|void|[\w<>\[\]]+)\s+)+(\w+)\s*\(([^)]*)\)\s*\{/, kind: 'method', name: 1, sig: 2, notKw: true },
  ],
  c: [
    { re: /^(?:static\s+|inline\s+|extern\s+|const\s+|unsigned\s+|signed\s+|struct\s+|enum\s+|volatile\s+)*[\w*]+(?:\s*\*+\s*|\s+)\**(\w+)\s*\(([^;]*)\)\s*\{?\s*$/, kind: 'function', name: 1, sig: 2, notKw: true, topOnly: true },
    { re: /^\s*(?:typedef\s+)?(struct|enum|union)\s+(\w+)\s*\{?/, kind: (m) => m[1], name: 2 },
    { re: /^#define\s+(\w+)/, kind: 'macro', name: 1 },
  ],
  cpp: [
    { re: /^\s*(?:template\s*<[^>]*>\s*)?(class|struct|enum(?:\s+class)?|union|namespace)\s+(\w+)/, kind: (m) => m[1].split(/\s/)[0], name: 2 },
    { re: /^(?:[\w:<>*&,\s]+?)\s+\**(?:(\w+)::)?~?(\w+)\s*\(([^;]*)\)\s*(?:const\s*)?(?:noexcept\s*)?(?:override\s*)?\{?\s*$/, kind: 'function', name: (m) => (m[1] ? `${m[1]}::${m[2]}` : m[2]), sig: 3, notKw: true, topOnly: true },
    { re: /^#define\s+(\w+)/, kind: 'macro', name: 1 },
  ],
  objc: [
    { re: /^\s*@(interface|implementation|protocol)\s+(\w+)/, kind: (m) => m[1], name: 2 },
    { re: /^\s*[-+]\s*\([^)]*\)\s*(\w+)/, kind: 'method', name: 1 },
  ],
  powershell: [
    { re: /^\s*function\s+([\w-]+)/i, kind: 'function', name: 1 },
    { re: /^\s*filter\s+([\w-]+)/i, kind: 'function', name: 1 },
    { re: /^\s*class\s+(\w+)/i, kind: 'class', name: 1 },
    { re: /^\s*enum\s+(\w+)/i, kind: 'enum', name: 1 },
    { re: /^\s*(?:\[[^\]]+\]\s*)*param\s*\(/i, kind: 'params', name: () => 'param(...)' },
    { re: /^\s*\$(?:script|global):(\w+)\s*=/, kind: 'const', name: 1 },
  ],
  shell: [
    { re: /^\s*function\s+([\w-]+)/, kind: 'function', name: 1 },
    { re: /^\s*([\w-]+)\s*\(\)\s*\{?/, kind: 'function', name: 1 },
    { re: /^([A-Z][A-Z0-9_]+)=/, kind: 'const', name: 1 },
  ],
  batch: [
    { re: /^\s*:([\w-]+)\s*$/, kind: 'label', name: 1 },
  ],
  ruby: [
    { re: /^\s*(?:class|module)\s+([\w:]+)/, kind: 'class', name: 1 },
    { re: /^\s*def\s+(self\.)?([\w?!=\[\]<>+\-*\/%]+)\s*(\(([^)]*)\))?/, kind: (m) => (m[1] ? 'static' : 'method'), name: 2, sig: 4 },
  ],
  php: [
    { re: /^\s*(?:abstract\s+|final\s+)?(class|interface|trait|enum)\s+(\w+)/, kind: (m) => m[1], name: 2 },
    { re: /^\s*(?:(?:public|private|protected|static|abstract|final)\s+)*function\s+&?(\w+)\s*\(([^)]*)\)?/, kind: 'function', name: 1, sig: 2 },
    { re: /^\s*namespace\s+([\w\\]+)/, kind: 'namespace', name: 1 },
  ],
  lua: [
    { re: /^\s*(?:local\s+)?function\s+([\w.:]+)\s*\(([^)]*)\)?/, kind: 'function', name: 1, sig: 2 },
    { re: /^\s*(?:local\s+)?([\w.]+)\s*=\s*function\s*\(([^)]*)\)?/, kind: 'function', name: 1, sig: 2 },
  ],
  perl: [{ re: /^\s*sub\s+(\w+)/, kind: 'function', name: 1 }, { re: /^\s*package\s+([\w:]+)/, kind: 'package', name: 1 }],
  r: [{ re: /^\s*([\w.]+)\s*(?:<-|=)\s*function\s*\(([^)]*)\)?/, kind: 'function', name: 1, sig: 2 }],
  julia: [{ re: /^\s*function\s+([\w.!]+)\s*\(([^)]*)\)?/, kind: 'function', name: 1, sig: 2 }, { re: /^\s*(?:mutable\s+)?struct\s+(\w+)/, kind: 'struct', name: 1 }, { re: /^\s*module\s+(\w+)/, kind: 'module', name: 1 }],
  elixir: [{ re: /^\s*defmodule\s+([\w.]+)/, kind: 'module', name: 1 }, { re: /^\s*defp?\s+([\w?!]+)/, kind: 'function', name: 1 }],
  sql: [
    { re: /^\s*create\s+(?:or\s+replace\s+)?(?:temp(?:orary)?\s+)?(?:materialized\s+)?(table|view|function|procedure|index|trigger|schema|type|sequence)\s+(?:if\s+not\s+exists\s+)?([\w."`\[\]]+)/i, kind: (m) => m[1].toLowerCase(), name: 2 },
    { re: /^\s*alter\s+table\s+([\w."`\[\]]+)/i, kind: 'alter', name: 1 },
  ],
  graphql: [{ re: /^\s*(type|interface|enum|input|union|scalar|schema|query|mutation|subscription|fragment)\s+(\w+)?/, kind: (m) => m[1], name: (m) => m[2] || m[1] }],
  proto: [{ re: /^\s*(message|service|enum)\s+(\w+)/, kind: (m) => m[1], name: 2 }, { re: /^\s*rpc\s+(\w+)/, kind: 'rpc', name: 1 }],
  make: [{ re: /^([\w.\/-]+)\s*:(?!=)/, kind: 'target', name: 1 }],
  cmake: [{ re: /^\s*(function|macro)\s*\(\s*(\w+)/i, kind: (m) => m[1].toLowerCase(), name: 2 }, { re: /^\s*add_(executable|library)\s*\(\s*(\w+)/i, kind: (m) => m[1].toLowerCase(), name: 2 }],
  docker: [{ re: /^\s*FROM\s+(\S+)(?:\s+AS\s+(\w+))?/i, kind: 'stage', name: (m) => m[2] || m[1] }, { re: /^\s*(ENTRYPOINT|CMD|EXPOSE)\b(.*)/i, kind: (m) => m[1].toUpperCase(), name: (m) => trimSig(m[2], 50) }],
  toml: [{ re: /^\s*\[\[?([^\]]+)\]\]?/, kind: 'section', name: 1 }],
  ini: [{ re: /^\s*\[([^\]]+)\]/, kind: 'section', name: 1 }, { re: /^([A-Za-z_][\w.-]*)\s*=/, kind: 'key', name: 1 }],
  yaml: [{ re: /^([A-Za-z_][\w.\/-]*)\s*:/, kind: 'key', name: 1 }],
};

const CTRL_KW = new Set(['if', 'for', 'while', 'switch', 'return', 'else', 'new', 'catch', 'case', 'do', 'sizeof', 'throw', 'using', 'foreach', 'lock', 'try', 'delete', 'typeof', 'await']);

function extractGeneric(lines, lang, { lineOffset = 0, maxSymbols = 400 } = {}) {
  const rules = GENERIC[lang] || [];
  const syms = [];
  for (let i = 0; i < lines.length && syms.length < maxSymbols; i++) {
    const raw = lines[i];
    if (raw.length > 2000) continue;
    for (const r of rules) {
      const m = r.re.exec(raw);
      if (!m) continue;
      const name = typeof r.name === 'function' ? r.name(m) : m[r.name];
      if (!name) continue;
      if (r.notKw && CTRL_KW.has(String(name))) continue;
      if (r.topOnly && /^\s/.test(raw)) continue;
      const kind = typeof r.kind === 'function' ? r.kind(m) : r.kind;
      syms.push({ name, kind, line: i + 1 + lineOffset, sig: r.sig != null ? trimSig(m[r.sig]) : '' });
      break;
    }
  }
  return { symbols: syms, truncated: syms.length >= maxSymbols };
}

// ---------------- Markdown ----------------
function extractMarkdown(lines, { lineOffset = 0, maxSymbols = 400 } = {}) {
  const syms = [];
  let inFence = false;
  for (let i = 0; i < lines.length && syms.length < maxSymbols; i++) {
    const l = lines[i];
    if (/^\s*(```|~~~)/.test(l)) { inFence = !inFence; continue; }
    if (inFence) continue;
    const m = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(l);
    if (m) syms.push({ name: m[2], kind: `h${m[1].length}`, line: i + 1 + lineOffset, sig: '' });
  }
  return { symbols: syms, truncated: syms.length >= maxSymbols };
}

// ---------------- JSON ----------------
function extractJSON(text, lines, { maxSymbols = 200 } = {}) {
  const syms = [];
  text = text.replace(/^\uFEFF/, '');
  let parsed;
  if (text.length < 3 * 1024 * 1024) {
    try { parsed = JSON.parse(text); } catch { try { parsed = JSON.parse(stripJsonComments(text)); } catch { parsed = undefined; } }
  }
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const keys = Object.keys(parsed);
    for (const k of keys.slice(0, maxSymbols)) {
      const v = parsed[k];
      let sig;
      if (Array.isArray(v)) {
        sig = `[${v.length} items]`;
        if (v.length && v[0] && typeof v[0] === 'object') sig += ` keys: ${Object.keys(v[0]).slice(0, 8).join(',')}`;
      } else if (v && typeof v === 'object') sig = `{${Object.keys(v).length} keys}` + (k === 'scripts' ? `: ${Object.keys(v).slice(0, 12).join(', ')}` : '');
      else sig = trimSig(JSON.stringify(v), 50);
      const idx = findKeyLine(lines, k);
      syms.push({ name: k, kind: Array.isArray(v) ? 'array' : v && typeof v === 'object' ? 'object' : 'value', line: idx, sig });
    }
    return { symbols: syms, truncated: keys.length > maxSymbols, shape: 'object' };
  }
  if (Array.isArray(parsed)) {
    const first = parsed[0];
    syms.push({ name: '(root array)', kind: 'array', line: 1, sig: `[${parsed.length} items]` + (first && typeof first === 'object' ? ` keys: ${Object.keys(first).slice(0, 10).join(',')}` : '') });
    return { symbols: syms, truncated: false, shape: 'array' };
  }
  // Fallback: regex for 2-space-indented top-level keys.
  for (let i = 0; i < lines.length && syms.length < maxSymbols; i++) {
    const m = /^\s{1,4}"([^"]+)"\s*:/.exec(lines[i]);
    if (m) syms.push({ name: m[1], kind: 'key', line: i + 1, sig: '' });
  }
  return { symbols: syms, truncated: syms.length >= maxSymbols, shape: 'unknown' };
}

function findKeyLine(lines, key) {
  const needle = `"${key}"`;
  for (let i = 0; i < Math.min(lines.length, 20000); i++) if (lines[i].includes(needle) && /^\s{0,4}"/.test(lines[i])) return i + 1;
  return 1;
}

function stripJsonComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:"'\\])\/\/.*$/gm, '$1').replace(/,(\s*[}\]])/g, '$1');
}

// ---------------- HTML (and Vue / Svelte / Astro) ----------------
const SCRIPT_RE = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
const STYLE_RE = /<style\b([^>]*)>([\s\S]*?)<\/style\s*>/gi;

function lineIndexer(text) {
  // returns fn(offset) -> 1-based line, using a precomputed newline table (binary search)
  const nls = [];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) nls.push(i);
  return (off) => {
    let lo = 0, hi = nls.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (nls[mid] < off) lo = mid + 1; else hi = mid; }
    return lo + 1;
  };
}

function attr(attrs, name) {
  // whitespace before the name: data-src, data-type and data-id are different attributes
  const m = new RegExp(`(?:^|\\s)${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(attrs || '');
  return m ? (m[2] ?? m[3] ?? m[4]) : null;
}

// Only these `type` values are JavaScript; anything else (json, templates, shaders, importmap, babel/jsx, py...) is skipped.
const JS_TYPES = /^\s*(?:module|text\/javascript|application\/javascript|text\/ecmascript|application\/ecmascript|text\/jscript|application\/x-javascript|text\/x-javascript)\s*$/i;

/**
 * Sequential scan of an HTML document: script blocks with line numbers, and the HTML comment ranges
 * outside them. Comments are skipped whole, so a commented-out <script> is neither a block nor pairs
 * with a later real </script>; a <!-- inside script content is left to the script. Used by the outline,
 * the syntax checker and file_stats.
 */
function scanHtml(text) {
  const lineAt = lineIndexer(text);
  const blocks = [];
  const comments = [];
  const openRe = /<!--|<script\b/gi;
  const closeRe = /<\/script\s*>/gi;
  let pos = 0, n = 0;
  while (pos < text.length) {
    openRe.lastIndex = pos;
    const m = openRe.exec(text);
    if (!m) break;
    if (m[0] === '<!--') {
      const end = text.indexOf('-->', m.index + 4);
      const stop = end < 0 ? text.length : end + 3;
      comments.push([m.index, stop]);
      pos = stop;
      continue;
    }
    const tagEnd = text.indexOf('>', m.index);
    if (tagEnd < 0) break;
    const attrs = text.slice(m.index + 7, tagEnd);
    closeRe.lastIndex = tagEnd + 1;
    const cm = closeRe.exec(text);
    const contentStart = tagEnd + 1;
    const contentEnd = cm ? cm.index : text.length;
    const src = attr(attrs, 'src');
    const type = attr(attrs, 'type');
    const langAttr = attr(attrs, 'lang');
    n++;
    blocks.push({
      index: n,
      start: m.index,
      contentStart,
      contentEnd,
      startLine: lineAt(m.index),
      contentStartLine: lineAt(contentStart),
      endLine: lineAt(contentEnd),
      src, type, lang: langAttr,
      isModule: /^\s*module\s*$/i.test(type || ''),
      isJS: !src && (!type || JS_TYPES.test(type)) && !/^(ts|typescript|tsx|jsx|coffee|coffeescript)$/i.test(langAttr || ''),
      content: text.slice(contentStart, contentEnd),
      length: contentEnd - contentStart,
    });
    pos = cm ? cm.index + cm[0].length : text.length;
  }
  const inComment = (idx) => comments.some(([a, b]) => idx >= a && idx < b);
  return { blocks, comments, inComment };
}

/** Script blocks with line numbers (HTML comments skipped). */
function scriptBlocks(text) {
  return scanHtml(text).blocks;
}

function extractHTML(text, { maxSymbols = 400 } = {}) {
  const syms = [];
  const lineAt = lineIndexer(text);
  const { blocks, inComment } = scanHtml(text);
  let inlineJsSymbols = 0;
  const parsers = new Set();
  for (const b of blocks) {
    const desc = b.src ? `src=${trimSig(b.src, 60)}` : `inline ${b.length.toLocaleString('en-US')} chars, lines ${b.contentStartLine}-${b.endLine}`;
    syms.push({ name: `<script #${b.index}${b.type ? ` type=${b.type}` : ''}>`, kind: 'script', line: b.startLine, sig: desc });
    if (b.isJS && b.length > 0 && syms.length < maxSymbols) {
      let r = jsAst ? jsAst.outlineJS(b.content, { lineOffset: b.contentStartLine - 1, maxSymbols: maxSymbols - syms.length, module: b.isModule }) : null;
      if (!r || !r.symbols) r = extractJS(b.content.split(/\r?\n/), { lineOffset: b.contentStartLine - 1, maxSymbols: maxSymbols - syms.length });
      else parsers.add('acorn');
      for (const s of r.symbols) { syms.push(s); inlineJsSymbols++; }
    }
  }
  let m;
  STYLE_RE.lastIndex = 0;
  let sn = 0;
  while ((m = STYLE_RE.exec(text)) && syms.length < maxSymbols) {
    if (inComment(m.index) || blocks.some((b) => m.index >= b.contentStart && m.index < b.contentEnd)) continue;
    sn++;
    syms.push({ name: `<style #${sn}>`, kind: 'style', line: lineAt(m.index), sig: `${m[2].length.toLocaleString('en-US')} chars, lines ${lineAt(m.index)}-${lineAt(m.index + m[0].length)}` });
  }
  // ids on elements (outside scripts): cheap and very useful for DOM-heavy apps
  const ID_RE = /<([a-zA-Z][\w-]*)\b[^>]*?\sid\s*=\s*["']([^"']+)["']/g; // \sid: data-id is not an id
  let ids = 0;
  while ((m = ID_RE.exec(text)) && syms.length < maxSymbols) {
    if (inComment(m.index) || blocks.some((b) => m.index >= b.contentStart && m.index < b.contentEnd)) continue; // commented out or inside script content
    const ln = lineAt(m.index);
    syms.push({ name: `#${m[2]}`, kind: 'id', line: ln, sig: `<${m[1]}>` });
    ids++;
    if (ids > 300) break;
  }
  syms.sort((a, b) => a.line - b.line);
  return { symbols: syms, truncated: syms.length >= maxSymbols, scripts: blocks.length, ids, inlineJsSymbols, parser: parsers.has('acorn') ? 'acorn' : 'heuristic' };
}

// ---------------- CSS ----------------
function extractCSS(lines, { lineOffset = 0, maxSymbols = 300 } = {}) {
  const syms = [];
  let depth = 0;
  let rules = 0;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (l.length > 2000) continue;
    let m;
    if (depth === 0) {
      if ((m = /^\s*@(media|supports|container|layer)\s*([^{]*)\{?/.exec(l))) syms.push({ name: `@${m[1]} ${trimSig(m[2], 50)}`, kind: 'at-rule', line: i + 1 + lineOffset, sig: '' });
      else if ((m = /^\s*@keyframes\s+([\w-]+)/.exec(l))) syms.push({ name: `@keyframes ${m[1]}`, kind: 'keyframes', line: i + 1 + lineOffset, sig: '' });
      else if ((m = /^\s*@font-face/.exec(l))) syms.push({ name: '@font-face', kind: 'at-rule', line: i + 1 + lineOffset, sig: '' });
      else if ((m = /^\s*(:root|html|body)\b[^{]*\{/.exec(l))) syms.push({ name: m[1], kind: 'rule', line: i + 1 + lineOffset, sig: '' });
      else if (/\{/.test(l)) rules++;
    }
    for (const c of l) { if (c === '{') depth++; else if (c === '}') depth = Math.max(0, depth - 1); }
    if (syms.length >= maxSymbols) break;
  }
  return { symbols: syms, truncated: syms.length >= maxSymbols, rules };
}

/** Outline many Python files in one interpreter run so later outline() calls hit the cache. */
function primePython(files) {
  if (!pyAst || !files || !files.length || !pyAst.available()) return;
  try { pyAst.outlineBatch(files.filter((f) => fs.existsSync(f))); } catch { /* best effort */ }
}

/**
 * Main entry: outline for a file's text.
 * Returns { lang, symbols: [{name, kind, line, endLine?, sig, mods?, exported?}], parser, ... }
 * For callable kinds `sig` is the bare parameter list; `mods` holds modifiers (async, static, …).
 */
function outline(text, file, opts = {}) {
  const lang = opts.lang || detectLang(file) || 'text';
  const maxSymbols = opts.maxSymbols || 400;
  if (lang === 'html') return { lang, ...extractHTML(text, { maxSymbols }) };
  const lines = text.split(/\r?\n/);
  if (lang === 'js') {
    const r = jsAst ? jsAst.outlineJS(text, { maxSymbols, module: /\.mjs$/i.test(file || '') ? true : /\.cjs$/i.test(file || '') ? false : undefined }) : null;
    if (r && r.symbols) return { lang, ...r };
    return { lang, ...extractJS(lines, { lang, maxSymbols }), parser: 'heuristic', parseError: r ? r.error : null };
  }
  if (lang === 'ts') {
    const r = tsAst && file ? tsAst.outlineTS(text, file, { root: opts.root, maxSymbols }) : null;
    if (r && r.symbols) return { lang, ...r };
    return { lang, ...extractJS(lines, { lang, maxSymbols }), parser: 'heuristic' };
  }
  if (lang === 'python') {
    if (pyAst && file && fs.existsSync(file) && pyAst.available()) {
      const r = pyAst.outlineFile(file);
      if (r && r.symbols) return { lang, symbols: r.symbols, imports: r.imports, truncated: r.symbols.length >= maxSymbols, parser: 'python-ast' };
    }
    return { lang, ...extractPython(lines, { maxSymbols }), parser: 'heuristic' };
  }
  if (lang === 'markdown') return { lang, ...extractMarkdown(lines, { maxSymbols }) };
  if (lang === 'json') return { lang, ...extractJSON(text, lines, { maxSymbols }) };
  if (lang === 'css') return { lang, ...extractCSS(lines, { maxSymbols }) };
  if (GENERIC[lang]) return { lang, ...extractGeneric(lines, lang, { maxSymbols }) };
  return { lang, symbols: [], truncated: false };
}

/**
 * Find the end line of a symbol body starting at `startLine` (1-based) using bracket
 * matching for brace languages and indentation for Python/YAML. Returns 1-based end line.
 */
function symbolEnd(lines, startLine, lang, maxLines = 4000) {
  const i0 = startLine - 1;
  if (i0 < 0 || i0 >= lines.length) return startLine;
  if (lang === 'python' || lang === 'yaml') {
    const indent = lines[i0].match(/^\s*/)[0].length;
    let end = i0;
    for (let i = i0 + 1; i < lines.length && i - i0 < maxLines; i++) {
      const l = lines[i];
      if (!l.trim()) continue;
      const ind = l.match(/^\s*/)[0].length;
      if (ind <= indent) break;
      end = i;
    }
    return end + 1;
  }
  if (lang === 'markdown') {
    const m = /^(#{1,6})\s/.exec(lines[i0]);
    const level = m ? m[1].length : 6;
    for (let i = i0 + 1; i < lines.length && i - i0 < maxLines; i++) {
      const mm = /^(#{1,6})\s/.exec(lines[i]);
      if (mm && mm[1].length <= level) return i; // line before next heading
    }
    return Math.min(lines.length, i0 + maxLines);
  }
  // brace languages (also arrays/objects): match the first opening bracket after the start
  const st = { block: false, tpl: false, hashComments: lang === 'shell' || lang === 'powershell' || lang === 'ruby' || lang === 'r' };
  let depth = 0;
  let started = false;
  for (let i = i0; i < lines.length && i - i0 < maxLines; i++) {
    const code = lines[i].length > 5000 ? '' : codeOnly(lines[i], st);
    for (const c of code) {
      if (c === '{' || c === '[' || c === '(') { depth++; started = true; }
      else if (c === '}' || c === ']' || c === ')') depth--;
    }
    if (started && depth <= 0) return i + 1;
    if (!started && i > i0 + 2) return i0 + 1; // no body (e.g., one-line arrow function)
  }
  return Math.min(lines.length, i0 + maxLines);
}

module.exports = { detectLang, outline, primePython, scriptBlocks, scanHtml, symbolEnd, codeOnly, CODE_LANGS, LANG_BY_EXT, stripJsonComments, lineIndexer };
