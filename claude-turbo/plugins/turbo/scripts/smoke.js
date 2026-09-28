#!/usr/bin/env node
'use strict';
// Headless browser smoke test for any web app (static folder or running URL).
// Loads the page in Chromium (Playwright), waits for it to become interactive, collects
// console errors, uncaught exceptions and failed requests, takes a screenshot, and exits
// non-zero when something is wrong. Catches "loading hangs" and boot-time crashes that
// static checks cannot see.
//
// Usage:
//   node smoke.js --dir . [--file index.html] [--wait-hidden "#loading-overlay"] [--click "#start"]
//   node smoke.js --url http://localhost:8000/ [--wait-visible ".app"] [--mobile] [--json]
// Exit codes: 0 ok · 1 problems found · 2 usage error · 3 Playwright not installed

const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawnSync } = require('child_process');

function parseArgs(argv) {
  const a = { clicks: [], ignore: [], timeout: 30000, settle: 1000, file: 'index.html', viewport: '1280x800' };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const next = () => argv[++i];
    switch (k) {
      case '--url': a.url = next(); break;
      case '--dir': a.dir = next(); break;
      case '--file': a.file = next(); break;
      case '--port': a.port = Number(next()); break;
      case '--wait-hidden': a.waitHidden = next(); break;
      case '--wait-visible': a.waitVisible = next(); break;
      case '--wait-text': a.waitText = next(); break;
      case '--timeout': a.timeout = Number(next()); break;
      case '--settle': a.settle = Number(next()); break;
      case '--screenshot': a.screenshot = next(); break;
      case '--viewport': a.viewport = next(); break;
      case '--mobile': a.viewport = '390x844'; a.mobile = true; break;
      case '--click': a.clicks.push(next()); break;
      case '--ignore': a.ignore.push(new RegExp(next(), 'i')); break;
      case '--allow-console-errors': a.allowConsoleErrors = true; break;
      case '--allow-request-failures': a.allowRequestFailures = true; break;
      case '--json': a.json = true; break;
      case '--headed': a.headed = true; break;
      case '-h': case '--help': a.help = true; break;
      default: if (!a.url && !a.dir && !k.startsWith('-')) { if (/^https?:/.test(k)) a.url = k; else a.dir = k; } else { console.error(`Unknown argument: ${k}`); process.exit(2); }
    }
  }
  return a;
}

const MIME = { '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.ico': 'image/x-icon', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.mp4': 'video/mp4', '.webm': 'video/webm', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.txt': 'text/plain', '.wasm': 'application/wasm', '.map': 'application/json' };

