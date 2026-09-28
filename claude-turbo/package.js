#!/usr/bin/env node
'use strict';
// Builds the distributable kit: dist/turbo-<version>.zip containing everything a user needs
// (installer, plugin, tests, docs) and nothing else (no .git, node_modules, eval results,
// quarantine folders, dist). Zero dependencies: the zip writer below uses zlib's raw deflate.
//   node package.js [--out <file>]

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = __dirname;
const version = JSON.parse(fs.readFileSync(path.join(ROOT, 'plugins', 'turbo', '.claude-plugin', 'plugin.json'), 'utf8')).version;
const outArg = process.argv.indexOf('--out');
const OUT = outArg >= 0 ? path.resolve(process.argv[outArg + 1]) : path.join(ROOT, 'dist', `turbo-${version}.zip`);
const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'results', '_turbo-quarantine', '.claude']);
const SKIP_FILES = /(^|[\\/])(\.DS_Store|Thumbs\.db|.*\.log)$/;

// ---- CRC-32 ----
const CRC_TABLE = new Int32Array(256);
for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; CRC_TABLE[n] = c; }
function crc32(buf) { let c = -1; for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8); return (c ^ -1) >>> 0; }

function dosDateTime(d) {
  const time = ((d.getHours() & 31) << 11) | ((d.getMinutes() & 63) << 5) | ((d.getSeconds() >> 1) & 31);
  const date = (((d.getFullYear() - 1980) & 127) << 9) | (((d.getMonth() + 1) & 15) << 5) | (d.getDate() & 31);
  return { time, date };
}

function listFiles(dir, rel, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const abs = path.join(dir, e.name);
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) listFiles(abs, r, out); }
    else if (e.isFile() && !SKIP_FILES.test(r)) out.push({ abs, rel: r });
  }
  return out;
}

function buildZip(files, prefix) {
  const locals = [], centrals = [];
  let offset = 0;
  const now = dosDateTime(new Date());
  for (const f of files) {
    const data = fs.readFileSync(f.abs);
    const name = Buffer.from(`${prefix}/${f.rel}`, 'utf8');
    const crc = crc32(data);
    const deflated = zlib.deflateRawSync(data, { level: 9 });
    const useDeflate = deflated.length < data.length;
    const body = useDeflate ? deflated : data;
    const method = useDeflate ? 8 : 0;
    const isExec = /\.(sh)$/.test(f.rel) || /^install\.sh$/.test(f.rel);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(method, 8);
    local.writeUInt16LE(now.time, 10); local.writeUInt16LE(now.date, 12); local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(name.length, 26); local.writeUInt16LE(0, 28);
    locals.push(local, name, body);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(0x031e, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10); central.writeUInt16LE(now.time, 12); central.writeUInt16LE(now.date, 14); central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30); central.writeUInt16LE(0, 32); central.writeUInt16LE(0, 34); central.writeUInt16LE(0, 36);
    central.writeUInt32LE(((isExec ? 0o100755 : 0o100644) << 16) >>> 0, 38); central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += local.length + name.length + body.length;
  }
  const cdSize = centrals.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(0, 4); end.writeUInt16LE(0, 6); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cdSize, 12); end.writeUInt32LE(offset, 16); end.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, ...centrals, end]);
}

const files = listFiles(ROOT, '', []).filter((f) => f.rel !== 'package.js' || true);
const zip = buildZip(files, `claude-turbo-${version}`);
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, zip);
const total = files.reduce((n, f) => n + fs.statSync(f.abs).size, 0);
console.log(`${OUT}: ${files.length} files, ${(total / 1024).toFixed(0)}KB -> ${(zip.length / 1024).toFixed(0)}KB`);
