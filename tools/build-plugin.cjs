#!/usr/bin/env node
// build-plugin.cjs —— 从本机已跑通的插件源码生成可公开分发的插件包。
// 三步（与旧版一致）：
//   1) 复制底座资源（icon.svg / LICENSE / locale / scripts）
//   2) 取源码 lib/index.js、lib/client.js，把个人安装路径换成 <DSH_HOME>/qq-bridge 相对路径
//   3) 拷 cordis.patch.yml、写 package.json、检查关键文件
//
// 用法:
//   node build-plugin.cjs --src <插件源码目录> --out <输出目录> [--base <底座资源目录>]
//        [--version x.y.z] [--legacy-root <源码里的旧安装根目录>] [--patterns <脱敏名单>]
//   --base 默认等于 --src；--version 默认取源码 package.json 的 version。
//   参数也可用环境变量（参数优先）：
//     BUILD_PLUGIN_SRC / BUILD_PLUGIN_OUT / BUILD_PLUGIN_BASE / BUILD_PLUGIN_VERSION /
//     BUILD_PLUGIN_LEGACY_ROOT / BUILD_PLUGIN_PATTERNS
//   注：--legacy-root 是源码那台机器上的安装根目录（形如 D:\tools\napcat），
//       脚本把它替换成可移植路径；默认 D:\tools\napcat，对不上时按实际传。
'use strict';

const fs = require('fs');
const path = require('path');

function printUsage() {
  console.error('用法: node build-plugin.cjs --src <插件源码目录> --out <输出目录> [--base <底座资源目录>] [--version x.y.z] [--legacy-root <旧安装根目录>] [--patterns <脱敏名单>]');
  console.error('环境变量: BUILD_PLUGIN_SRC / BUILD_PLUGIN_OUT / BUILD_PLUGIN_BASE / BUILD_PLUGIN_VERSION / BUILD_PLUGIN_LEGACY_ROOT / BUILD_PLUGIN_PATTERNS');
}

function usageError(message) {
  if (message) console.error('错误: ' + message);
  printUsage();
  process.exit(2);
}

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') {
      printUsage();
      process.exit(0);
    }
    if (!arg.startsWith('--')) usageError('不认识的参数: ' + arg);
    const eq = arg.indexOf('=');
    let key;
    let value;
    if (eq >= 0) {
      key = arg.slice(2, eq);
      value = arg.slice(eq + 1);
    } else {
      key = arg.slice(2);
      value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) usageError('参数 --' + key + ' 缺少值');
      i++;
    }
    opts[key] = value;
  }
  return opts;
}

function rmrf(p) {
  if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
}

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

function readText(file) {
  return fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
}

function replaceOnce(text, from, to, label) {
  const n = text.split(from).length - 1;
  if (n !== 1) throw new Error(`[${label}] 期望 1 处，实际 ${n}`);
  console.log(`[ok] ${label}`);
  return text.split(from).join(to);
}

function replaceRegexOnce(text, re, to, label) {
  const flags = re.flags.includes('g') ? re.flags : re.flags + 'g';
  const matches = text.match(new RegExp(re.source, flags));
  const count = matches ? matches.length : 0;
  if (count !== 1) throw new Error(`[${label}] 期望 1 处，实际 ${count}`);
  console.log(`[ok] ${label}`);
  return text.replace(new RegExp(re.source, flags), to);
}

function loadPatterns(explicit) {
  const candidates = explicit
    ? [path.resolve(explicit)]
    : [path.join(__dirname, 'redact-patterns.txt'), path.join(__dirname, 'redact-patterns.example.txt')];
  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) continue;
    const list = readText(candidate)
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith('#'));
    console.log(`[ok] 脱敏名单 ${candidate}（${list.length} 条）`);
    return list;
  }
  if (explicit) throw new Error('名单文件不存在: ' + path.resolve(explicit));
  console.log('[ok] 没找到脱敏名单，只用内置通用检查');
  return [];
}

const PLACEHOLDER_USERS = new Set(['public', 'default', 'default user', 'all users', 'wdagutilityaccount']);

function assertNoPatterns(text, label, patterns) {
  for (let i = 0; i < patterns.length; i++) {
    if (text.toLowerCase().includes(patterns[i].toLowerCase())) {
      throw new Error(`[${label}] 仍命中脱敏名单第 ${i + 1} 条: ${patterns[i]}`);
    }
  }
}