function serveStatic(dir, port) {
  return new Promise((resolve, reject) => {
    const root = path.resolve(dir);
    const server = http.createServer((req, res) => {
      try {
        let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
        if (p.endsWith('/')) p += 'index.html';
        // Stay inside the served folder: after decoding, /%2e%2e%2f.. becomes /../.., and a bare string-prefix test would
        // accept a sibling folder whose name merely starts with the root's name. path.relative is the real boundary test.
        const abs = path.resolve(root, '.' + (p.startsWith('/') ? p : '/' + p));
        const rel = path.relative(root, abs);
        if (p.includes('\0') || rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) { res.writeHead(403); res.end(); return; }
        fs.stat(abs, (err, st) => {
          if (err || !st.isFile()) { res.writeHead(404); res.end('not found'); return; }
          res.writeHead(200, { 'Content-Type': MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream', 'Content-Length': st.size, 'Cache-Control': 'no-store' });
          fs.createReadStream(abs).pipe(res);
        });
      } catch { res.writeHead(500); res.end(); }
    });
    server.on('error', reject);
    server.listen(port || 0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

function findPlaywright() {
  const candidates = [process.cwd(), process.env.CLAUDE_PROJECT_DIR, __dirname];
  try {
    const r = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['root', '-g'], { encoding: 'utf8', timeout: 15000, shell: process.platform === 'win32', windowsHide: true });
    if (r.status === 0 && r.stdout.trim()) candidates.push(r.stdout.trim());
  } catch { /* ignore */ }
  for (const base of candidates.filter(Boolean)) {
    try { return require(require.resolve('playwright', { paths: [base] })); } catch { /* next */ }
  }
  return null;
}

async function main() {
  const a = parseArgs(process.argv.slice(2));
  if (a.help || (!a.url && !a.dir)) {
    console.log('Usage: node smoke.js (--dir <folder> [--file index.html] | --url <http://...>) [--wait-hidden <sel>] [--wait-visible <sel>] [--wait-text <text>] [--click <sel>]... [--timeout ms] [--settle ms] [--viewport WxH | --mobile] [--screenshot <file>] [--ignore <regex>]... [--allow-console-errors] [--allow-request-failures] [--json]');
    process.exit(a.help ? 0 : 2);
  }
  const pw = findPlaywright();
  if (!pw) {
    const sep = process.platform === 'win32' ? ';' : '&&';
    console.error(`Playwright is not installed. Install once with:\n  npm install -g playwright ${sep} npx playwright install chromium\n(or in the project: npm i -D playwright ${sep} npx playwright install chromium)`);
    process.exit(3);
  }
  let server = null;
  let url = a.url;
  if (!url) {
    if (!fs.existsSync(path.join(a.dir, a.file))) { console.error(`No ${a.file} in ${path.resolve(a.dir)} (use --file to pick the entry page)`); process.exit(2); }
    const s = await serveStatic(a.dir, a.port);
    server = s.server;
    url = `http://127.0.0.1:${s.port}/${a.file.replace(/\\/g, '/')}`;
  }
  const [vw, vh] = a.viewport.split('x').map(Number);
  const report = { url, ok: true, timing: {}, console: [], pageErrors: [], requestFailures: [], httpErrors: [], waits: [], clicks: [], screenshot: null, title: null, finalUrl: null };
  const ignored = (txt) => a.ignore.some((re) => re.test(txt));
  const browser = await pw.chromium.launch({ headless: !a.headed });
  const t0 = Date.now();
  try {
    const context = await browser.newContext({ viewport: { width: vw || 1280, height: vh || 800 }, isMobile: !!a.mobile, hasTouch: !!a.mobile, deviceScaleFactor: a.mobile ? 2 : 1 });
    const page = await context.newPage();
    page.on('console', (msg) => {
      const type = msg.type();
      if (type === 'error' || type === 'warning') {
        const text = msg.text();
        if (ignored(text)) return;
        const loc = msg.location();
        report.console.push({ type, text: text.slice(0, 500), location: loc && loc.url ? `${loc.url.split('/').pop()}:${loc.lineNumber + 1}` : null });
      }
    });
    page.on('pageerror', (err) => { const text = String(err && err.message || err); if (!ignored(text)) report.pageErrors.push({ text: text.slice(0, 500), stack: String(err && err.stack || '').split('\n').slice(0, 4).join(' | ') }); });
    page.on('requestfailed', (req) => { const f = req.failure(); const text = `${req.method()} ${req.url()} ${f ? f.errorText : ''}`; if (!ignored(text)) report.requestFailures.push(text.slice(0, 300)); });
    page.on('response', (res) => { if (res.status() >= 400) { const text = `${res.status()} ${res.url()}`; if (!ignored(text)) report.httpErrors.push(text.slice(0, 300)); } });

    const nav0 = Date.now();
    await page.goto(url, { waitUntil: 'load', timeout: a.timeout });
    report.timing.loadEventMs = Date.now() - nav0;
    try {
      const t = await page.evaluate(() => { const n = performance.getEntriesByType('navigation')[0]; return n ? { domContentLoaded: Math.round(n.domContentLoadedEventEnd), load: Math.round(n.loadEventEnd), transferKB: Math.round((n.transferSize || 0) / 1024) } : null; });
      if (t) Object.assign(report.timing, t);
    } catch { /* ignore */ }
    const waitOne = async (label, fn) => {
      const w0 = Date.now();
      try { await fn(); report.waits.push({ label, ok: true, ms: Date.now() - w0 }); }
      catch (e) { report.waits.push({ label, ok: false, ms: Date.now() - w0, error: String(e.message || e).split('\n')[0] }); report.ok = false; }
    };
    if (a.waitHidden) await waitOne(`hidden: ${a.waitHidden}`, () => page.waitForSelector(a.waitHidden, { state: 'hidden', timeout: a.timeout }));
    if (a.waitVisible) await waitOne(`visible: ${a.waitVisible}`, () => page.waitForSelector(a.waitVisible, { state: 'visible', timeout: a.timeout }));
    if (a.waitText) await waitOne(`text: ${a.waitText}`, () => page.getByText(a.waitText).first().waitFor({ state: 'visible', timeout: a.timeout }));
    report.timing.interactiveMs = Date.now() - nav0;
    if (a.settle > 0) await page.waitForTimeout(a.settle);
    for (const sel of a.clicks) {
      const c0 = Date.now();
      try { await page.click(sel, { timeout: Math.min(a.timeout, 10000) }); await page.waitForTimeout(400); report.clicks.push({ selector: sel, ok: true, ms: Date.now() - c0 }); }
      catch (e) { report.clicks.push({ selector: sel, ok: false, error: String(e.message || e).split('\n')[0] }); report.ok = false; }
    }
    report.title = await page.title();
    report.finalUrl = page.url();
    try {
      const vis = await page.evaluate(() => {
        const body = document.body; const rect = body ? body.getBoundingClientRect() : null;
        const overflowX = document.documentElement.scrollWidth > window.innerWidth + 1;
        const overflowY = document.documentElement.scrollHeight > window.innerHeight + 1;
        return { bodyText: (body && body.innerText || '').trim().slice(0, 160), elements: document.querySelectorAll('*').length, overflowX, overflowY, bodyHeight: rect ? Math.round(rect.height) : null };
      });
      report.dom = vis;
    } catch { /* ignore */ }
    const shot = a.screenshot || path.join(process.env.CLAUDE_PLUGIN_DATA || require('os').tmpdir(), 'turbo-smoke.png');
    try { fs.mkdirSync(path.dirname(shot), { recursive: true }); await page.screenshot({ path: shot, fullPage: false }); report.screenshot = shot; } catch (e) { report.screenshotError = String(e.message || e); }
  } catch (e) {
    report.ok = false;
    report.fatal = String(e && e.message || e).split('\n')[0];
  } finally {
    await browser.close().catch(() => {});
    if (server) server.close();
  }
  report.timing.totalMs = Date.now() - t0;
  const consoleErrors = report.console.filter((c) => c.type === 'error');
  if (report.pageErrors.length) report.ok = false;
  if (consoleErrors.length && !a.allowConsoleErrors) report.ok = false;
  if ((report.requestFailures.length || report.httpErrors.length) && !a.allowRequestFailures) report.ok = false;

  if (a.json) console.log(JSON.stringify(report, null, 2));
  else {
    const L = [];
    L.push(`${report.ok ? 'PASS' : 'FAIL'}  ${report.url}${report.title ? `  "${report.title}"` : ''}`);
    if (report.fatal) L.push(`  fatal: ${report.fatal}`);
    L.push(`  timing: load event ${report.timing.loadEventMs}ms${report.timing.domContentLoaded != null ? `, DOMContentLoaded ${report.timing.domContentLoaded}ms` : ''}${report.timing.transferKB ? `, transfer ${report.timing.transferKB}KB` : ''}, interactive ${report.timing.interactiveMs}ms, total ${report.timing.totalMs}ms`);
    for (const w of report.waits) L.push(`  wait ${w.ok ? 'ok  ' : 'FAIL'} ${w.label} (${w.ms}ms)${w.error ? `: ${w.error}` : ''}`);
    for (const c of report.clicks) L.push(`  click ${c.ok ? 'ok  ' : 'FAIL'} ${c.selector}${c.error ? `: ${c.error}` : ''}`);
    L.push(`  uncaught exceptions: ${report.pageErrors.length}`); for (const e of report.pageErrors.slice(0, 10)) L.push(`    - ${e.text}${e.stack ? `  [${e.stack}]` : ''}`);
    L.push(`  console errors: ${consoleErrors.length}, warnings: ${report.console.length - consoleErrors.length}`); for (const c of report.console.slice(0, 15)) L.push(`    - [${c.type}] ${c.text}${c.location ? `  (${c.location})` : ''}`);
    L.push(`  failed requests: ${report.requestFailures.length}, HTTP >= 400: ${report.httpErrors.length}`); for (const r of [...report.requestFailures, ...report.httpErrors].slice(0, 15)) L.push(`    - ${r}`);
    if (report.dom) L.push(`  dom: ${report.dom.elements} elements${report.dom.overflowX ? ', HORIZONTAL OVERFLOW (page wider than viewport)' : ''}${report.dom.overflowY ? ', vertical scroll present' : ''}; visible text starts: "${report.dom.bodyText.replace(/\s+/g, ' ')}"`);
    if (report.screenshot) L.push(`  screenshot: ${report.screenshot}`);
    console.log(L.join('\n'));
  }
  process.exit(report.ok ? 0 : 1);
}

if (require.main === module) main().catch((e) => { console.error('smoke failed:', e && e.stack || e); process.exit(1); });

module.exports = { serveStatic };
