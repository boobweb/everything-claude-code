'use strict';
// Exact Python symbols and syntax errors via the interpreter's own `ast` module.
// One python process can outline many files at once (repo_map primes the cache in a batch).
// Falls back to null (caller uses regex heuristics) when no Python 3 is available.

const proc = require('./proc');

const PY_SCRIPT = String.raw`
import ast, json, sys
try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass
def unparse(n):
    try:
        return ast.unparse(n)
    except Exception:
        return "..."
def sig(fn):
    a = fn.args
    names = [x.arg for x in getattr(a, "posonlyargs", []) + a.args]
    if a.vararg: names.append("*" + a.vararg.arg)
    names += [x.arg for x in a.kwonlyargs]
    if a.kwarg: names.append("**" + a.kwarg.arg)
    return ", ".join(names)
out = {}
for p in sys.argv[1:]:
    try:
        src = open(p, "rb").read()
        tree = ast.parse(src, p)
    except SyntaxError as e:
        out[p] = {"error": {"line": e.lineno or 0, "col": e.offset or 0, "message": "SyntaxError: " + str(e.msg)}}
        continue
    except Exception as e:
        out[p] = {"error": {"line": 0, "col": 0, "message": str(e)}}
        continue
    syms = []
    def walk(body, ctx, depth):
        for n in body:
            end = getattr(n, "end_lineno", n.lineno)
            if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef)):
                name = (ctx + "." + n.name) if ctx else n.name
                decos = ["@" + unparse(d) for d in n.decorator_list][:2]
                mods = (["async"] if isinstance(n, ast.AsyncFunctionDef) else []) + decos
                syms.append({"name": name, "kind": "method" if ctx else "function", "line": n.lineno, "endLine": end, "sig": sig(n), "mods": " ".join(mods)})
            elif isinstance(n, ast.ClassDef):
                bases = [unparse(b) for b in n.bases]
                cname = (ctx + "." + n.name) if ctx else n.name
                syms.append({"name": cname, "kind": "class", "line": n.lineno, "endLine": end, "sig": ("(" + ", ".join(bases) + ")") if bases else ""})
                walk(n.body, cname, depth + 1)
            elif depth == 0 and isinstance(n, (ast.Assign, ast.AnnAssign)):
                targets = n.targets if isinstance(n, ast.Assign) else [n.target]
                v = n.value
                for t in targets:
                    if not isinstance(t, ast.Name) or v is None:
                        continue
                    if isinstance(v, (ast.List, ast.Tuple)):
                        kind, s = "array", "%d items" % len(v.elts)
                    elif isinstance(v, ast.Dict):
                        kind, s = "object", "%d keys" % len(v.keys)
                    elif isinstance(v, ast.Constant) and isinstance(v.value, str) and len(v.value) > 1000:
                        kind, s = "const", "blob %d chars" % len(v.value)
                    elif t.id.isupper():
                        kind, s = "const", ("= " + repr(v.value)[:24]) if isinstance(v, ast.Constant) else unparse(v)[:30]
                    elif isinstance(v, ast.Call):
                        kind, s = "state", "= " + unparse(v.func)[:30] + "(...)"
                    else:
                        continue
                    syms.append({"name": t.id, "kind": kind, "line": n.lineno, "endLine": end, "sig": s})
            elif depth == 0 and isinstance(n, ast.If) and "__main__" in unparse(n.test):
                syms.append({"name": "__main__", "kind": "boot", "line": n.lineno, "endLine": end, "sig": ""})
    walk(tree.body, "", 0)
    imports = sum(1 for n in tree.body if isinstance(n, (ast.Import, ast.ImportFrom)))
    out[p] = {"symbols": syms, "imports": imports}
json.dump(out, sys.stdout)
`;

const cache = new Map(); // abs -> { mtimeMs, result }

function available() { return !!proc.pythonCmd(); }

/** Outline several files in one interpreter run. Returns Map(abs -> {symbols, imports} | {error}). */
function outlineBatch(files, { timeout = 30000 } = {}) {
  const py = proc.pythonCmd();
  const out = new Map();
  if (!py || !files.length) return out;
  const fs = require('fs');
  const todo = [];
  for (const f of files) {
    let st; try { st = fs.statSync(f); } catch { continue; }
    const c = cache.get(f);
    if (c && c.mtimeMs === st.mtimeMs) out.set(f, c.result); else todo.push({ f, mtimeMs: st.mtimeMs });
  }
  for (let i = 0; i < todo.length; i += 40) {
    const chunk = todo.slice(i, i + 40);
    const r = proc.run(py.cmd, [...py.pre, '-c', PY_SCRIPT, ...chunk.map((x) => x.f)], { timeout });
    if (r.error || r.status !== 0) continue;
    let parsed; try { parsed = JSON.parse(r.stdout); } catch { continue; }
    for (const x of chunk) { const res = parsed[x.f]; if (res) { cache.set(x.f, { mtimeMs: x.mtimeMs, result: res }); out.set(x.f, res); } }
    if (cache.size > 500) cache.delete(cache.keys().next().value);
  }
  return out;
}

function outlineFile(abs) {
  const m = outlineBatch([abs]);
  return m.get(abs) || null;
}

module.exports = { available, outlineBatch, outlineFile };