function assertClean(text, label, patterns) {
  const userDir = /[A-Za-z]:\\Users\\([^\\/:*?"<>|\r\n]+)\\/g;
  let m;
  while ((m = userDir.exec(text)) !== null) {
    const user = m[1];
    if (/[<>%{}]/.test(user)) continue;
    if (PLACEHOLDER_USERS.has(user.toLowerCase())) continue;
    throw new Error(`[${label}] 还有个人目录: ${m[0]}`);
  }

  const token = /(?:ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{16,})/;
  const tm = text.match(token);
  if (tm) throw new Error(`[${label}] 还有疑似令牌: ${tm[0].slice(0, 4)}…`);

  const email = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
  let em;
  while ((em = email.exec(text)) !== null) {
    if (/@(?:example\.(?:com|org|net)|example|test|invalid)$/i.test(em[0])) continue;
    throw new Error(`[${label}] 还有个人邮箱: ${em[0]}`);
  }

  assertNoPatterns(text, label, patterns);
}

const env = process.env;
const args = parseArgs(process.argv.slice(2));

const rawSrc = args.src || env.BUILD_PLUGIN_SRC;
const rawOut = args.out || env.BUILD_PLUGIN_OUT;
if (!rawSrc) usageError('必须给 --src（插件源码目录），或设 BUILD_PLUGIN_SRC');
if (!rawOut) usageError('必须给 --out（输出目录），或设 BUILD_PLUGIN_OUT');

const SRC = path.resolve(rawSrc);
const OUT = path.resolve(rawOut);
const BASE = path.resolve(args.base || env.BUILD_PLUGIN_BASE || rawSrc);
const VERSION_ARG = args.version || env.BUILD_PLUGIN_VERSION || '';
const LEGACY_RAW = args['legacy-root'] || env.BUILD_PLUGIN_LEGACY_ROOT || 'D:/tools/napcat';
const LEGACY = path.win32.normalize(LEGACY_RAW.replace(/\//g, '\\')).replace(/\\+$/, '');

if (!fs.existsSync(SRC)) usageError('--src 不存在: ' + SRC);
if (!fs.existsSync(BASE)) usageError('--base 不存在: ' + BASE);
if (OUT === path.parse(OUT).root) usageError('--out 不能是盘符根目录: ' + OUT);
if (OUT === SRC || OUT === BASE) usageError('--out 不能等于 --src / --base');

const PATTERNS = loadPatterns(args.patterns || env.BUILD_PLUGIN_PATTERNS || '');

function legacyText(rel) {
  return path.win32.join(LEGACY, rel);
}

function literalOf(winPath) {
  return winPath.replace(/\\/g, '\\\\');
}

function containsLegacy(text) {
  const variants = [LEGACY, LEGACY.replace(/\\/g, '/')];
  return variants.some((v) => v.length > 0 && text.includes(v));
}

function sanitizeIndex(src) {
  let s = src;

  s = replaceOnce(s,
    "const DEBUG_LOG_FILE = '" + literalOf(legacyText('qq-bridge-debug.log')) + "';",
    "const DEBUG_LOG_FILE = join(QB_HOME, 'qq-bridge-debug.log');",
    'debug log 路径');

  s = replaceOnce(s,
    "const VOICE_TOOL = '" + literalOf(legacyText('bin\\make-voice.ps1')) + "';",
    "const VOICE_BIN = process.env.QB_VOICE_BIN ?? join(QB_HOME, 'bin');\nconst VOICE_TOOL = join(VOICE_BIN, 'make-voice.ps1');",
    '语音脚本路径');

  s = replaceOnce(s,
    "const VOICE_OUT_EXAMPLE = '" + literalOf(legacyText('voice\\reply.mp3')) + "';",
    "const VOICE_OUT_EXAMPLE = join(QB_HOME, 'voice', 'reply.mp3');",
    '语音输出示例路径');

  s = replaceOnce(s,
    "stickerDir: '" + literalOf(legacyText('qq-bridge\\stickers')) + "',",
    "stickerDir: join(QB_HOME, 'stickers'),",
    '表情包目录');

  s = replaceOnce(s,
    "personaFile: '" + literalOf(legacyText('qq-bridge\\personas.json')) + "',",
    "personaFile: join(QB_HOME, 'personas.json'),",
    '人格文件');

  s = replaceOnce(s,
    "const DEFAULT_UI_SETTINGS_FILE = '" + literalOf(legacyText('qq-bridge\\settings-ui.json')) + "';",
    "const DEFAULT_UI_SETTINGS_FILE = join(QB_HOME, 'settings-ui.json');",
    '设置页文件');

  // 提示词里的角色名列表：保留句子结构，把具体名字去掉
  s = replaceRegexOnce(
    s,
    /(值就是)上头(【当前性格模式】后面那个名字)（[^）\n]{1,160}等）/,
    '$1提示词里$2',
    '提示词里的人名'
  );

  if (containsLegacy(s)) throw new Error('[lib/index.js] 仍含旧安装路径: ' + LEGACY);
  assertClean(s, 'lib/index.js', PATTERNS);

  return s;
}

console.log('[build] src=' + SRC);
console.log('[build] base=' + BASE);
console.log('[build] out=' + OUT);
console.log('[build] legacy-root=' + LEGACY);

rmrf(OUT);
fs.mkdirSync(OUT, { recursive: true });

// 1) 底座资源（图标 / LICENSE / locale / scripts）
for (const name of ['icon.svg', 'LICENSE', 'locale', 'scripts']) {
  const source = path.join(BASE, name);
  if (!fs.existsSync(source)) {
    throw new Error('缺少底座资源: ' + source + '（用 --base 指定包含 icon.svg/LICENSE/locale/scripts 的目录）');
  }
  if (fs.statSync(source).isDirectory()) copyTree(source, path.join(OUT, name));
  else cp(source, path.join(OUT, name));
}
console.log('[ok] 复制 icon/LICENSE/locale/scripts');

// 2) 代码
const indexSrc = sanitizeIndex(readText(path.join(SRC, 'lib', 'index.js')));
fs.mkdirSync(path.join(OUT, 'lib'), { recursive: true });
fs.writeFileSync(path.join(OUT, 'lib', 'index.js'), indexSrc, 'utf8');

// client.js 里有写死的「QQ 号 → 昵称」示例，一并换掉
let clientSrc = readText(path.join(SRC, 'lib', 'client.js'));
const clientBefore = clientSrc;
clientSrc = clientSrc
  .replace(/^[ \t]*if \(qq === '\d{5,12}'\) return '[^\n]*\n/gm, '')
  .replace(/例如 \d{5,12}, \d{5,12}/g, '例如 10001, 10002')
  .replace(/例如 private:\d{5,12}/g, '例如 private:10001');
if (clientSrc === clientBefore) throw new Error('client.js 脱敏没有命中任何一行，检查源码结构');
if (/^[ \t]*if \(qq === '\d{5,12}'\) return /m.test(clientSrc)) {
  throw new Error('client.js 里仍有写死的 QQ 号 → 昵称映射');
}
assertClean(clientSrc, 'lib/client.js', PATTERNS);
fs.writeFileSync(path.join(OUT, 'lib', 'client.js'), clientSrc, 'utf8');
console.log('[ok] lib/client.js（去掉写死的 QQ 号 → 昵称）');

// 3) cordis patch
cp(path.join(SRC, 'cordis.patch.yml'), path.join(OUT, 'cordis.patch.yml'));
const patch = readText(path.join(OUT, 'cordis.patch.yml'));
if (containsLegacy(patch)) throw new Error('cordis.patch.yml 里还有个人安装路径: ' + LEGACY);
assertClean(patch, 'cordis.patch.yml', PATTERNS);
console.log('[ok] cordis.patch.yml');

// 4) package.json
const pkg = JSON.parse(readText(path.join(SRC, 'package.json')));
const VERSION = VERSION_ARG || pkg.version;
if (!VERSION) throw new Error('没有版本号：给 --version，或让源码 package.json 带 version');
pkg.version = VERSION;
pkg.description = 'DSH 插件：通过 OneBot v11 接入 QQ，把私聊/群聊交给 DSH Agent 处理并把回复发回 QQ（NapCatQQ / LLOneBot / Lagrange 均可）。';
pkg.files = ['lib', 'scripts', 'locale', 'cordis.patch.yml', 'README.md', 'LICENSE', 'icon.svg'];
const pkgText = JSON.stringify(pkg, null, 2) + '\n';
assertNoPatterns(pkgText, 'package.json', PATTERNS);
fs.writeFileSync(path.join(OUT, 'package.json'), pkgText, 'utf8');
console.log('[ok] package.json v' + VERSION);

// 5) 节点实际使用的文件存在性检查
for (const need of ['lib/index.js', 'lib/client.js', 'cordis.patch.yml', 'package.json', 'scripts/show-qrcode.ps1', 'scripts/watch-napcat.ps1']) {
  if (!fs.existsSync(path.join(OUT, need))) throw new Error('缺少 ' + need);
}
console.log('done ->', OUT);
