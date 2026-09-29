'use strict';
// Minimal MCP stdio client used by the tests (and handy for manual poking):
//   node tests/mcp-client.js <server.js> <projectRoot> '[["repo_map",{}],["search",{"pattern":"foo"}]]'

const { spawn } = require('child_process');

function connect(serverPath, root, { env = {} } = {}) {
  const p = spawn(process.execPath, [serverPath], { env: { ...process.env, CLAUDE_PROJECT_DIR: root, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
  let buf = '';
  let stderr = '';
  const pending = new Map();
  let id = 0;
  const inbound = [];
  p.stderr.on('data', (d) => { stderr += d; });
  p.stdout.on('data', (d) => {
    buf += d;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      let m;
      try { m = JSON.parse(line); } catch (e) { inbound.push({ parseError: line }); continue; }
      if (m.method === 'roots/list') {
        p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { roots: [{ uri: 'file://' + root.replace(/\\/g, '/'), name: 'root' }] } }) + '\n');
        inbound.push({ rootsRequested: true });
        continue;
      }
      if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } else inbound.push(m);
    }
  });
  const send = (method, params) => new Promise((resolve, reject) => {
    const i = ++id;
    const t = setTimeout(() => { pending.delete(i); reject(new Error(`timeout waiting for ${method}`)); }, 60000);
    pending.set(i, (m) => { clearTimeout(t); resolve(m); });
    p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: i, method, params }) + '\n');
  });
  const notify = (method, params) => p.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, ...(params ? { params } : {}) }) + '\n');
  const raw = (line) => p.stdin.write(line + '\n');
  const close = () => new Promise((res) => { p.on('exit', (code) => res(code)); p.stdin.end(); setTimeout(() => { try { p.kill(); } catch { /* */ } res(null); }, 3000); });
  return { p, send, notify, raw, close, inbound, stderr: () => stderr };
}

async function initialize(c) {
  const init = await c.send('initialize', { protocolVersion: '2025-06-18', capabilities: { roots: { listChanged: true } }, clientInfo: { name: 'turbo-tests', version: '1' } });
  c.notify('notifications/initialized');
  return init;
}

async function call(c, name, args) {
  const r = await c.send('tools/call', { name, arguments: args || {} });
  if (r.error) return { error: r.error, text: JSON.stringify(r.error), isError: true };
  return { text: r.result.content.map((x) => x.text).join('\n'), isError: !!r.result.isError, result: r.result };
}

module.exports = { connect, initialize, call };

if (require.main === module) {
  (async () => {
    const [server, root, callsJson] = process.argv.slice(2);
    const c = connect(server, root);
    const init = await initialize(c);
    console.log('INIT', JSON.stringify(init.result || init.error).slice(0, 400));
    const tl = await c.send('tools/list', {});
    console.log('TOOLS', tl.result.tools.map((t) => t.name).join(', '));
    for (const [name, args] of JSON.parse(callsJson || '[]')) {
      const t0 = Date.now();
      const r = await call(c, name, args);
      console.log(`\n===== ${name} ${JSON.stringify(args)} (${Date.now() - t0}ms, ${r.text.length} chars, isError=${r.isError})\n${r.text.slice(0, Number(process.env.SHOW || 3000))}`);
    }
    await c.close();
    if (c.stderr()) console.log('\nSTDERR:', c.stderr());
  })().catch((e) => { console.error(e); process.exit(1); });
}
