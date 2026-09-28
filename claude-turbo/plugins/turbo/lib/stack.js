'use strict';
// Detect what kind of project this is from files at the root. Cheap, no scanning.

const fs = require('fs');
const path = require('path');
const fsx = require('./fsx');

function readJSON(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

function detect(root) {
  const has = (n) => fsx.exists(path.join(root, n));
  const parts = [];
  const commands = [];
  const pkg = has('package.json') ? readJSON(path.join(root, 'package.json')) : null;
  if (pkg) {
    const scripts = pkg.scripts ? Object.keys(pkg.scripts) : [];
    const mgr = has('pnpm-lock.yaml') ? 'pnpm' : has('yarn.lock') ? 'yarn' : has('bun.lockb') || has('bun.lock') ? 'bun' : 'npm';
    const deps = Object.keys(pkg.dependencies || {});
    const dev = Object.keys(pkg.devDependencies || {});
    const fw = ['next', 'react', 'vue', 'svelte', 'angular', '@angular/core', 'express', 'fastify', 'nuxt', 'astro', 'vite', 'electron', 'phaser', 'three', 'pixi.js'].filter((d) => deps.includes(d) || dev.includes(d));
    parts.push(`node/${mgr}${pkg.name ? ` "${pkg.name}"` : ''}${pkg.type === 'module' ? ' (ESM)' : ''}${fw.length ? ` [${fw.join(', ')}]` : ''}${scripts.length ? ` scripts: ${scripts.slice(0, 14).join(', ')}` : ''}`);
    for (const s of ['test', 'lint', 'build', 'typecheck', 'check']) if (scripts.includes(s)) commands.push(`${mgr} ${mgr === 'npm' ? 'run ' : ''}${s}`.replace('npm run test', 'npm test'));
    if (has('tsconfig.json')) parts.push('typescript');
  }
  if (has('pyproject.toml') || has('requirements.txt') || has('setup.py') || has('Pipfile')) {
    const tools = ['pyproject.toml', 'requirements.txt', 'setup.py', 'Pipfile', 'poetry.lock', 'uv.lock'].filter(has);
    parts.push(`python (${tools.join(', ')})`);
    if (has('pytest.ini') || has('tests') || has('test')) commands.push('pytest');
  }
  if (has('go.mod')) { parts.push('go'); commands.push('go build ./...', 'go test ./...'); }
  if (has('Cargo.toml')) { parts.push('rust'); commands.push('cargo build', 'cargo test'); }
  if (has('pom.xml')) { parts.push('java/maven'); commands.push('mvn test'); }
  if (has('build.gradle') || has('build.gradle.kts')) { parts.push('java/gradle'); commands.push('gradle test'); }
  if (has('composer.json')) parts.push('php/composer');
  if (has('Gemfile')) parts.push('ruby/bundler');
  if (has('mix.exs')) parts.push('elixir');
  if (has('Makefile')) { parts.push('make'); commands.push('make'); }
  if (has('Dockerfile') || has('docker-compose.yml') || has('compose.yaml')) parts.push('docker');
  try {
    const names = fs.readdirSync(root);
    if (names.some((n) => /\.(sln|csproj|fsproj)$/i.test(n))) { parts.push('.NET'); commands.push('dotnet build', 'dotnet test'); }
    if (names.some((n) => /\.(xcodeproj|xcworkspace)$/i.test(n)) || has('Package.swift')) parts.push('swift/xcode');
    if (names.some((n) => /\.ps1$/i.test(n))) parts.push('powershell scripts');
    const htmls = names.filter((n) => /\.html?$/i.test(n));
    if (htmls.length) {
      const big = htmls.map((n) => ({ n, s: (fsx.statSafe(path.join(root, n)) || {}).size || 0 })).sort((a, b) => b.s - a.s)[0];
      parts.push(`static html (${htmls.length} page${htmls.length === 1 ? '' : 's'}${big && big.s > 200 * 1024 ? `, largest ${big.n} ${fsx.humanSize(big.s)}` : ''})`);
    }
  } catch { /* ignore */ }
  if (has('netlify.toml') || has('_redirects')) parts.push('netlify');
  if (has('vercel.json')) parts.push('vercel');
  if (has('wrangler.toml')) parts.push('cloudflare');
  const claudeBits = [];
  if (has('CLAUDE.md')) claudeBits.push('CLAUDE.md');
  if (has(path.join('.claude', 'CLAUDE.md'))) claudeBits.push('.claude/CLAUDE.md');
  if (has(path.join('.claude', 'settings.json'))) claudeBits.push('.claude/settings.json');
  if (has(path.join('.claude', 'skills'))) claudeBits.push('.claude/skills');
  if (has(path.join('.claude', 'agents'))) claudeBits.push('.claude/agents');
  if (has(path.join('.claude', 'rules'))) claudeBits.push('.claude/rules');
  if (has('.mcp.json')) claudeBits.push('.mcp.json');
  if (has('AGENTS.md')) claudeBits.push('AGENTS.md');
  return { summary: parts.length ? parts.join('; ') : 'no manifest detected (plain files)', commands: [...new Set(commands)], claude: claudeBits, pkg };
}

module.exports = { detect };
