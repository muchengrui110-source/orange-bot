#!/usr/bin/env node
// build-plugin.cjs —— 从「正在用的源码」生成一份可公开分发的插件目录
//
// 做的事：复制底座资源（图标 / LICENSE / locale / scripts）→ 按映射表改写代码里
// 写死的个人路径和私人字符串 → 写 package.json → 兜底检查剩余敏感串。
//
// 用法：
//   node build-plugin.cjs --src <源码目录> --base <底座资源目录> --out <输出目录> \
//        --version 1.2.3 --map redact-map.json [--dry]
//
// 映射表（redact-map.json，不进仓库；模板见 redact-map.example.json）：
//   replace: [{ from, to, label?, count? }]   count 缺省 1 = 必须正好命中 1 次；0 = 允许没有
//   regex:   [{ pattern, flags?, to, label? }]
//   forbidden: ["...", "..."]                 兜底：改写后仍出现就报错退出
'use strict';

const fs = require('fs');
const path = require('path');

function parseArgs(argv) {
  const out = { dry: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry') { out.dry = true; continue; }
    const key = a.replace(/^--/, '');
    out[key] = argv[++i];
  }
  return out;
}

const args = parseArgs(process.argv);
const required = ['src', 'base', 'out', 'version', 'map'];
for (const k of required) {
  if (!args[k]) {
    console.error(`缺少 --${k}；用法见文件头注释`);
    process.exit(2);
  }
}

const SRC = path.resolve(args.src);
const BASE = path.resolve(args.base);
const OUT = path.resolve(args.out);
const VERSION = args.version;
const MAP = JSON.parse(fs.readFileSync(path.resolve(args.map), 'utf8'));

function rmrf(p) { if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true }); }
function cp(src, dst) {
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
}
function copyTree(src, dst) {
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) copyTree(s, d);
    else cp(s, d);
  }
}

function applyReplace(text, rule) {
  const { from, to, label = from.slice(0, 40), count } = rule;
  const expected = count === undefined ? 1 : count;
  const n = text.split(from).length - 1;
  if (n !== expected) {
    throw new Error(`[${label}] 期望命中 ${expected} 处，实际 ${n}`);
  }
  if (n > 0) console.log(`[ok] ${label}`);
  return text.split(from).join(to);
}

function applyRegex(text, rule) {
  const { pattern, flags = 'g', to, label = pattern } = rule;
  const re = new RegExp(pattern, flags);
  const n = (text.match(re) || []).length;
  if (n === 0) throw new Error(`[${label}] 正则没有命中`);
  console.log(`[ok] ${label}（${n} 处）`);
  return text.replace(re, to);
}

function sanitize(text) {
  let s = text;
  for (const rule of MAP.replace || []) s = applyReplace(s, rule);
  for (const rule of MAP.regex || []) s = applyRegex(s, rule);
  for (const b of MAP.forbidden || []) {
    if (s.includes(b)) throw new Error(`脱敏失败，仍然包含 ${b}`);
  }
  return s;
}

if (!fs.existsSync(SRC)) throw new Error('源码目录不存在: ' + SRC);
if (!fs.existsSync(BASE)) throw new Error('底座目录不存在: ' + BASE);

if (args.dry) {
  console.log('[dry] 只检查映射表能不能命中，不写任何文件');
  const idx = path.join(SRC, 'lib', 'index.js');
  sanitize(fs.readFileSync(idx, 'utf8'));
  console.log('[dry] OK');
  process.exit(0);
}

rmrf(OUT);
fs.mkdirSync(OUT, { recursive: true });

// 1) 底座资源：目录整体复制，文件单独复制
const resources = MAP.resources || ['icon.svg', 'LICENSE', 'locale', 'scripts'];
for (const name of resources) {
  const s = path.join(BASE, name);
  if (!fs.existsSync(s)) throw new Error('缺少底座资源: ' + s);
  if (fs.statSync(s).isDirectory()) copyTree(s, path.join(OUT, name));
  else cp(s, path.join(OUT, name));
}
console.log('[ok] 底座资源: ' + resources.join(', '));

// 2) 代码
const libDir = path.join(SRC, 'lib');
const codeFiles = (MAP.codeFiles || ['index.js', 'client.js']);
fs.mkdirSync(path.join(OUT, 'lib'), { recursive: true });
for (const name of codeFiles) {
  const from = path.join(libDir, name);
  if (!fs.existsSync(from)) { console.warn('[skip] 没有 ' + name); continue; }
  const out = sanitize(fs.readFileSync(from, 'utf8'));
  fs.writeFileSync(path.join(OUT, 'lib', name), out, 'utf8');
  console.log('[ok] lib/' + name);
}

// 3) 其余原样复制的文件（patch、README 之类）
for (const name of MAP.copy || ['cordis.patch.yml', 'README.md']) {
  const from = path.join(SRC, name);
  if (fs.existsSync(from)) cp(from, path.join(OUT, name));
}

// 4) package.json
const pkgPath = path.join(SRC, 'package.json');
if (!fs.existsSync(pkgPath)) throw new Error('源码里没有 package.json');
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
pkg.version = VERSION;
if (MAP.description) pkg.description = MAP.description;
if (MAP.files) pkg.files = MAP.files;
fs.writeFileSync(path.join(OUT, 'package.json'), JSON.stringify(pkg, null, 2) + '\n', 'utf8');
console.log('[ok] package.json v' + VERSION);

// 5) 兜底：输出目录里再扫一遍 forbidden
let leaked = 0;
function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { walk(p); continue; }
    const ext = path.extname(e.name).toLowerCase();
    if (!['.js', '.mjs', '.cjs', '.json', '.md', '.yml', '.yaml', '.svg', '.ps1'].includes(ext)) continue;
    const t = fs.readFileSync(p, 'utf8');
    for (const b of MAP.forbidden || []) {
      if (t.includes(b)) { console.error(`[泄漏] ${p} 含 ${b}`); leaked++; }
    }
  }
}
walk(OUT);
if (leaked > 0) { console.error(`done 但有 ${leaked} 处泄漏 -> ${OUT}`); process.exit(1); }
console.log('done -> ' + OUT);
