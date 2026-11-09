/**
 * dsh-qq-bridge — DSH 插件：OneBot v11 ↔ DSH Agent 桥接。
 *
 * - 反向 WebSocket（mode: server，默认）：插件作为 WS 服务端，NapCatQQ /
 *   LLOneBot / Lagrange 等 OneBot 实现作为客户端连接过来。
 * - 正向 WebSocket（mode: client）：插件连接机器人提供的 WS 服务端。
 *
 * 每条 QQ 私聊 / 群聊对应一个持久 DSH Agent 会话（在 GUI 侧边栏可见），
 * 消息交给 Agent 处理后把最终文本回复发回 QQ。
 *
 * 能力：文字对话 · 图片识别 · 语音识别 · 发图/发语音 · P图修图工具箱 · 多人格。
 */
import { WebSocketServer, WebSocket } from 'ws';
import { randomUUID, createHash } from 'node:crypto';
import { join, dirname, extname, basename } from 'node:path';
import { homedir } from 'node:os';
import { mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import {
  statSync, readFileSync, readdirSync,
  mkdirSync, writeFileSync, copyFileSync, renameSync, unlinkSync,
} from 'node:fs';
import { spawn } from 'node:child_process';

// 所有个人数据（人格、功能开关、会话映射、设置覆盖层、调试日志）默认放这里：
//   <DSH_HOME>/qq-bridge/
// 安装后不必改路径；想换位置就改配置里的各个 *File 字段。
const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh');
const QB_HOME = join(DSH_HOME, 'qq-bridge');
const DEBUG_LOG_FILE = join(QB_HOME, 'qq-bridge-debug.log');
const VOICE_BIN = process.env.QB_VOICE_BIN ?? join(QB_HOME, 'bin');
const VOICE_TOOL = join(VOICE_BIN, 'make-voice.ps1');
const VOICE_OUT_EXAMPLE = join(QB_HOME, 'voice', 'reply.mp3');

const DEFAULTS = {
  // ── OneBot 传输 ──────────────────────────────────────────────
  mode: 'server',          // 'server' = 反向 WS（插件做服务端） | 'client' = 正向 WS
  host: '127.0.0.1',       // server 模式监听地址（局域网接入填 0.0.0.0）
  port: 3002,              // server 模式监听端口
  path: '/',               // server 模式允许的路径前缀（'/' 表示接受任意路径）
  url: '',                 // client 模式的目标 ws 地址，如 ws://127.0.0.1:3001
  accessToken: '',         // 可选：OneBot access token 校验（Authorization: Bearer <token>）
  reconnectMs: 5000,       // client 模式断线重连间隔
  // ── Agent 会话 ───────────────────────────────────────────────
  agentPreset: 'standard', // Agent 预设（standard = 完整工具；minimal = 纯对话）
  permissionPreset: 'danger-full-access', // 权限预设（read-only / workspace-write / danger-full-access）
  provider: '',            // 留空 = 跟随当前应用选择；否则显式指定模型提供方
  model: '',               // 留空 = 跟随当前应用选择
  workspaceRoot: '',       // 每个 QQ 会话的工作区根目录（留空 = $DSH_HOME/qq-workspaces）
  workspaceMap: {},        // 指定某些聊天直接落在已有 DSH 工作区：{ 'private:<QQ号>': '<工作区绝对目录>' }
  pruneLegacyWorkspaces: false, // 启动时移除「改映射前」桥接在 qq-workspaces/<聊天键> 建过的旧工作区登记（不动文件/会话）
  // ── 聊天体验 ─────────────────────────────────────────────────
  ackEnabled: true,        // 收到消息先回一条“正在处理”
  ackMessage: '⏳ 已收到，正在处理…',
  maxReplyChars: 3800,     // 单条回复超过该长度时分段发送
  turnTimeoutMs: 600000,   // 单轮处理超时（毫秒），超时后把已有回复发回
  contextRotatePercent: 40, // QQ 会话上下文用到该百分比后，下一条消息新建会话（0 = 关闭）
  privateEnabled: true,    // 处理私聊
  groupEnabled: true,      // 处理群聊
  allowlist: [],           // 仅允许这些 QQ 号使用（空 = 全部允许）
  // ── 群聊规则 ─────────────────────────────────────────────────
  groupRequireAt: true,        // 群里必须 @ 机器人才回复（没 @ 的消息直接忽略）
  groupAtReplyLimit: 3,        // 被 @ 后 60 秒内最多回几条（含被 @ 的那条）；用完要再 @ 一次
  groupSharedMemory: true,     // 同一个群的所有成员会话共用一份群记忆（群工作区下的 群记忆.md）
  // ── 表情包 ───────────────────────────────────────────────────
  stickerEnabled: true,        // 回复时按概率附带一张表情包
  stickerChance: 0.4,          // 每条回复附带表情包的概率（0~1，默认 0.4）
  stickerDir: join(QB_HOME, 'stickers'), // 表情包库：按聊天分文件夹，对方发来的表情包自动收集到这里
  stickerMaxBytes: 2097152,    // 单张表情包最大字节数（超过的不收，防大图占地方）
  stickerMaxPerChat: 200,      // 每个聊天最多保留多少张表情包（超了删最旧的）
  // ── 主动消息（定时醒来）───────────────────────────────────────
  wakeEnabled: true,           // 到间隔就掷一次骰子，掷中主动发一条消息
  wakeIntervalMinutes: 60,     // 间隔多少分钟掷一次骰子（默认 1 小时）
  wakeChance: 0.6,             // 每次掷骰子醒来的概率（0~1，默认 0.6）
  wakeTargets: [],             // 发给哪些 QQ 号（纯数字）；留空 = 所有聊过天的私聊
  // ── 图片 ─────────────────────────────────────────────────────
  imageEnabled: true,      // 下载 QQ 图片并把本地路径交给 Agent（Agent 用 read_image 查看）
  maxImageBytes: 10485760, // 单张图片最大字节数，超过则跳过
  // ── 语音 ─────────────────────────────────────────────────────
  voiceEnabled: true,      // 下载 QQ 语音并转成文字交给 Agent
  speechProvider: '',      // 留空 = 用 DSH 默认 STT 提供方；否则指定 providerId
  speechLanguage: 'auto',  // auto / zh / en / yue / ja / ko
  maxVoiceBytes: 4194304,  // 单条语音最大字节数（默认 4MB）
  ffmpegPath: 'ffmpeg',    // 音频转码用的 ffmpeg（需在 PATH 中，或填绝对路径）
  voiceConvertFormat: 'mp3', // 让 NapCat 把 SILK 语音转成什么格式（mp3/wav/m4a/flac）
  debugInbound: false,     // 打印每条入站消息的解析结果（排查用）
  // ── 人格系统 ─────────────────────────────────────────────────
  personaFile: join(QB_HOME, 'personas.json'), // 人格配置文件（用户可直接编辑）
  personaEnabled: true,    // 是否启用多人格
  // ── 修图（P图）工具箱 ────────────────────────────────────────
  imageEditEnabled: false, // 是否默认就开启修图能力（false = 按需开启，会话里发「修图开」）
  featureFile: join(QB_HOME, 'features.json'), // 按需开启的功能开关（用户可直接编辑）
  imageToolkit: join(QB_HOME, 'image-craft.py'), // 工具箱脚本路径（脚本不随插件分发，自己放）
  imageToolkitPython: '',  // 调用工具箱用的 python.exe（留空 = 自动探测 DSH 内置 Python）
  imageOutDir: '',         // 修图产物目录（留空 = 会话工作区下的 edited/）
  mediaRetentionDays: 14,  // attachments/edited 里超过该天数的文件自动清理（0 = 不清理）
  // ── 跨重启记忆 ────────────────────────────────────────────────
  sessionFile: join(QB_HOME, 'sessions.json'), // 聊天 ↔ 会话 id 映射（重启后靠它找回历史）
  resumeOnStart: true,     // 重启/重载后自动恢复上次的会话，而不是新建一个空白会话
};

/** 默认人格文件内容：每个会话可配置多个性格模式并随时切换。 */
const PERSONA_FILE_TEMPLATE = {
  version: 1,
  note: '每个会话可配置多个性格模式；active 是当前生效的模式名。可直接手改本文件，保存后下一条消息即生效。'
    + 'chats 的键：私聊 private:<QQ号>，群聊 group:<群号>。<DSH_HOME>/qq-bridge/personas.json。',
  default: {
    title: '默认',
    prompt: '',
  },
  chats: {},
};

/** 人格文件的读写与解析（用户可手改文件，故每次读取都重新加载）。 */
function loadPersonaFile(filePath) {
  try {
    if (!statSync(filePath).isFile()) return undefined;
  } catch {
    return undefined;
  }
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8'));
    if (!parsed || typeof parsed !== 'object') return undefined;
    if (!parsed.chats || typeof parsed.chats !== 'object') parsed.chats = {};
    if (!parsed.default || typeof parsed.default !== 'object') parsed.default = { title: '默认', prompt: '' };
    return parsed;
  } catch {
    return undefined;
  }
}

/**
 * 某个模式值是不是新的「三段式人格对象」（老格式是纯字符串）。
 * @param {unknown} value
 */
function isThreePartMode(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * 把 modes 里的一个模式值拼成正文。
 *
 * 老格式（字符串）：直接 trim，行为与老版本完全一致。
 * 新格式（对象）：按固定顺序 identity → behavior → replyStyle 拼非空段落，
 *   每段前面一行标签、标签后直接换行；段落之间空一行；整体去首尾空白。
 *   三段全空 = 空字符串。标签文字和顺序是与其它插件共享的约定，别改。
 *
 * @param {unknown} value
 * @returns {string}
 */
export function composeModeBody(value) {
  if (typeof value === 'string') return value.trim();
  if (!isThreePartMode(value)) return value == null ? '' : String(value).trim();
  const sections = [
    ['你是谁：', value.identity],
    ['什么时候开口：', value.behavior],
    ['说话方式：', value.replyStyle],
  ];
  const blocks = [];
  for (const [label, part] of sections) {
    const body = part == null ? '' : String(part).trim();
    if (!body) continue;
    blocks.push(`${label}\n${body}`);
  }
  return blocks.join('\n\n').trim();
}

/** 三段式模式里的备用风格列表：去空白、去空串、最多 8 条；老字符串模式 = 空数组。 */
function normalizeVariants(value) {
  if (!isThreePartMode(value) || !Array.isArray(value.variants)) return [];
  return value.variants
    .map((item) => (item == null ? '' : String(item).trim()))
    .filter(Boolean)
    .slice(0, 8);
}

/** 备用风格触发概率夹到 0~1；非法值 = 0（永不换）。 */
function clampVariantChance(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return 0;
  return Math.min(1, Math.max(0, num));
}

/**
 * 掷一次「备用风格」：掷中返回本次要用的那条，没掷中 / 没有备用风格返回 ''。
 *
 * 只做一次随机（命中与挑选用同一个数），方便测试注入固定 rng。
 * 绝不能把结果写回 persona —— 它只影响本次注入的文本，否则设定签名会抖、每条消息重复注入。
 *
 * @param {{variants?: string[], variantChance?: number}} [persona]
 * @param {() => number} [rng]
 * @returns {string}
 */
export function rollVariant(persona, rng = Math.random) {
  const variants = normalizeVariants(persona);
  if (variants.length === 0) return '';
  const chance = clampVariantChance(persona?.variantChance);
  if (chance <= 0) return '';
  const roll = Number(typeof rng === 'function' ? rng() : Math.random());
  if (!Number.isFinite(roll) || roll < 0 || roll >= chance) return '';
  // 命中区间 [0, chance) 均匀映射到所有备用风格，避免第一条被偏爱
  const index = Math.min(variants.length - 1, Math.floor((roll / chance) * variants.length));
  return variants[Math.max(0, index)] ?? '';
}

/**
 * 人格文件里 rules 那一段：所有人格共用的短规则，键是名字、值是正文。
 * 只有非空字符串才算数；空对象 / 没写 = 没有规则。
 */
function normalizeRules(value) {
  const out = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return out;
  for (const [name, text] of Object.entries(value)) {
    const key = String(name ?? '').trim();
    const body = typeof text === 'string' ? text.trim() : '';
    if (!key || !body) continue;
    out[key] = body;
  }
  return out;
}

/**
 * 解析某个会话当前生效的人格。
 * 查找顺序：精确 chatKey → 发送者的私聊人格 → 全局 default。
 * 模式值可以是老格式字符串，也可以是三段式对象（见 composeModeBody）。
 * rules 是全局共用规则，会拼进提示词（见 composePersonaText）。
 * @returns {{ mode: string, prompt: string, title: string, available: string[],
 *   variants: string[], variantChance: number, rules: Record<string, string> }}
 */
export function resolvePersona(file, chatKey, senderKey) {
  const rules = normalizeRules(file?.rules);
  const empty = {
    mode: '默认', prompt: '', title: '默认', available: [], variants: [], variantChance: 0, rules,
  };
  if (!file) return empty;
  const candidates = [chatKey, senderKey].filter(Boolean);
  for (const key of candidates) {
    const entry = file.chats?.[key];
    if (!entry) continue;
    const modes = entry.modes && typeof entry.modes === 'object' ? entry.modes : {};
    const names = Object.keys(modes);
    const active = typeof entry.active === 'string' && names.includes(entry.active)
      ? entry.active
      : (names[0] ?? '默认');
    const value = modes[active];
    return {
      mode: active,
      prompt: composeModeBody(value),
      title: String(entry.title ?? active),
      available: names,
      variants: normalizeVariants(value),
      variantChance: isThreePartMode(value) ? clampVariantChance(value.variantChance) : 0,
      rules,
    };
  }
  return {
    mode: '默认',
    prompt: composeModeBody(file.default?.prompt ?? ''),
    title: String(file.default?.title ?? '默认'),
    available: [],
    variants: [],
    variantChance: 0,
    rules,
  };
}

/** 基础规则：只负责说明 QQ 场景与收发能力，性格由用户自定义的人格文件决定。 */
const BASE_RULES = [
  '以下对话通过 QQ 聊天进行。',
  '请用自然、直接、像聊天一样的方式回答：先说结论，再展开必要的细节；',
  '除非用户明确要求，不要输出冗长的过程说明、清单或步骤复述。',
  '不要使用 ask_user_question 之类的交互提问工具（QQ 里无法作答），遇到需要选择时自己选一个合理默认并说明。',
  '回复必须是纯文本：不要用 HTML 标签（<p>、<br>、<div> 之类），也不要用代码块把整段回答包起来。',
  '你仍可使用文件、终端、联网搜索等全部能力。',
  '对方发来的图片会以本地文件路径给你（用 read_image 工具查看）；对方发来的语音已经被自动转成文字并标注为「语音」，',
  '直接把那些文字当作对方说的话来回应，不要提“语音转文字”或“我听不到语音”这类话。',
  '要发图片给对方时，直接在回复里写 markdown 图片语法 ![说明](本地绝对路径)，',
  '桥接会把本地图片文件真的发到 QQ；路径必须是本机存在的图片文件（png/jpg/gif/webp/bmp），',
  '不要用 http 链接，也不要用代码块包住它。',
  '要发语音条给对方时：先把要说的话转成本机音频文件，用命令',
  `powershell -NoProfile -ExecutionPolicy Bypass -File "${VOICE_TOOL}" -Text "要说的话" -Out "${VOICE_OUT_EXAMPLE}" -Persona "当前性格模式" [-Voice 音色] [-Model q8] [-Cfg 2.5] [-Instruction 声音描述]`,
  `然后在回复里写 markdown 图片语法但把路径指向该音频文件，例如 ![语音](${VOICE_OUT_EXAMPLE})；`,
  '桥接会按扩展名识别成语音条（mp3/wav/m4a/ogg/flac/amr/silk）。',
  '发语音一定要带 -Persona，值就是提示词里【当前性格模式】后面那个名字，声音会按那个人设自动挑，人设一改声音跟着改；',
  '不知道该填什么就填当前性格模式的名字，别自己编。不填会退成默认嗓子。',
  '声音默认走本机自己的嗓音（本地模型，第一次发会等十几秒把模型拉起来，之后一两秒出音）。',
  '-Voice 只在对方明确要方言时才填：东北话、陕西话、粤语、台湾（这几种会走微软云端，本地模型做不了口音）。',
  '想要笑声、叹气这类语气就加 -Cfg 2.5（会慢一些）；想更接近原声就加 -Model q8（多占一点显存）。',
  '发语音时要像真人发语音那样控制语气，并在文字里简短说明；语音适合口语化的短内容，长内容仍用文字。',
];

const HELP = [
  '🤖 DSH QQ 桥接已接入（DeepSeek Agent）',
  '直接发消息即可对话；上下文会一直保留，重启也不丢。',
  '',
  '支持：文字 · 图片识别 · 语音识别 · 发图/发语音给你 · P图修图（按需开启）· 多人格 · 表情包',
  '',
  '可用指令：',
  '· 帮助 / /help — 显示本说明',
  '· 状态 / /status — 查看当前会话状态（含记忆来源）',
  '· 重置会话 / /reset — 忘掉之前聊的，开一个全新会话',
  '· 修图 — 查看修图能力状态',
  '· 修图开 / 修图关 — 按需开启或关闭修图能力（可限时：修图开 30分钟）',
  '',
  '🙂 表情包：',
  '· 你发来的表情包会自动收进这个聊天的表情包库；我回复时按概率顺手带一张。',
  '· 概率和库目录在设置页「QQ 桥接 → 表情包」里改（默认 0.4）。',
  '',
  '⏰ 主动消息：',
  '· 隔一段时间（默认 1 小时）我会掷一次骰子，掷中了就主动给你发一句。',
  '· 间隔和概率在设置页「QQ 桥接 → 主动消息」里改（默认 0.6）。',
  '',
  '🧠 记忆：',
  '· 聊天记录会存在磁盘上，DSH 重启、插件重载后自动接回来。',
  '· 想让某次谈话彻底翻篇，发「重置会话」。',
  '· 上下文用到 40% 时，下一条消息会自动开新会话（设置页可改，0 = 关闭）。',
  '',
  '👥 群聊：',
  '· 要先 @ 我 才会回你；群里每个人单独一个会话，都放在这个群的工作区里。',
  '· 被 @ 后 60 秒内最多回 3 条（设置页「群聊」里可改，被 @ 的那条也算 1 条）；额度用完要再 @ 一次。',
  '· 群内记忆共享：在群里让我记住的事，群里所有人的会话都会知道。',
  '',
  '🖼 修图（默认关闭，发「修图开」启用后可用）：',
  '· 「帮我美颜一下」「把背景虚化」「转成黑白」',
  '· 「抠图换蓝底」「做成一寸证件照」',
  '· 「给我脸上打个码」「拼成九宫格」',
  '· 「加个字：今天也要加油」「做成表情包」',
  '',
  '🎭 性格设置：',
  '· 性格 — 查看当前性格与所有模式',
  '· 性格 模式名 — 切换性格',
  '· 设定性格 模式名：描述 — 新建/修改性格',
  '· 删除性格 模式名 — 删除性格',
  '也可以直接说“你说话温柔一点”，我会自己改。',
].join('\n');

/**
 * 群聊「被 @ 后的回复额度」。
 *
 * 被 @ 一次 → 开一个 60 秒窗口，窗口内最多回 limit 条（被 @ 的那条也算 1 条）；
 * 窗口过期或额度用完 → 必须再次 @ 才会重置。
 * 状态按聊天键（group:<群号>:<QQ号>）分开，只存在内存里，重启清零。
 */
export class GroupReplyWindow {
  constructor(windowMs = 60000) {
    this.windowMs = windowMs;
    /** @type {Map<string, { startAt: number, used: number }>} */
    this.states = new Map();
  }

  /**
   * 尝试占用一次回复额度。
   * @param {string} chatKey 群成员会话键
   * @param {{ mentioned?: boolean, limit?: number, now?: number }} [options]
   * @returns {boolean} true = 放行（已占 1 条）；false = 忽略
   */
  take(chatKey, { mentioned = false, limit = 3, now = Date.now() } = {}) {
    let state = this.states.get(chatKey);
    if (mentioned) {
      // 每次 @ 都重开窗口、清零已用次数
      state = { startAt: now, used: 0 };
      this.states.set(chatKey, state);
    } else if (state && now - state.startAt >= this.windowMs) {
      this.states.delete(chatKey);
      state = undefined;
    }
    if (!state) return false;
    const max = Number(limit);
    if (Number.isFinite(max) && max > 0 && state.used >= max) return false;
    state.used += 1;
    return true;
  }
}

/**
 * 上下文占用百分比，口径与 GUI 的 ContextMeter 一致：
 * `projectedTokens / contextWindow`，其中 projectedTokens =
 * 提供方上报的 prompt 压力（input + cache，不含 output）+ 采样之后的表面增量。
 *
 * 只认 provider 上报过 usage 的会话；没有 usage / contextWindow 时返回 null，
 * 和 GUI 一样先不显示百分比。
 *
 * @param {{
 *   baseline?: { kind?: string, usage?: { inputTokens?: number, cacheReadTokens?: number, cacheWriteTokens?: number } },
 *   surfaceDeltaTokens?: number,
 * } | null | undefined} measurement `ctx.tokenMeter.measure(session)` 的返回值
 * @param {number | undefined} contextWindow 模型上下文窗口
 * @returns {{ usedTokens: number, contextWindow: number, percent: number } | null}
 */
export function contextOccupancy(measurement, contextWindow) {
  const windowSize = Number(contextWindow);
  if (!(windowSize > 0) || !measurement) return null;
  const baseline = measurement.baseline;
  if (!baseline || baseline.kind !== 'usage' || !baseline.usage) return null;
  const usage = baseline.usage;
  const pressureTokens = (Number(usage.inputTokens) || 0)
    + (Number(usage.cacheReadTokens) || 0)
    + (Number(usage.cacheWriteTokens) || 0);
  const usedTokens = Math.max(0, pressureTokens + (Number(measurement.surfaceDeltaTokens) || 0));
  return {
    usedTokens,
    contextWindow: windowSize,
    percent: Math.min(100, Math.round((usedTokens / windowSize) * 100)),
  };
}

/**
 * 从 OneBot 消息事件里提取文本、图片与语音。
 * 返回 { text, images, voices }；
 * images 为 { url, file, name } 数组，voices 为 { url, file, name } 数组。
 */
function extractContent(event) {
  const images = [];
  const voices = [];
  const message = event.message;

  const pushImage = (data) => {
    const url = String(data?.url ?? '').trim();
    const file = String(data?.file ?? '').trim();
    const localPath = String(data?.path ?? '').trim();
    if (!url && !file && !localPath) return;
    images.push({
      url,
      file,
      path: localPath,
      name: String(data?.filename ?? data?.name ?? '').trim(),
      // 表情包识别用：NapCat 对动画表情会给 summary「[动画表情]」、sub_type=1
      summary: String(data?.summary ?? '').trim(),
      subType: Number(data?.sub_type ?? NaN),
    });
  };

  const pushVoice = (data) => {
    const url = String(data?.url ?? '').trim();
    const file = String(data?.file ?? '').trim();
    const localPath = String(data?.path ?? '').trim();
    if (!url && !file && !localPath) return;
    voices.push({
      url,
      file,
      path: localPath,
      name: String(data?.filename ?? data?.name ?? '').trim(),
    });
  };

  if (Array.isArray(message)) {
    const parts = [];
    const mentions = [];
    const selfId = String(event.self_id ?? '');
    for (const segment of message) {
      if (!segment || typeof segment !== 'object') continue;
      const type = segment.type;
      if (type === 'text') parts.push(String(segment.data?.text ?? ''));
      else if (type === 'image') { pushImage(segment.data); parts.push('[图片]'); }
      else if (type === 'record') { pushVoice(segment.data); parts.push('[语音]'); }
      else if (type === 'video') parts.push('[视频]');
      else if (type === 'file') parts.push('[文件]');
      else if (type === 'at') {
        const qq = String(segment.data?.qq ?? '');
        if (qq) mentions.push(qq);
        // @机器人 本身不算说话内容，交给 Agent 时去掉；@别人保留，方便区分谁在跟谁说话
        if (qq && qq !== selfId) parts.push(`@${qq}`);
      }
      else if (type === 'face') parts.push('[表情]');
      else if (type === 'reply') parts.push('[引用回复]');
      else if (type === 'forward') parts.push('[合并转发]');
    }
    return { text: parts.join(' ').replace(/\s+/g, ' ').trim(), images, voices, mentions };
  }

  const raw = String(event.raw_message ?? message ?? '');
  const mentions = [];
  const selfId = String(event.self_id ?? '');
  const text = raw.replace(/\[CQ:([a-z-]+)([^\]]*)\]/gi, (_m, type, argStr) => {
    const data = {};
    const re = /(\w+)=([^,]*)/g;
    let m;
    while ((m = re.exec(argStr)) !== null) data[m[1]] = decodeCqValue(m[2]);
    switch (type) {
      case 'image': pushImage(data); return '[图片]';
      case 'record': pushVoice(data); return '[语音]';
      case 'video': return '[视频]';
      case 'face': return '[表情]';
      case 'at': {
        const qq = String(data.qq ?? '');
        if (qq) mentions.push(qq);
        return qq && qq !== selfId ? `@${qq}` : '';
      }
      default: return '';
    }
  }).replace(/\s+/g, ' ').trim();
  return { text, images, voices, mentions };
}

/** 反转义 CQ 码参数里的实体。 */
function decodeCqValue(value) {
  return String(value)
    .replace(/&#44;/g, ',')
    .replace(/&#91;/g, '[')
    .replace(/&#93;/g, ']')
    .replace(/&amp;/g, '&');
}

/** 兼容旧调用：只要文本。 */
function extractText(event) {
  return extractContent(event).text;
}

/** 从 Assistant 消息中提取文本块。 */
function extractAssistantText(message) {
  if (!message || !Array.isArray(message.content)) return '';
  return message.content
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('')
    .trim();
}

/**
 * 洗掉回复里的 HTML。
 *
 * 为什么需要：模型偶尔会带 <p>…</p> 这种标签回来（多半是被网页内容带偏）。
 * 以前这些标签会原样进 QQ，而且因为「一句一条」的切分，像 </p> 这样的裸标签
 * 会被单独当成一条消息发出去 —— 用户看到满屏的 <p></p>（2026-10-21 那次
 * 「程序错误」就是这么来的）。这里统一洗掉标签，块级标签换成换行，顺手解码
 * 常见 HTML 实体；代码块里的内容原样保护，避免误伤。
 */
function sanitizeReplyText(text) {
  let s = String(text ?? '');
  if (!s) return '';

  // 代码块 / 行内代码先摘出来占位，别被下面的标签清理误伤。
  // 行内代码尤其要紧：机器人解释「</p> 是什么」时会写 `</p>`，
  // 那是它有意引用的字面量，洗掉就成了病句。
  const fences = [];
  s = s.replace(/```[\s\S]*?```/g, (match) => {
    fences.push(match);
    return `\u0000FENCE${fences.length - 1}\u0000`;
  });
  s = s.replace(/`[^`\n]+`/g, (match) => {
    fences.push(match);
    return `\u0000FENCE${fences.length - 1}\u0000`;
  });

  s = s.replace(/<br\s*\/?>/gi, '\n');                                        // 换行标签
  s = s.replace(/<\/(p|div|li|ul|ol|h[1-6]|tr|pre|blockquote|section|article)\s*>/gi, '\n');
  s = s.replace(/<\/?[a-zA-Z][^>]*>/g, '');                                    // 其余标签整块去掉，保留文字

  s = s.replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&amp;/gi, '&');

  s = s.replace(/\u0000FENCE(\d+)\u0000/g, (_m, i) => fences[Number(i)] ?? '');

  return s.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * 这一块里有没有真正可读的内容（字母 / 数字 / emoji）。
 * 只由标点或符号组成的块不值得单独发一条消息，切分后要丢掉。
 */
function hasVisibleContent(text) {
  const s = String(text ?? '');
  if (!s) return false;
  if (/[\p{L}\p{N}]/u.test(s)) return true;
  return /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(s);
}

/** 把一段长文本按行边界切成不超过 maxChars 的块。 */
/**
 * 按「人类说话」的边界把回复切成多条：
 * 先洗掉 HTML，再按空行分段、按句末标点断句，最后才按字数兜底。
 * 「分多口气发」像真人，「一次性甩一大段」不像；裸 HTML 标签则一条都不该发。
 */
function splitChunks(text, maxChars) {
  const source = sanitizeReplyText(String(text ?? '').replace(/\r\n/g, '\n')).trim();
  if (!source) return [];

  // 统一在出口过滤：空的、只有标点符号的块一律不发
  const finish = (list) => {
    const kept = list
      .map((s) => String(s ?? '').trim())
      .filter((s) => s && hasVisibleContent(s));
    if (kept.length > 0) return kept;
    // 兜底：切出来全被过滤光了，但原文确实有内容 —— 至少发一条，别让用户干等
    return hasVisibleContent(source) ? [source.slice(0, maxChars)] : [];
  };

  if (source.length <= maxChars) {
    // 短回复也按句切：一句话一条，更自然。
    const sentences = splitSentences(source);
    return finish(sentences.length > 1 ? sentences : [source]);
  }

  const chunks = [];
  let buf = '';
  const pushBuf = () => {
    const trimmed = buf.trim();
    if (trimmed) chunks.push(trimmed);
    buf = '';
  };

  for (const block of source.split(/\n{2,}/)) {
    if (block.length <= maxChars) {
      const sentences = splitSentences(block);
      if (sentences.length > 1) {
        for (const sentence of sentences) {
          if (!buf) { buf = sentence; continue; }
          if ((buf + '\n' + sentence).length <= maxChars) buf += '\n' + sentence;
          else { pushBuf(); buf = sentence; }
        }
        pushBuf();
      } else if (!buf) buf = block.trim();
      else if ((buf + '\n\n' + block).length <= maxChars) buf += '\n\n' + block.trim();
      else { pushBuf(); buf = block.trim(); }
      continue;
    }
    // 单个段落就超长：按句子装，再按字数硬切。
    pushBuf();
    let rest = block;
    while (rest.length > 0) {
      const room = maxChars - buf.length;
      if (room <= 0) { pushBuf(); continue; }
      if (rest.length <= room) { buf = buf ? buf + '\n' + rest.trim() : rest.trim(); rest = ''; break; }
      const slice = rest.slice(0, room);
      let cut = Math.max(slice.lastIndexOf('。'), slice.lastIndexOf('！'), slice.lastIndexOf('？'),
        slice.lastIndexOf('；'), slice.lastIndexOf('. '), slice.lastIndexOf('! '), slice.lastIndexOf('? '));
      cut = cut > 0 ? cut + 1 : room;
      const piece = rest.slice(0, cut).trim();
      if (piece) buf = buf ? buf + '\n' + piece : piece;
      rest = rest.slice(cut).replace(/^[\s]+/, '');
      pushBuf();
    }
  }
  pushBuf();
  return finish(chunks);
}

/** 按句末标点断句（句号/叹号/问号/分号 + 换行），保留标点。 */
function splitSentences(block) {
  const lines = String(block ?? '').split('\n');
  const out = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.match(/[^。！？；!?;]+[。！？；!?;]*/g) ?? [trimmed];
    for (const part of parts) {
      const piece = part.trim();
      if (piece) out.push(piece);
    }
  }
  return out;
}

/** Markdown 图片语法：![alt](path)，路径可带尖括号（含空格时）。 */
const IMAGE_MD_RE = /!\[([^\]\n]*)\]\(\s*(?:<([^>\n]+)>|([^)\s][^)\n]*?))\s*\)/g;

/** 可作为图片发送的扩展名。 */
const SENDABLE_IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp']);

/** 可作为语音条发送的扩展名（NapCat 会自行转成 QQ 语音格式）。 */
const SENDABLE_AUDIO_EXT = new Set(['.mp3', '.wav', '.m4a', '.aac', '.ogg', '.flac', '.amr', '.silk']);

/** 把 Windows 绝对路径转成 OneBot 能用的 file:/// URL。 */
function toFileUrl(filePath) {
  const normalized = String(filePath).replace(/\\/g, '/');
  const withSlash = normalized.startsWith('/') ? normalized : `/${normalized}`;
  return encodeURI(`file://${withSlash}`);
}

/**
 * 把 Agent 回复转成 OneBot 消息段数组（文本 + 图片），并按 maxChars 切分。
 *
 * - `![alt](C:\...\x.png)` / `![alt](</path with space/x.png>)` → image 段
 * - 图片段自身不占字符预算；文本仍按原来的行边界切分
 * - 本地文件不存在或非图片扩展名 → 保留原始 markdown 文本，不静默丢弃
 *
 * @param {string} text Agent 回复原文
 * @param {number} maxChars 单条消息的文本上限
 * @param {{warn?: Function}} [logger] 可选日志器（本函数在模块作用域，只能用传入的）
 * @returns {Array<Array<object>>} 每条消息一个消息段数组
 */
function buildReplySegments(text, maxChars, logger) {
  const source = String(text ?? '');
  /** @type {Array<{kind:'text'|'image'|'audio', value:string, alt?:string}>} */
  const parts = [];
  let cursor = 0;

  IMAGE_MD_RE.lastIndex = 0;
  let match;
  while ((match = IMAGE_MD_RE.exec(source)) !== null) {
    const alt = match[1] ?? '';
    const rawPath = (match[2] ?? match[3] ?? '').trim();
    if (!rawPath) continue;

    // 只认本地绝对路径；http(s) 链接交给文本原样输出。
    const looksLocal = /^[a-zA-Z]:[\\/]/.test(rawPath) || rawPath.startsWith('/') || rawPath.startsWith('\\\\');
    const ext = extname(rawPath).toLowerCase();
    if (!looksLocal) continue;

    // 按扩展名决定发图片还是发语音条
    let kind;
    if (SENDABLE_IMAGE_EXT.has(ext)) kind = 'image';
    else if (SENDABLE_AUDIO_EXT.has(ext)) kind = 'audio';
    else continue;

    if (match.index > cursor) parts.push({ kind: 'text', value: source.slice(cursor, match.index) });
    parts.push({ kind, value: rawPath, alt });
    cursor = match.index + match[0].length;
  }
  if (cursor < source.length) parts.push({ kind: 'text', value: source.slice(cursor) });

  // 没有识别到媒体：走纯文本切分路径。
  if (!parts.some((part) => part.kind === 'image' || part.kind === 'audio')) {
    return splitChunks(source, maxChars).map((chunk) => [{ type: 'text', data: { text: chunk } }]);
  }

  const messages = [];
  let current = [];
  let budget = 0;
  const flush = () => {
    if (current.length > 0) messages.push(current);
    current = [];
    budget = 0;
  };

  for (const part of parts) {
    if (part.kind === 'image' || part.kind === 'audio') {
      const isAudio = part.kind === 'audio';
      if (imageExists(part.value)) {
        current.push({
          type: isAudio ? 'record' : 'image',
          data: { file: toFileUrl(part.value) },
        });
      } else {
        const note = isAudio
          ? `⚠️ 语音文件不存在，无法发送：${part.value}`
          : `⚠️ 图片文件不存在，无法发送：${part.value}`;
        // 注意：本函数在模块作用域，拿不到 runBridge 里的 log，日志只能通过参数传进来
        logger?.warn?.('回复中的%s不可用（不存在）：%s', isAudio ? '语音' : '图片', part.value);
        current.push({ type: 'text', data: { text: note } });
        budget += note.length;
        if (budget >= maxChars) flush();
      }
      continue;
    }

    // 混排消息（文字+图片）里的文本段也要洗标签，
    // 否则带图回复里的 <p> 还是会漏到 QQ 里。
    let rest = sanitizeReplyText(part.value);
    while (rest.length > 0) {
      const room = maxChars - budget;
      if (room <= 0) { flush(); continue; }
      const roomChunk = rest.length <= room ? rest : rest.slice(0, room);
      // 文本块内部也按行边界切，避免把一行劈开。
      const pieces = roomChunk.length <= maxChars ? [roomChunk] : splitChunks(roomChunk, maxChars);
      for (const piece of pieces) {
        current.push({ type: 'text', data: { text: piece } });
        budget += piece.length;
      }
      rest = rest.slice(roomChunk.length).replace(/^\n+/, '');
      if (budget >= maxChars) flush();
    }
  }
  flush();
  if (messages.length > 0) return messages;
  // 兜底：媒体都没发出去、剩下的文本也要洗过标签，实在没有可读内容就不发空的
  const fallback = sanitizeReplyText(source);
  return fallback ? [[{ type: 'text', data: { text: fallback } }]] : [];
}

/** 同步判断本地文件是否存在（图片发送前的一次轻量检查）。 */
function imageExists(filePath) {
  try {
    return statSync(filePath).isFile();
  } catch {
    return false;
  }
}

// ── 表情包库（模块级工具）───────────────────────────────────────
/** 把概率值夹到 0~1；无效值回退到默认值。 */
function clampProbability(value, fallback = 0) {
  const num = Number(value);
  const base = Number.isFinite(num) ? num : fallback;
  return Math.max(0, Math.min(1, base));
}

/** 某个聊天在表情包库里的子目录（一个聊天一个文件夹，互不串）。 */
function stickerChatDir(rootDir, chatKey) {
  return join(rootDir, sanitizeDir(chatKey));
}

/**
 * 判断对方发来的一张图要不要收进表情包库。
 * QQ 表情包在 OneBot 里也是 image 段，常见的特征：summary 含「表情」、sub_type=1、或者是 gif；
 * 另外小的 png/jpg/webp（≤384KB）大概率是表情包，也收下。普通大照片不收。
 * @param {{summary?: string, subType?: number, name?: string}} img 图片段数据
 * @param {string} ext 推断出的扩展名（.png 等）
 * @param {number} size 字节数
 * @param {number} maxBytes 允许收的最大字节数
 */
function looksLikeSticker(img, ext, size, maxBytes) {
  if (!(size > 0) || size > Math.max(1, Number(maxBytes) || 2097152)) return false;
  const summary = String(img?.summary ?? '');
  if (/表情|mface|sticker/i.test(summary)) return true;
  if (Number(img?.subType) === 1) return true;
  if (String(ext).toLowerCase() === '.gif') return true;
  return size <= 384 * 1024 && ['.png', '.jpg', '.jpeg', '.webp'].includes(String(ext).toLowerCase());
}

/** 把一张表情包写进库（按内容哈希命名，重复的自动去重）。返回落盘路径。 */
async function saveStickerFile(rootDir, chatKey, buffer, ext) {
  const dir = stickerChatDir(rootDir, chatKey);
  await mkdir(dir, { recursive: true });
  const hash = createHash('sha1').update(buffer).digest('hex').slice(0, 20);
  const target = join(dir, `${hash}${ext}`);
  try {
    if (statSync(target).isFile()) return target;
  } catch { /* 新文件 */ }
  await writeFile(target, buffer);
  return target;
}

/** 表情包太多时删最旧的，保留 max 张。返回删除数量。 */
async function pruneStickerDir(rootDir, chatKey, max) {
  const limit = Math.max(1, Math.floor(Number(max) || 200));
  const dir = stickerChatDir(rootDir, chatKey);
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return 0;
  }
  const files = names
    .filter((name) => SENDABLE_IMAGE_EXT.has(extname(name).toLowerCase()))
    .map((name) => join(dir, name));
  if (files.length <= limit) return 0;
  const withTime = files.map((file) => {
    let time = 0;
    try { time = statSync(file).mtimeMs; } catch { /* 读不到按最旧处理 */ }
    return { file, time };
  });
  withTime.sort((a, b) => a.time - b.time);
  let removed = 0;
  for (const item of withTime.slice(0, files.length - limit)) {
    try { unlinkSync(item.file); removed += 1; } catch { /* 删不掉就算了 */ }
  }
  return removed;
}

/** 从某个聊天的表情包里随机挑一张；没有就返回空串（不跨聊天借）。 */
function pickStickerFile(rootDir, chatKey) {
  const dir = stickerChatDir(rootDir, chatKey);
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return '';
  }
  const files = names
    .filter((name) => SENDABLE_IMAGE_EXT.has(extname(name).toLowerCase()))
    .map((name) => join(dir, name))
    .filter(imageExists);
  if (files.length === 0) return '';
  return files[Math.floor(Math.random() * files.length)];
}

/**
 * 计算主动消息发给哪些聊天。
 * - 配了 wakeTargets：只发这些 QQ 号（写成纯数字或 private:号 都认）。
 * - 没配：发给所有在会话映射里出现过的私聊。
 * - allowlist 不为空时，只发 allowlist 里的人。
 * 群聊永远不发（主动消息只发私聊）。
 */
function resolveWakeTargets(storedChats, targets, allowlist) {
  const allowed = Array.isArray(allowlist) ? allowlist.map(String) : [];
  const configured = Array.isArray(targets)
    ? targets.map((item) => String(item ?? '').trim()).filter(Boolean)
    : [];
  const keys = configured.length > 0
    ? configured.map((item) => {
      const digits = item.replace(/\D/g, '');
      return digits ? `private:${digits}` : '';
    }).filter(Boolean)
    : Object.keys(storedChats ?? {});
  const seen = new Set();
  const out = [];
  for (const key of keys) {
    if (!/^private:\d+$/.test(key) || seen.has(key)) continue;
    seen.add(key);
    const qq = key.slice('private:'.length);
    if (allowed.length > 0 && !allowed.includes(qq)) continue;
    out.push(key);
  }
  return out;
}

/** 带超时的 Promise 等待；超时返回 'timeout' 而不是抛错。 */
function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve('timeout'), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

/**
 * 会话映射文件的默认内容。
 *
 * 为什么需要它：DSH 会把每个会话的事件日志持久化到磁盘，但插件本身
 * 只把「聊天 → 会话」的关系放在内存 Map 里，重启就没了。没有这份映射，
 * 重启后只能新建一个空白会话，历史明明在磁盘上却接不回去（用户感受就是
 * 「重启后不记得之前说过什么」）。把映射落盘后，重启时用
 * ctx.agents.resume({ resumeSessionId }) 就能把老会话连同历史一起接回来。
 *
 * signature 是「人格 + 修图开关」的指纹：机器人停机期间用户改了性格文件的话，
 * 恢复时要补一条 [会话设定已更新] 给 Agent，否则它会拿旧人设继续聊。
 */
const SESSION_FILE_TEMPLATE = {
  version: 1,
  note: '按会话记录「聊天 → DSH 会话 id」的映射，用于重启后恢复记忆。'
    + 'sessionId 是 DSH 里的会话身份（qq-<uuid>），signature 是当时的性格+修图指纹。'
    + '删掉某个会话的条目 = 下次发言时开一个全新会话（等于重置记忆）。',
  chats: {},
};

/** 读取会话映射文件（每次重新加载，用户手改后立即生效）。 */
function loadSessionFile(filePath) {
  try {
    if (!statSync(filePath).isFile()) return undefined;
  } catch {
    return undefined;
  }
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8'));
    // 数组也满足 typeof === 'object'，但没有我们要的结构，直接当无效
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    if (!parsed.chats || typeof parsed.chats !== 'object' || Array.isArray(parsed.chats)) parsed.chats = {};
    return parsed;
  } catch {
    return undefined;
  }
}

/**
 * 从会话映射里取某个聊天的记录。
 * @param {object|undefined} file 会话映射文件内容
 * @param {string} chatKey 会话键
 * @returns {{sessionId: string, signature: string}|undefined}
 */
function evalSessionRecord(file, chatKey) {
  const entry = file?.chats?.[chatKey];
  // 兼容两种写法：纯字符串（手写方便）或对象
  if (typeof entry === 'string') return { sessionId: entry, signature: '' };
  if (entry && typeof entry === 'object' && typeof entry.sessionId === 'string') {
    return { sessionId: entry.sessionId, signature: typeof entry.signature === 'string' ? entry.signature : '' };
  }
  return undefined;
}

/** 功能开关文件的默认内容（用户可直接手改；命令也会写它）。 */
const FEATURE_FILE_TEMPLATE = {
  version: 1,
  note: '按会话记录"按需开启"的功能开关。imageEdit=true/false 表示强制开关；'
    + 'until 是到期时间戳（毫秒，0 = 一直有效）。删掉某个会话的条目即恢复默认（默认关闭）。',
  chats: {},
};

/** 读取功能开关文件（每次读取都重新加载，用户手改后立即生效）。 */
function loadFeatureFile(filePath) {
  try {
    if (!statSync(filePath).isFile()) return undefined;
  } catch {
    return undefined;
  }
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8'));
    if (!parsed || typeof parsed !== 'object') return undefined;
    if (!parsed.chats || typeof parsed.chats !== 'object') parsed.chats = {};
    return parsed;
  } catch {
    return undefined;
  }
}

/**
 * 评估某个会话的修图开关。
 * @param {object|undefined} file 功能开关文件内容
 * @param {string} chatKey 会话键
 * @param {boolean} fallbackOn 没有会话级记录时的默认值（来自 config.imageEditEnabled）
 * @returns {{on: boolean, until: number, expired: boolean}}
 */
function evalImageEdit(file, chatKey, fallbackOn = false) {
  const entry = file?.chats?.[chatKey];
  const until = Number(entry?.until) || 0;
  if (entry?.imageEdit === true) {
    if (until && Date.now() > until) return { on: false, until, expired: true };
    return { on: true, until, expired: false };
  }
  if (entry?.imageEdit === false) return { on: false, until: 0, expired: false };
  return { on: fallbackOn === true, until: 0, expired: false };
}

/** 去掉空白/标点/大小写差异，方便匹配中文口语指令。 */
function normalizeCommandText(text) {
  return String(text ?? '')
    .trim()
    .replace(/^[/／]/, '')
    .replace(/\s+/g, '')
    .replace(/[?？。!！~～]/g, '')
    .toLowerCase();
}

/**
 * 解析修图开关指令。
 * 只有"开关词之外没有别的内容"才算指令，避免吃掉"帮我修图把背景换蓝"这类真实请求。
 * @returns {{action:'on'|'off'|'status', minutes:number}|null}
 */
function parseImageEditCommand(text) {
  const raw = String(text ?? '').trim();
  if (!raw || raw.length > 16) return null;
  let s = normalizeCommandText(raw);
  if (!/修图|p图|修照片|p照片|图片编辑/.test(s)) return null;
  // 时长：修图开 30分钟 / 修图开 1小时
  let minutes = 0;
  const dm = /(\d+)(分钟|分|min|小时|个小时|h)$/.exec(s);
  if (dm) {
    const n = Number(dm[1]);
    minutes = /小时|h/.test(dm[2]) ? n * 60 : n;
    s = s.slice(0, dm.index);
  }
  s = s.replace(/开关/g, '');   // 「修图开关」= 查状态，别把「关」当成关闭
  const isOn = /^(?:开启|启用|打开|开|on)/.test(s) || /(?:开|开启|打开|启用|on)$/.test(s);
  const isOff = /^(?:关闭|关掉|停用|关|off)/.test(s) || /(?:关|关闭|关掉|停用|off)$/.test(s);
  // 把可识别的词全部剥掉，剩下的应当为空（否则说明是正常对话）
  const rest = s
    .replace(/^(?:请|帮我|给我|把|我要|我想|麻烦)/, '')
    .replace(/(?:修图|p图|修照片|p照片|图片编辑|功能|开关|模式|一下)/g, '')
    .replace(/(?:开启|启用|打开|关闭|关掉|停用|开|关|on|off|的|了|吧|吧！)/g, '');
  if (rest.length > 0) return null;
  if (isOn && !isOff) return { action: 'on', minutes };
  if (isOff && !isOn) return { action: 'off', minutes: 0 };
  return { action: 'status', minutes: 0 };
}

/** 聊天键 → 目录名。 */
function sanitizeDir(chatKey) {
  return String(chatKey).replace(/[^a-zA-Z0-9_-]/g, '-');
}

/**
 * 解析聊天键。
 *  - 私聊：private:<QQ号>            → workspaceKey 同聊天键
 *  - 群聊：group:<群号>:<QQ号>       → workspaceKey = group:<群号>（群里所有成员共用一个工作区）
 * 群聊键从 2026-10-24 起带发言人 QQ 号：群里每个人一个会话，但都落在同一个群工作区里。
 * 兼容老写法 group:<群号>（老版本只有群级会话），它会被当成该群的群级键。
 */
function parseChatKey(chatKey) {
  const parts = String(chatKey ?? '').split(':');
  if (parts[0] === 'group') {
    const groupId = parts[1] ?? '';
    return {
      type: 'group',
      groupId,
      userId: parts[2] ?? '',
      workspaceKey: `group:${groupId}`,
    };
  }
  if (parts[0] === 'private') {
    const userId = parts[1] ?? '';
    return { type: 'private', groupId: '', userId, workspaceKey: `private:${userId}` };
  }
  return { type: 'unknown', groupId: '', userId: '', workspaceKey: String(chatKey ?? '') };
}

/** 消息事件 → 聊天键（群聊带上发言人，各人独立会话）。 */
function chatKeyForEvent(event) {
  if (event?.message_type === 'group') return `group:${event.group_id}:${event.user_id}`;
  return `private:${event.user_id}`;
}

/** 从聊天键取出对应的发送者私聊键（群聊时用于回退到该用户的人格）。 */
function senderKeyOf(chatKey) {
  const parsed = parseChatKey(chatKey);
  return parsed.userId ? `private:${parsed.userId}` : undefined;
}

/** 读取昵称缓存（群名 / 成员昵称 / 私聊昵称），重启后不用重新问一遍机器人。 */
function loadNameCache(filePath) {
  try {
    if (!statSync(filePath).isFile()) return {};
  } catch {
    return {};
  }
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed;
  } catch {
    return {};
  }
}

/** 全局共用规则（personas.json.rules）一次最多拼多少字，防止把提示词撑爆。 */
const PERSONA_RULES_MAX_CHARS = 6000;

/**
 * 组合最终注入给 Agent 的人格提示词：基础能力规则 + 修图能力 + 用户自定义性格 + 全局共用规则。
 * 基础规则负责说明 QQ 的收发能力（图片/语音/格式约定），性格部分由用户自定义。
 * 注意：本函数在模块作用域，拿不到 runBridge 里的 config，所有配置都从 options 传入。
 */
export function composePersonaText(persona, options = {}) {
  const lines = [...BASE_RULES];
  if (options.imageEdit) lines.push(...imageEditRules(options));
  else lines.push(...IMAGE_EDIT_OFF_HINT);
  if (options.groupMemoryFile) {
    lines.push(
      '',
      '【群聊共享记忆】',
      `你现在在一个 QQ 群里聊天（群：${options.groupName || '本群'}）。群里每个成员的对话各开一个会话，但都落在同一个群工作区里，共用一份群记忆：`,
      options.groupMemoryFile,
      '值得长期记住的群内信息（大家的称呼、喜好、约定、计划、群里发生过的事）直接写进那个文件，一行一条，用中文；',
      '别往里写密码、验证码和别人的隐私。桥接会在每条消息前把该文件内容附在开头，群内所有人的会话都看得到。',
    );
  }
  if (persona?.prompt) {
    lines.push(
      '',
      `【当前性格模式：${persona.mode}】`,
      '请严格按下面的性格设定来说话（语气、用词、态度都要体现出来，但不要自称在"扮演"）：',
      persona.prompt,
    );
  }
  // 全局共用规则（personas.json 的 rules）：以前页面写了这一栏、桥接根本没读，现在真的拼进来。
  // 已经被当前模式正文覆盖的（前 24 个字一样）不重复加，免得同一个意思说两遍白烧 token。
  const ruleEntries = persona?.rules && typeof persona.rules === 'object' && !Array.isArray(persona.rules)
    ? Object.entries(persona.rules)
    : [];
  if (ruleEntries.length) {
    const body = String(persona?.prompt ?? '');
    const picked = [];
    let used = 0;
    for (const [name, text] of ruleEntries) {
      const value = String(text ?? '').trim();
      if (!value) continue;
      const head = value.slice(0, 24);
      if (head && body.includes(head)) continue;
      if (used + value.length > PERSONA_RULES_MAX_CHARS) continue;
      used += value.length;
      picked.push(`· ${name}：${value}`);
    }
    if (picked.length) {
      lines.push('', '【共用规则】所有人格都适用，和上面的性格设定一起生效：', ...picked);
    }
  }
  // 备用风格：只影响本次注入的文本，绝不写回 persona（否则设定签名会抖，每条消息都重复注入）
  const variant = rollVariant(persona);
  if (variant) lines.push('', `这次的说话风格临时换成：${variant}`);
  lines.push('', personaToolHint(options.personaFile));
  return lines.join('\n');
}

/** 修图能力关闭时的说明：让 Agent 引导用户按需开启，而不是硬凑或直接拒绝。 */
const IMAGE_EDIT_OFF_HINT = [
  '',
  '【修图 / P图】本会话的修图能力默认关闭（省 token，也避免误触发）。',
  '对方要修图 / P图 / 抠图 / 证件照 / 表情包 / 打码 / 加字时，不要自己写脚本硬凑，也不用说"我做不到"，',
  '直接回一句：修图能力还没开，发「修图开」就能启用（也可以发「修图开 30分钟」只在半小时内有效，发「修图关」关闭）。',
];

/**
 * 找到可用的 python.exe：优先配置，其次扫 DSH 运行时目录，最后退回 PATH 上的 python。
 * @param {string} [configured] config.imageToolkitPython
 */
function resolvePython(configured) {
  if (configured) return configured;
  const roots = [join(homedir(), '.dsh', 'dsh-runtimes')];
  if (process.env.DSH_RUNTIME_DIR) roots.unshift(process.env.DSH_RUNTIME_DIR);
  for (const root of roots) {
    try {
      for (const name of readdirSync(root)) {
        const candidate = join(root, name, 'dependencies', 'python', 'python.exe');
        if (fileExists(candidate)) return candidate;
      }
    } catch { /* 目录不存在就跳过 */ }
  }
  return 'python';
}

/**
 * 修图（P图）能力说明：把工具箱的调用方式和常用命令直接写进提示词。
 * 关键是给出可复制的完整命令行，否则模型容易凭想象描述效果。
 * @param {{python?: string, toolkit?: string, outDir?: string}} opts
 */
function imageEditRules(opts = {}) {
  const py = opts.python || 'python';
  const tool = opts.toolkit || 'image-craft.py';
  const outDir = opts.outDir || '';
  const outDesc = outDir ? `修图产物统一存到：${outDir}（该目录已存在）` : '修图产物存到输入图同目录';
  const outArg = outDir ? `"${outDir}\\输出名.png"` : '"输出路径"';
  return [
    '',
    '【修图 / P图】对方发来图片并让你修图时，必须用本机工具箱真实处理，不要只描述效果、也不要回答"我不能改图"。',
    `调用方式：& "${py}" "${tool}" <命令> -i "输入图绝对路径" -o ${outArg} [参数...]`,
    `不确定命令时先跑一次：& "${py}" "${tool}" list（会打印全部命令与参数）`,
    '常用命令：',
    '· auto 一键优化 · beautify --smooth 0.7 --whiten 0.3 --rosy 0.15 磨皮美白 · liquify --auto-face --strength 0.4 [--eyes 0.3] 自动瘦脸大眼',
    '· filter --name 日系|胶片|黑白|复古|赛博|港风|夜拍|奶油… 滤镜 · adjust --brightness +20% --contrast 1.2 --saturation 1.15 --temperature 15 --sharpen 1.3 调色',
    '· mosaic --face 自动给脸打码（也可 --box x,y,w,h 指定区域）· cutout --bg transparent|"#438EDB" --shadow 抠图/换底色',
    '· idphoto --spec 一寸|二寸|护照|驾照 --bg 蓝|红|白 证件照 · meme --top "上字" --bottom "下字" 表情包 · text --text "内容" --position bottom --size 56 加字',
    '· collage -i 图1 图2 --cols 2 --labels "1,2" 拼图/长图 · blur --mode portrait 背景虚化 · sketch 素描 · cartoon 动漫风 · glitch 故障风 · pixelate 像素化',
    '· resize --max-side 1280 缩放 · crop --ratio 1:1 裁剪 · rotate --degrees 90 旋转 · compress --target-kb 500 压缩 · round --circle 圆形头像 · overlay --image 贴纸.png 贴图',
    'cutout / beautify / liquify / mosaic --face / idphoto 内部已做人脸识别与抠图，正常情况下不用你算坐标；效果不对可加 --box 或换 --model。',
    outDesc + '，文件名用有意义的中文短语。',
    '做完务必先 read_image 看一眼产物：效果不对就调参数重做，别把明显失败的图发出去。',
    '最后在回复里写 ![简短说明](产物绝对路径)，桥接就会把图发到 QQ。',
    '工具箱覆盖不到的效果，直接写 Python 脚本实现即可（已装 Pillow 12 / numpy 2 / opencv 5 / onnxruntime，中文字体在 C:\\Windows\\Fonts）。',
  ];
}

/** 告诉 Agent 如何帮用户修改性格（用户可以自然语言提需求，Agent 直接改文件）。 */
function personaToolHint(personaFile) {
  return [
    '【性格设置】用户可以随时说"你说话温柔一点""换个毒舌模式"之类的话。',
    '收到这类要求时，你应当直接编辑人格配置文件来落实（不要只口头答应）：',
    `文件路径：${personaFile || join(QB_HOME, 'personas.json')}`,
    '结构：{ "chats": { "<会话键>": { "active": "当前模式名", "modes": { "模式名": "性格描述" } } } }',
    'modes 的值有两种合法写法，都可以用：',
    '① 一整段文字：{ "模式名": "性格描述" }；',
    '② 三段式对象：{ "模式名": { "identity": "是谁", "behavior": "什么时候开口", "replyStyle": "怎么说话", "variants": ["备用风格"], "variantChance": 0.2 } }。',
    '对象里的 variants 是一行一条的备用风格（最多 8 条），variantChance 是每条回复临时换一条的概率（0~1）；想把对象改回文字，直接写成字符串即可，别把对象揉成 "[object Object]" 字符串。',
    '顶层还有 rules：{ "规则名": "正文" }，所有人格共用，会拼进每个会话的提示词。',
    '你的会话键就是本次对话的 chatKey（私聊形如 private:QQ号）。做法：读文件 → 在 modes 里新增或修改该模式 → 把 active 设为它 → 写回文件。',
    '写回后，从下一条消息起新性格自动生效（无需重启）。用户也可以用指令：性格 / 性格 模式名 / 设定性格 模式名：描述 / 删除性格 模式名。',
  ].join('\n');
}

/** 构造一条带标识的 user 消息（与 @deepseek-ai/dsh-llm 的 createUserMessage 同构）。 */
function makeUserMessage(contentText, source) {
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text: contentText }],
    source,
  };
}

/** 从文件名/URL 推断图片扩展名。 */
function guessImageExt(img, contentType) {
  const fromName = extname(String(img.name || '')).toLowerCase();
  if (['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp'].includes(fromName)) return fromName;
  const fromUrl = extname(String(img.url || '').split('?')[0]).toLowerCase();
  if (['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp'].includes(fromUrl)) return fromUrl;
  const ct = String(contentType || '').toLowerCase();
  if (ct.includes('png')) return '.png';
  if (ct.includes('gif')) return '.gif';
  if (ct.includes('webp')) return '.webp';
  if (ct.includes('bmp')) return '.bmp';
  if (ct.includes('jpeg') || ct.includes('jpg')) return '.jpg';
  return '.jpg';
}

/** 判断本地文件是否存在且是普通文件。 */
function fileExists(filePath) {
  try {
    return statSync(filePath).isFile();
  } catch {
    return false;
  }
}

/** 某个会话工作区里的修图产物目录。 */
function editedDirOf(workspacePath) {
  return join(workspacePath, 'edited');
}

/**
 * 给 Promise 加超时，且永不 reject：超时只记一条警告并继续。
 * 用于卸载/重置这类"尽力而为"的收尾工作 —— 卸载流程卡住会让 HMR 的
 * 配置重载队列死锁（改了 cordis.patch.yml 毫无反应，只能重启应用）。
 */
function settleWithTimeout(promise, ms, logger, label) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => {
      logger?.warn?.('%s 超时（%dms），已跳过等待', label ?? '操作', ms);
      resolve(undefined);
    }, ms);
  });
  return Promise.race([Promise.resolve(promise).catch(() => undefined), timeout])
    .finally(() => clearTimeout(timer));
}

/** 扫一个目录，删掉 cutoff 之前修改的文件；返回删了几个。 */
async function sweepOldFiles(dir, cutoff) {
  let removed = 0;
  let entries = [];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const full = join(dir, entry.name);
    try {
      if (statSync(full).mtimeMs < cutoff) {
        await rm(full, { force: true });
        removed += 1;
      }
    } catch { /* 单个文件失败就跳过 */ }
  }
  return removed;
}

/**
 * 清理工作区根目录下各聊天工作区的过期媒体（attachments/、edited/ 下超过 keepDays 天的文件）。
 * 在后台跑，任何失败都只记日志，绝不影响桥接启动。
 */
async function sweepOldMedia(root, keepDays) {
  const cutoff = Date.now() - keepDays * 86400000;
  let removed = 0;
  let entries = [];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    for (const sub of ['attachments', 'edited']) {
      removed += await sweepOldFiles(join(root, entry.name, sub), cutoff);
    }
  }
  return removed;
}

/** 直接落在外部工作区里的聊天：媒体平铺在该工作区的 attachments/、edited/ 下。 */
async function sweepFlatMedia(workspacePath, keepDays) {
  if (!workspacePath) return 0;
  const cutoff = Date.now() - keepDays * 86400000;
  let removed = 0;
  for (const sub of ['attachments', 'edited']) {
    removed += await sweepOldFiles(join(workspacePath, sub), cutoff);
  }
  return removed;
}

/**
 * 从语音识别的返回值里取出文字。
 * 兼容几种可能的返回形状：字符串、{ text }、{ transcript }、{ segments: [...] }。
 */
function extractTranscript(result) {
  if (result === undefined || result === null) return '';
  if (typeof result === 'string') return result.trim();
  if (typeof result === 'object') {
    for (const key of ['text', 'transcript', 'result', 'content']) {
      if (typeof result[key] === 'string' && result[key].trim()) return result[key].trim();
    }
    if (Array.isArray(result.segments)) {
      return result.segments
        .map((segment) => (typeof segment?.text === 'string' ? segment.text : ''))
        .join('')
        .trim();
    }
  }
  return '';
}

/**
 * 把 ffmpeg 输出的 WAV 规整成 STT 要求的严格布局：
 * 44 字节头（RIFF + fmt(16) + data），16kHz 单声道 PCM16。
 * ffmpeg 默认会写入 LIST/INFO 元数据块，使 data 块偏移不等于 36，
 * 而 DSH 的语音识别会校验精确偏移，因此必须重建头部。
 */
function canonicalizeWav(buffer) {
  if (buffer.length < 12
    || buffer.toString('ascii', 0, 4) !== 'RIFF'
    || buffer.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('不是有效的 WAV 数据');
  }
  let offset = 12;
  let fmt = null;
  let data = null;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const body = buffer.subarray(offset + 8, Math.min(offset + 8 + size, buffer.length));
    if (id === 'fmt ') fmt = body;
    else if (id === 'data') data = body;
    offset += 8 + size + (size % 2); // 块按偶数字节对齐
  }
  if (!fmt || !data) throw new Error('WAV 缺少 fmt 或 data 块');
  if (fmt.length < 16) throw new Error('WAV fmt 块不完整');

  const audioFormat = fmt.readUInt16LE(0);
  const channels = fmt.readUInt16LE(2);
  const sampleRate = fmt.readUInt32LE(4);
  const bitsPerSample = fmt.readUInt16LE(14);
  if (audioFormat !== 1 || channels !== 1 || sampleRate !== 16000 || bitsPerSample !== 16) {
    throw new Error(`音频参数不符（需 16kHz 单声道 PCM16）：format=${audioFormat} ch=${channels} rate=${sampleRate} bits=${bitsPerSample}`);
  }
  const pcm = data.length % 2 === 0 ? data : data.subarray(0, data.length - 1);

  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(16000, 24);
  header.writeUInt32LE(32000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/** 从文件名/URL/本地路径推断语音扩展名（QQ 语音常见 silk/amr/mp3/m4a）。 */
function guessAudioExt(voice) {
  const candidates = [
    String(voice.name || ''),
    String(voice.path || ''),
    String(voice.file || '').split('?')[0],
    String(voice.url || '').split('?')[0],
  ];
  for (const candidate of candidates) {
    const ext = extname(candidate).toLowerCase();
    if (['.silk', '.slk', '.amr', '.mp3', '.m4a', '.aac', '.ogg', '.wav', '.flac', '.wma'].includes(ext)) return ext;
  }
  return '.silk';
}

/** 运行一个子进程并收集输出；用于 ffmpeg 转码。 */
function runProcess(command, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(command, args, { windowsHide: true });
    } catch (error) {
      reject(error);
      return;
    }
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        try { child.kill(); } catch { /* 忽略 */ }
        reject(new Error(`进程超时（${command}）`));
      }
    }, timeoutMs);
    child.stdout?.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr?.on('data', (chunk) => { stderr += String(chunk); });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

/** 带超时地拉取一个 URL，返回 Buffer。 */
async function fetchBuffer(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const type = response.headers.get('content-type') ?? '';
    return { buffer: Buffer.from(await response.arrayBuffer()), contentType: type };
  } finally {
    clearTimeout(timer);
  }
}

/** 保留当前应用选择的 reasoningEffort（仅在未显式指定 provider/model 时沿用）。 */
function installModelSelection(agentCtx, selection) {
  agentCtx.on('agent/request', async ({ agent }, next) => {
    const resolved = await next();
    if (agent.session.requestHeader() !== undefined) return resolved;
    if (resolved.provider !== selection.provider || resolved.model !== selection.model) return resolved;
    const { reasoningEffort: _ignored, ...rest } = resolved;
    return {
      ...rest,
      ...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort }),
    };
  });
}

// ── 设置页（「设置 → QQ 桥接」）用的文件与 HTTP 小工具 ──────────────
/** 设置页覆盖层的默认位置：和 sessions.json / personas.json 放同一个目录。 */
const DEFAULT_UI_SETTINGS_FILE = join(QB_HOME, 'settings-ui.json');
/** 备份最多留几份。 */
const UI_SETTINGS_BACKUP_KEEP = 20;

/** 时间戳：20261024-114500 */
function uiStamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** 文件 mtime（毫秒）；文件不存在 / 不是文件返回 0。 */
function fileMtimeMs(file) {
  try {
    const st = statSync(file);
    return st.isFile() ? st.mtimeMs : 0;
  } catch {
    return 0;
  }
}

/** 读设置覆盖层；坏 JSON 不抛，返回 error 交给页面提示。 */
function readUiSettings(file) {
  const mtimeMs = fileMtimeMs(file);
  if (!mtimeMs) return { exists: false, mtimeMs: 0, values: {} };
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    const values = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    return { exists: true, mtimeMs, values };
  } catch (error) {
    return {
      exists: true,
      mtimeMs,
      values: {},
      error: `设置文件不是合法 JSON（${String(error?.message ?? error)}），已按空设置处理`,
    };
  }
}

/** 清理旧备份，只留最近 UI_SETTINGS_BACKUP_KEEP 份（只动自己生成的文件名）。 */
function pruneUiBackups(file) {
  try {
    const dir = dirname(file);
    const base = basename(file) + '.bak-';
    const backups = readdirSync(dir).filter((name) => name.startsWith(base)).sort().reverse();
    for (const name of backups.slice(UI_SETTINGS_BACKUP_KEEP)) {
      try { unlinkSync(join(dir, name)); } catch { /* 删不掉不影响保存 */ }
    }
  } catch { /* 目录读不了就跳过 */ }
}

/** 备份旧设置文件 + 原子写新设置文件。 */
function writeUiSettings(file, values) {
  const dir = dirname(file);
  mkdirSync(dir, { recursive: true });
  let backup = null;
  if (fileMtimeMs(file)) {
    backup = `${file}.bak-${uiStamp()}`;
    try { copyFileSync(file, backup); } catch { backup = null; }
    pruneUiBackups(file);
  }
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, `${JSON.stringify(values, null, 2)}\n`, 'utf8');
  try {
    renameSync(tmp, file);
  } catch (error) {
    try { unlinkSync(tmp); } catch { /* ignore */ }
    throw error;
  }
  return { backup, mtimeMs: fileMtimeMs(file) };
}

/** 统一 JSON 响应。 */
function sendJson(res, code, payload) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(payload));
}

/** 读请求体（限 1MB，设置页够用）。 */
function readJsonBody(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) { reject(new Error('请求体太大')); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/**
 * allowlist 的一项归一化成纯 QQ 号。
 * 只认「开头就是 5~12 位数字」的写法；`10001.67890` 这种手滑拼进来的
 * 取前面那段数字（否则本人会被挡在门外，机器人就像坏了一样）。
 * @returns {string} 纯数字 QQ 号；认不出来返回空串
 */
function normalizeAllowEntry(value) {
  const text = String(value ?? '').trim();
  if (!text) return '';
  if (/^\d{5,12}$/.test(text)) return text;
  const leading = /^(\d{5,12})(?=\D|$)/.exec(text);
  return leading ? leading[1] : '';
}

/**
 * 把整份 allowlist 归一化，并记下被修过的脏值（空数组 = 不限制）。
 * @param {unknown} list - 原始 allowlist
 * @param {{ warn: Function }} log - 插件 logger
 * @returns {string[]}
 */
function normalizeAllowlist(list, log) {
  if (!Array.isArray(list)) return [];
  const cleaned = [];
  const dropped = [];
  for (const item of list) {
    const value = normalizeAllowEntry(item);
    if (value) {
      if (!cleaned.includes(value)) cleaned.push(value);
      if (value !== String(item ?? '').trim()) dropped.push(String(item ?? ''));
    } else if (String(item ?? '').trim()) {
      dropped.push(String(item ?? ''));
    }
  }
  if (dropped.length > 0) {
    log?.warn?.('allowlist 里有写坏的项，已自愈/忽略：%s -> %s', JSON.stringify(dropped), JSON.stringify(cleaned));
  }
  return cleaned;
}

/** 插件入口：标准 cordis 插件 (ctx, config)。 */
export default function qqBridge(ctx, rawConfig) {
  // 用 ctx.inject 声明依赖服务（插件函数上的 inject 属性同样声明，二者任一即可）。
  // 注意：语音识别服务（speechToText）刻意不写进 inject——它是可选的，
  // 若写进来，STT 插件未就绪时整个桥接会一直等待、端口都不开。
  // 改在转写时用 ctx.get('speechToText') 惰性查找，缺失时优雅降级。
  return ctx.inject([
    'agents',
    'agentDefaultModel',
    'agentPresets',
    'permissionPresets',
    'sessionTitle',
    'workspaceRegistry',
    // 设置页控制面（/dsh-qq-bridge/api/*）：HTTP 路由与信任栅栏
    'webServer',
    'connection',
  ], (injected) => runBridge(injected, rawConfig));
}

/** 插件主体：拿到已注入服务的 ctx 后运行桥接。 */
function runBridge(ctx, rawConfig) {
  const log = ctx.logger('qq-bridge');

  // ── 设置页覆盖层 ────────────────────────────────────────────────
  // 「设置 → QQ 桥接」页写这份 JSON；优先级 DEFAULTS < cordis 配置 < 设置文件。
  // 保存后立刻生效（传输相关字段会自动重开 WS），不用重启 DSH。
  const settingsFile = (typeof rawConfig?.uiSettingsFile === 'string' && rawConfig.uiSettingsFile.trim())
    || DEFAULT_UI_SETTINGS_FILE;
  const initialSettings = readUiSettings(settingsFile);
  if (initialSettings.error) log.warn('%s', initialSettings.error);
  const config = { ...DEFAULTS, ...(rawConfig ?? {}), ...initialSettings.values };
  // allowlist 只认纯 QQ 号；写脏了会让允许的人被挡在外面（表现就是「机器人不回我」）
  config.allowlist = normalizeAllowlist(config.allowlist, log);
  if (Object.keys(initialSettings.values).length > 0) {
    log.info('设置页覆盖层已加载：%s（%s）', settingsFile, Object.keys(initialSettings.values).join('、'));
  }
  const workspaceRoot = config.workspaceRoot
    || join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'qq-workspaces');

  /**
   * 「聊天键 → 工作区目录」的显式映射（config.workspaceMap）。
   * 让某些聊天直接落在 DSH 已经建好的工作区里（例如某个项目工作区的绝对目录），
   * 而不是默认的 $DSH_HOME/qq-workspaces/<工作区键>/。
   *
   * 注意：DSH 会话的 cwd 在**创建时**写死，改映射只对之后新建的会话生效；
   * 要把已经在跑的会话换到别的目录，得清掉 sessions.json 里对应的条目（旧会话留在归档里）。
   */
  let workspaceMap = config.workspaceMap && typeof config.workspaceMap === 'object'
    ? config.workspaceMap
    : {};
  /** 某个聊天的显式工作区映射：群聊先看「群+成员」键，再看「群」键（整群一起映射）。 */
  function mappedWorkspacePath(chatKey) {
    const parsed = parseChatKey(chatKey);
    const keys = parsed.workspaceKey && parsed.workspaceKey !== chatKey
      ? [chatKey, parsed.workspaceKey]
      : [chatKey];
    for (const key of keys) {
      const mapped = workspaceMap[key];
      if (typeof mapped === 'string' && mapped.trim()) return mapped.trim();
    }
    return '';
  }
  /** 某个聊天该落在哪个目录：有映射用映射，否则用默认的 qq-workspaces/<工作区键>。群聊按群号共用目录。 */
  const workspacePathFor = (chatKey) => {
    const mapped = mappedWorkspacePath(chatKey);
    if (mapped) return mapped;
    const root = config.workspaceRoot || workspaceRoot;
    return join(root, sanitizeDir(parseChatKey(chatKey).workspaceKey));
  };
  /** 映射目录的标题沿用目录名（去掉 02_ 这类编号前缀）。 */
  const workspaceTitleForPath = (dirPath) => basename(dirPath).replace(/^\d+_/, '');

  /**
   * 取（或补登记）某个聊天的工作区。
   * - 有显式映射：沿用映射目录的原标题（比如 02_项目名），不按昵称改名。
   * - 桥接自己建的：标题 = 调用方给的昵称/群名（preferredTitle），拿不到就退回 QQ <键>。
   */
  async function ensureWorkspaceFor(chatKey, preferredTitle) {
    const dirPath = workspacePathFor(chatKey);
    await mkdir(join(dirPath, 'attachments'), { recursive: true });
    const mapped = !!mappedWorkspacePath(chatKey);
    let existing;
    try {
      existing = ctx.workspaceRegistry.list().find(
        (ws) => ws.path && ws.path.toLowerCase() === dirPath.toLowerCase(),
      );
    } catch (error) {
      log.warn('列出工作区失败：%s', error?.message ?? error);
    }
    if (existing) {
      if (!mapped && preferredTitle && existing.title !== preferredTitle) {
        try {
          await existing.setTitle(preferredTitle);
          log.info('工作区改名：%s -> %s', existing.title, preferredTitle);
        } catch (error) {
          log.warn('工作区改名失败（%s）：%s', dirPath, error?.message ?? error);
        }
      }
      return existing;
    }
    const title = mapped
      ? (workspaceTitleForPath(dirPath) || undefined)
      : (preferredTitle || `QQ ${chatKey}`);
    const workspace = await ctx.workspaceRegistry.create(dirPath, title);
    log.info('工作区就绪：%s（标题：%s%s）', dirPath, workspace.title, mapped ? '，来自映射' : '，来自昵称');
    return workspace;
  }
  /** 生效中的映射（去掉空值），用于启动日志和媒体清理。 */
  const activeWorkspaceMap = Object.fromEntries(
    Object.entries(workspaceMap)
      .filter(([, path]) => typeof path === 'string' && path.trim())
      .map(([key, path]) => [key, path.trim()]),
  );
  {
    const keys = Object.keys(activeWorkspaceMap);
    if (keys.length > 0) {
      log.info('聊天工作区映射：%s', keys.map((key) => `${key} -> ${activeWorkspaceMap[key]}`).join('；'));
    }
  }

  // 运行态快照：DSH 的插件日志不进文件，排查时靠它确认现在跑的到底是哪版代码、
  // 拿到了哪份配置（尤其是 workspaceMap / 设置页覆盖层有没有生效）。
  const startedAt = new Date().toISOString();
  const runtimeFile = join(dirname(config.sessionFile), 'bridge-runtime.json');
  /** 生效中的工作区映射（去掉空值）。 */
  const activeWorkspaceMapNow = () => Object.fromEntries(
    Object.entries(workspaceMap)
      .filter(([, path]) => typeof path === 'string' && path.trim())
      .map(([key, path]) => [key, path.trim()]),
  );
  /** 表情包库现状（给运行态快照和设置页看）。 */
  function stickerSummary() {
    const chatsWithStickers = {};
    let total = 0;
    try {
      for (const name of readdirSync(config.stickerDir)) {
        let names;
        try {
          if (!statSync(join(config.stickerDir, name)).isDirectory()) continue;
          names = readdirSync(join(config.stickerDir, name));
        } catch { continue; }
        const count = names.filter((item) => SENDABLE_IMAGE_EXT.has(extname(item).toLowerCase())).length;
        if (count > 0) { chatsWithStickers[name] = count; total += count; }
      }
    } catch { /* 目录还没建 */ }
    return {
      enabled: config.stickerEnabled === true,
      chance: clampProbability(config.stickerChance, 0.4),
      dir: config.stickerDir,
      total,
      chats: chatsWithStickers,
    };
  }

  /** 主动消息现状（给运行态快照和设置页看）。 */
  function wakeSummary() {
    return {
      enabled: config.wakeEnabled === true,
      intervalMinutes: Number(config.wakeIntervalMinutes) || 0,
      chance: clampProbability(config.wakeChance, 0.6),
      targets: wakeTargetKeys(),
      nextCheckAt: wakeState.nextCheckAt,
      lastCheckAt: wakeState.lastCheckAt,
      lastRoll: wakeState.lastRoll,
      lastWakeAt: wakeState.lastWakeAt,
      lastResult: wakeState.lastResult,
    };
  }
  /** 把运行态落盘（启动、改设置、改传输后各写一次）。 */
  function writeRuntimeSnapshot(extra = {}) {
    const snapshot = {
      startedAt,
      updatedAt: new Date().toISOString(),
      pid: process.pid,
      mode: config.mode,
      host: config.host,
      port: config.port,
      paused,
      sockets: sockets.size,
      transport: wss ? 'listening' : (client ? 'client-connected' : 'off'),
      workspaceRoot: config.workspaceRoot || workspaceRoot,
      workspaceMap: activeWorkspaceMapNow(),
      mediaRetentionDays: config.mediaRetentionDays,
      resumeOnStart: config.resumeOnStart,
      allowlist: config.allowlist,
      settingsFile,
      stickers: stickerSummary(),
      wake: wakeSummary(),
      features: ['workspaceMap', 'flat-media-sweep', 'runtime-snapshot', 'settings-api',
        'nickname-workspace-titles', 'group-require-at', 'group-rate-limit',
        'group-per-user-sessions', 'group-shared-memory', 'stickers', 'wake-up'],
      ...extra,
    };
    writeFile(runtimeFile, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8')
      .catch((error) => log.warn('写入运行态快照失败：%s', error?.message ?? error));
    return snapshot;
  }

  // 映射到「已有工作区」的聊天：启动时把工作区登记好、标题统一成目录名去掉编号前缀
  // （例如 ...\分区\02_项目名 -> 项目名），这样侧边栏里看到的就是已有的工作区名字。
  // create() 对已登记目录是幂等的：只补登记，不重复建，也不动已有会话。
  void (async () => {
    for (const [chatKey, mappedPath] of Object.entries(activeWorkspaceMap)) {
      try {
        await mkdir(mappedPath, { recursive: true });
        const title = basename(mappedPath).replace(/^\d+_/, '');
        const ws = await ctx.workspaceRegistry.create(mappedPath, title || undefined);
        if (title && ws.title !== title) await ws.setTitle(title);
        log.info('会话工作区就绪：%s -> %s（标题：%s）', chatKey, ws.path, ws.title);
      } catch (error) {
        log.warn('准备会话工作区失败（%s -> %s）：%s', chatKey, mappedPath, error?.message ?? error);
      }
    }

    // 清理历史遗留：同一个聊天改映射前，桥接在 qq-workspaces/<聊天键> 下建过的旧工作区登记。
    // 只删「工作区登记」（相当于从侧边栏移除项目），目录文件和会话日志原样保留；
    // 只处理 workspaceMap 里明确列出的聊天，且旧工作区里还有会话时一律跳过。
    if (config.pruneLegacyWorkspaces === true) {
      for (const chatKey of Object.keys(activeWorkspaceMap)) {
        const mapped = activeWorkspaceMap[chatKey];
        const legacy = join(workspaceRoot, sanitizeDir(chatKey));
        if (legacy.toLowerCase() === mapped.toLowerCase()) continue;
        for (const ws of ctx.workspaceRegistry.list()) {
          if (ws.path.toLowerCase() !== legacy.toLowerCase()) continue;
          if (ws.sessionIds.length > 0) {
            log.warn('遗留工作区 %s 里还有 %d 个会话，保留登记不动', ws.path, ws.sessionIds.length);
            continue;
          }
          try {
            await ctx.workspaceRegistry.delete(ws.id);
            log.info('已移除遗留工作区登记：%s（目录和会话文件都没动）', ws.path);
          } catch (error) {
            log.warn('移除遗留工作区登记失败（%s）：%s', ws.path, error?.message ?? error);
          }
        }
      }
    }
  })();

  /** 惰性获取语音识别服务；未挂载时返回 undefined。 */
  const getSpeechToText = () => {
    try {
      return ctx.get('speechToText');
    } catch (error) {
      log.warn('获取语音识别服务失败：%s', error?.message ?? error);
      return undefined;
    }
  };

  // 启动时报告一次语音服务可用性，便于排查
  try {
    const stt = getSpeechToText();
    log.info('语音识别服务：%s', stt
      ? `已挂载（提供方：${(stt.listProviders?.() ?? []).map((p) => p.id).join(', ') || '无'}）`
      : '未挂载（语音消息将无法转写，其余功能正常）');
  } catch { /* 忽略 */ }

  // 启动时报告一次修图工具箱可用性（能力本身按需开启）
  {
    const py = resolvePython(config.imageToolkitPython);
    const toolOk = fileExists(config.imageToolkit);
    log.info('修图工具箱：%s（python=%s；默认%s，发「修图开」按需启用）',
      toolOk ? config.imageToolkit : `未找到 ${config.imageToolkit}`,
      py, config.imageEditEnabled ? '开启' : '关闭');
  }

  // 清理过期的附件/修图产物（后台跑，失败不影响启动）
  if (config.mediaRetentionDays > 0) {
    sweepOldMedia(workspaceRoot, config.mediaRetentionDays)
      .then((n) => { if (n > 0) log.info('已清理 %d 个过期媒体文件（>%d 天）', n, config.mediaRetentionDays); })
      .catch((error) => log.warn('清理过期媒体失败：%s', error?.message ?? error));
    // 映射到外部工作区的聊天：媒体直接放在该工作区的 attachments/edited 下
    for (const [key, mappedPath] of Object.entries(activeWorkspaceMap)) {
      sweepFlatMedia(mappedPath, config.mediaRetentionDays)
        .then((n) => { if (n > 0) log.info('已清理 %s 的 %d 个过期媒体文件（>%d 天）', key, n, config.mediaRetentionDays); })
        .catch((error) => log.warn('清理 %s 过期媒体失败：%s', key, error?.message ?? error));
    }
  }

  const sockets = new Set();   // 已连接的 OneBot WS
  const chats = new Map();     // chatKey -> { handle, workspace, sessionId, queue }
  const rotationLocks = new Map(); // chatKey -> 进行中的上下文轮换 Promise（防止并发消息抢建两个会话）
  let wss = null;
  let client = null;
  let stopped = false;
  let paused = false;          // 设置页「暂停桥接」：暂停后不监听、不连接，会话都保留
  let transportGen = 0;        // 传输代际：重开时让上一代的 client 重连定时器失效
  // ── 主动消息（定时醒来）运行态 ────────────────────────────────
  let wakeTimer = null;
  const wakeState = {
    lastCheckAt: 0,   // 上次掷骰子的时间
    lastRoll: null,   // 上次掷出的点数（0~1）
    lastWakeAt: 0,    // 上次真的发出主动消息的时间
    lastResult: '',   // 上次结果（没掷中 / 未连接 / 已发送…）
    nextCheckAt: 0,   // 下次掷骰子的时间
    lastTargets: [],  // 上次醒来发给谁
  };

  writeRuntimeSnapshot();

  const logError = (error) => {
    const chain = [];
    let current = error;
    while (current && chain.length < 4) {
      chain.push(current?.message ?? String(current));
      current = current?.cause;
    }
    log.warn(chain.join(' <- '));
  };

  // ── OneBot 出站：把 action 请求广播给所有已连接端 ──────────────
  function broadcast(object) {
    const text = JSON.stringify(object);
    for (const socket of sockets) {
      if (socket.readyState === WebSocket.OPEN) socket.send(text);
    }
  }

  function sendAction(action, params) {
    broadcast({ action, params, echo: `qq-${randomUUID()}` });
  }

  // ── OneBot 请求/响应（按 echo 关联）─────────────────────────
  /** echo -> { resolve, reject, timer } */
  const pendingActions = new Map();

  /**
   * 发一个 action 并等待机器人返回结果（带超时）。
   * 用于 get_record 这类需要返回值的接口。
   */
  function sendActionAwait(action, params, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      const echo = `qq-await-${randomUUID()}`;
      const timer = setTimeout(() => {
        pendingActions.delete(echo);
        reject(new Error(`${action} 超时（${timeoutMs}ms）`));
      }, timeoutMs);
      pendingActions.set(echo, { resolve, reject, timer });
      broadcast({ action, params, echo });
    });
  }

  /** 处理机器人回包；返回是否已消费。 */
  function settlePendingAction(data) {
    const echo = data?.echo;
    if (!echo || !pendingActions.has(echo)) return false;
    const pending = pendingActions.get(echo);
    pendingActions.delete(echo);
    clearTimeout(pending.timer);
    if (data.status === 'ok' || data.retcode === 0) pending.resolve(data.data ?? {});
    else pending.reject(new Error(data.message || data.wording || `${data.status ?? 'failed'} (retcode ${data.retcode})`));
    return true;
  }

  // ── 语音转码（借 NapCat 的 SILK 解码能力）─────────────────────
  /**
   * 让 NapCat 把 QQ 语音（SILK 编码）转成通用音频格式。
   * QQ 语音文件实际是 SILK 编码（哪怕后缀是 .amr），ffmpeg 无法直接解码，
   * 所以必须借 NapCat 的 get_record 接口转码。
   * @returns {Promise<Buffer>} 转码后的音频字节
   */
  async function convertVoiceViaNapCat(voice) {
    const fileRef = voice.file || voice.name || voice.path;
    if (!fileRef) throw new Error('语音缺少 file 标识，无法转码');
    const data = await sendActionAwait('get_record', {
      file: fileRef,
      out_format: config.voiceConvertFormat,
    }, 60000);
    if (config.debugInbound) {
      log.info('[voice] get_record 返回：file=%s size=%s base64=%s',
        String(data.file ?? '').slice(0, 120), data.file_size ?? '?', data.base64 ? 'yes' : 'no');
    }
    // 优先用返回的本地文件路径（NapCat 已转码到磁盘）
    if (typeof data.file === 'string' && data.file) {
      const candidate = data.file.startsWith('file://')
        ? decodeURIComponent(data.file.replace(/^file:\/\/\/?/, ''))
        : data.file;
      if (fileExists(candidate)) return await readFile(candidate);
    }
    // 退回 base64
    if (typeof data.base64 === 'string' && data.base64) {
      return Buffer.from(data.base64, 'base64');
    }
    throw new Error('get_record 未返回可用音频');
  }

  // ── 图片下载 ─────────────────────────────────────────────────
  /**
   * 选一个可用的媒体来源。
   * 优先级：本地已存在的文件（NapCat 的 path / 绝对路径 file）> 远程 url > data URL。
   * NapCat 真实语音里 file 常常只是文件名，必须靠 path 才能拿到本地文件。
   */
  function resolveMediaSource(media) {
    // 1) 显式本地路径（NapCat 的 path 字段）
    if (media.path && fileExists(media.path)) return { kind: 'file', value: media.path };
    // 2) file 若是绝对路径或 file:// 且存在
    if (media.file) {
      const asPath = media.file.startsWith('file://')
        ? decodeURIComponent(media.file.replace(/^file:\/\/\/?/, ''))
        : media.file;
      if (/^([a-zA-Z]:[\\/]|\\\\)/.test(asPath) && fileExists(asPath)) {
        return { kind: 'file', value: asPath };
      }
      if (/^data:/i.test(media.file)) return { kind: 'url', value: media.file };
    }
    // 3) 远程 URL（NapCat 通常给带鉴权的临时下载链接）
    if (media.url) return { kind: 'url', value: media.url };
    // 4) 兜底：file 原样（可能是相对路径或裸文件名）
    if (media.file) return { kind: 'raw', value: media.file };
    return undefined;
  }

  /**
   * 下载/读取一段媒体（图片或语音），返回 Buffer。
   * 支持 http(s)/data URL、NapCat 的本地 path、file:// 与绝对路径。
   */
  async function fetchMedia(media, maxBytes, label) {
    const picked = resolveMediaSource(media);
    if (!picked) throw new Error('未提供可用的文件地址');
    let buffer;
    let contentType = '';
    if (picked.kind === 'file') {
      buffer = await readFile(picked.value);
    } else if (/^https?:\/\//i.test(picked.value)) {
      const got = await fetchBuffer(picked.value, 30000);
      buffer = got.buffer;
      contentType = got.contentType;
    } else if (/^data:/i.test(picked.value)) {
      const comma = picked.value.indexOf(',');
      const meta = picked.value.slice(5, comma);
      const payload = picked.value.slice(comma + 1);
      buffer = meta.includes('base64')
        ? Buffer.from(payload, 'base64')
        : Buffer.from(decodeURIComponent(payload));
      contentType = meta.split(';')[0] ?? '';
    } else {
      throw new Error(`无法识别的文件地址：${String(picked.value).slice(0, 120)}`);
    }
    if (buffer.length === 0) throw new Error('空文件');
    if (buffer.length > maxBytes) {
      throw new Error(`${label}过大（${Math.round(buffer.length / 1024 / 1024)} MB，上限 ${Math.round(maxBytes / 1024 / 1024)} MB）`);
    }
    return { buffer, contentType };
  }

  /**
   * 把消息里的图片下载到该会话工作区的 attachments/ 目录。
   * 返回追加到文本后的说明片段（含本地绝对路径，供 Agent 用 read_image 查看）。
   */
  async function downloadImages(images, workspacePath, event) {
    if (!config.imageEnabled || images.length === 0) return '';
    const dir = join(workspacePath, 'attachments');
    await mkdir(dir, { recursive: true });
    const notes = [];
    for (let i = 0; i < images.length; i += 1) {
      const img = images[i];
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      try {
        const { buffer, contentType } = await fetchMedia(img, config.maxImageBytes, `第 ${i + 1} 张图片`);
        const ext = guessImageExt(img, contentType);
        const filePath = join(dir, `qq-${stamp}-${i + 1}${ext}`);
        await writeFile(filePath, buffer);
        log.info('已保存图片 %s（%d 字节）', filePath, buffer.length);
        // 表情包收藏：对方发来的表情包顺手存进表情包库，之后回复时可以带一张
        const chatKey = chatKeyForEvent(event);
        if (config.stickerEnabled === true
          && looksLikeSticker(img, ext, buffer.length, config.stickerMaxBytes)) {
          try {
            const saved = await saveStickerFile(config.stickerDir, chatKey, buffer, ext);
            await pruneStickerDir(config.stickerDir, chatKey, config.stickerMaxPerChat);
            log.info('已收进表情包库：%s（%s）', saved, chatKey);
          } catch (stickerError) {
            log.warn('收藏表情包失败：%s', stickerError?.message ?? stickerError);
          }
        }
        notes.push(
          `用户发来第 ${i + 1} 张图片，已保存到本地：${filePath}\n`
          + '请用 read_image 工具查看这张图，再据此回答；不要在回复里粘贴图片路径。',
        );
      } catch (error) {
        log.warn('图片下载失败：%s', error?.message ?? error);
        notes.push(`⚠️ 第 ${i + 1} 张图片无法获取（${error?.message ?? error}）。`);
      }
    }
    if (notes.length === 0) return '';
    return `\n\n[图片附件]\n${notes.join('\n')}`;
  }

  // ── 语音识别 ─────────────────────────────────────────────────

  /** 把任意音频转成 SenseVoice 要求的 16kHz 单声道 PCM16 WAV（规范 44 字节头）。 */
  async function transcodeToWav(inputPath, outputPath) {
    const out = await runProcess(
      config.ffmpegPath,
      ['-hide_banner', '-loglevel', 'error', '-y',
        // 抑制 ffmpeg 写入 LIST/INFO 元数据块，尽量直接产出规范 WAV
        '-fflags', '+bitexact', '-flags', '+bitexact',
        '-i', inputPath,
        '-ac', '1', '-ar', '16000', '-acodec', 'pcm_s16le', '-f', 'wav', outputPath],
      60000,
    );
    if (out.code !== 0) {
      throw new Error(`ffmpeg 转码失败（退出码 ${out.code}）：${(out.stderr || out.stdout || '').trim().slice(0, 200)}`);
    }
    // 双保险：重建规范头部，确保 STT 的严格校验通过
    return canonicalizeWav(await readFile(outputPath));
  }

  /**
   * 把消息里的语音下载、转码并识别成文字。
   * 返回追加到文本后的说明片段（含识别结果）。
   */
  async function transcribeVoices(voices, workspacePath, event) {
    if (!config.voiceEnabled || voices.length === 0) return '';
    const dir = join(workspacePath, 'attachments');
    await mkdir(dir, { recursive: true });
    const notes = [];

    // 语音识别服务是否可用（DSH 未挂载 STT 插件时为 undefined）
    const stt = getSpeechToText();
    if (!stt) {
      log.warn('语音识别服务不可用（speechToText 未挂载），跳过 %d 条语音', voices.length);
      for (let i = 0; i < voices.length; i += 1) {
        notes.push(
          `用户发来第 ${i + 1} 条语音，但本机语音识别服务未启用，你听不到内容。`
          + '请在回复里客气地说明你暂时无法收听语音，请对方打字。',
        );
      }
      return `\n\n[语音附件]\n${notes.join('\n')}`;
    }

    for (let i = 0; i < voices.length; i += 1) {
      const voice = voices[i];
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const rawPath = join(dir, `qq-voice-${stamp}-${i + 1}${guessAudioExt(voice)}`);
      const wavPath = join(dir, `qq-voice-${stamp}-${i + 1}.wav`);
      try {
        let buffer;
        let via = 'napcat';
        // 1) 首选：让 NapCat 转码（QQ 语音是 SILK，ffmpeg 解不了）
        try {
          buffer = await convertVoiceViaNapCat(voice);
        } catch (convertError) {
          if (config.debugInbound) log.warn('[voice] NapCat 转码失败，回退本地解码：%s', convertError?.message ?? convertError);
          via = 'direct';
          // 2) 回退：直接取原始文件（适用于对方发的是普通 mp3/wav/m4a 等）
          const got = await fetchMedia(voice, config.maxVoiceBytes, `第 ${i + 1} 条语音`);
          buffer = got.buffer;
        }
        await writeFile(rawPath, buffer);
        log.info('已获取语音 %s（%d 字节，来源 %s）', rawPath, buffer.length, via);

        // 转成 16k 单声道 PCM16 WAV（返回规范化后的字节）
        const wav = await transcodeToWav(rawPath, wavPath);
        await writeFile(wavPath, wav);

        // 走 DSH 的语音识别服务
        const request = { audio: new Uint8Array(wav), language: config.speechLanguage };
        if (config.speechProvider) request.providerId = config.speechProvider;
        const spec = stt.resolve(request);
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 120000);
        let result;
        try {
          if (config.debugInbound) {
            log.info('[stt] 调用识别：provider=%s language=%s wavBytes=%d',
              spec.provider?.info?.id ?? '?', spec.language, wav.length);
          }
          result = await stt.transcribe(spec, controller.signal);
          if (config.debugInbound) log.info('[stt] 原始返回：%s', JSON.stringify(result).slice(0, 300));
        } finally {
          clearTimeout(timer);
        }
        const transcript = extractTranscript(result);
        if (config.debugInbound) {
          try {
            const { appendFileSync } = await import('node:fs');
            appendFileSync(DEBUG_LOG_FILE,
              `${new Date().toISOString()} [stt] ok transcript=${JSON.stringify(transcript).slice(0, 200)} rawResult=${JSON.stringify(result).slice(0, 300)}\n`);
          } catch { /* 忽略 */ }
        }
        if (transcript) {
          log.info('语音识别成功（第 %d 条）：%s', i + 1, transcript.slice(0, 80));
          notes.push(
            `用户发来第 ${i + 1} 条语音，识别出的文字是：\n"""${transcript}"""\n`
            + '请把这当作对方说的话来回应；不要提“语音转文字”这件事，直接自然地回答内容。',
          );
        } else {
          notes.push(`用户发来第 ${i + 1} 条语音，但识别结果为空（可能是静音或环境噪声），请在回复里请对方重说一遍。`);
        }
      } catch (error) {
        log.warn('语音处理失败：%s', error?.message ?? error);
        if (config.debugInbound) {
          try {
            const { appendFileSync } = await import('node:fs');
            appendFileSync(DEBUG_LOG_FILE,
              `${new Date().toISOString()} [stt] FAILED ${error?.message ?? error}\n${String(error?.stack ?? '').slice(0, 500)}\n`);
          } catch { /* 忽略 */ }
        }
        notes.push(`⚠️ 第 ${i + 1} 条语音处理失败（${error?.message ?? error}），无法听清。`);
      }
    }
    if (notes.length === 0) return '';
    return `\n\n[语音附件]\n${notes.join('\n')}`;
  }

  /**
   * 把 Agent 回复发给消息来源（私聊或群聊）。
   *
   * 回复里的 markdown 图片语法 `![alt](路径)` 会被识别成 OneBot image 段，
   * 与文本段按原顺序拼在同一条消息里；图片不存在或不可读时退回成文本提示。
   *
   * options.sticker = true 时，按 stickerChance 的概率再补发一张表情包
   * （只给 Agent 的真实回复用；「收到」、状态、帮助这类系统回话不配表情）。
   */
  function sendReply(event, text, options = {}) {
    const segments = buildReplySegments(text, config.maxReplyChars, log);
    for (const segmentChunk of segments) {
      const params = {
        message_type: event.message_type,
        message: segmentChunk,
      };
      if (event.message_type === 'group') params.group_id = event.group_id;
      else params.user_id = event.user_id;
      sendAction('send_msg', params);
    }
    if (options.sticker) maybeSendSticker(event);
  }

  /** 按概率给这个聊天补一张表情包；库里没有就什么也不发。 */
  function maybeSendSticker(event) {
    if (config.stickerEnabled !== true) return;
    const chance = clampProbability(config.stickerChance, 0.4);
    if (chance <= 0 || Math.random() >= chance) return;
    const chatKey = chatKeyForEvent(event);
    const file = pickStickerFile(config.stickerDir, chatKey);
    if (!file) {
      if (config.debugInbound) log.info('回复该带表情包，但 %s 的库里还没有图', chatKey);
      return;
    }
    const params = {
      message_type: event.message_type,
      message: [{ type: 'image', data: { file: toFileUrl(file) } }],
    };
    if (event.message_type === 'group') params.group_id = event.group_id;
    else params.user_id = event.user_id;
    sendAction('send_msg', params);
    log.info('随回复附带表情包：%s（%s）', file, chatKey);
  }

  // ── 按需开启的功能开关（修图等）───────────────────────────────
  /** 组合提示词：把模块级的 composePersonaText 需要的配置显式传进去。 */
  function personaTextFor(persona, workspacePath, imageEditOn, extras = {}) {
    return composePersonaText(persona, {
      imageEdit: imageEditOn,
      python: resolvePython(config.imageToolkitPython),
      toolkit: config.imageToolkit,
      outDir: config.imageOutDir || (workspacePath ? editedDirOf(workspacePath) : ''),
      personaFile: config.personaFile,
      groupMemoryFile: extras.groupMemoryFile,
      groupName: extras.groupName,
    });
  }

  /** 读取功能开关文件（不存在时按模板创建）。 */
  async function readFeatures() {
    let file = loadFeatureFile(config.featureFile);
    if (!file) {
      try {
        await mkdir(dirname(config.featureFile), { recursive: true });
        await writeFile(config.featureFile, `${JSON.stringify(FEATURE_FILE_TEMPLATE, null, 2)}\n`, 'utf8');
        file = loadFeatureFile(config.featureFile);
        log.info('已创建功能开关文件：%s', config.featureFile);
      } catch (error) {
        log.warn('创建功能开关文件失败：%s', error?.message ?? error);
      }
    }
    return file ?? FEATURE_FILE_TEMPLATE;
  }

  async function writeFeatures(file) {
    await mkdir(dirname(config.featureFile), { recursive: true });
    await writeFile(config.featureFile, `${JSON.stringify(file, null, 2)}\n`, 'utf8');
  }

  /** 当前会话的修图开关状态。 */
  function currentImageEdit(chatKey) {
    return evalImageEdit(loadFeatureFile(config.featureFile), chatKey, config.imageEditEnabled === true);
  }

  /**
   * 修图开关指令；返回是否已消费该消息。
   * 只在消息"除了开关词以外没别的内容"时才拦截，避免把"帮我修图换成蓝底"这类请求吃掉。
   */
  async function handleFeatureCommand(text, chatKey, event) {
    const parsed = parseImageEditCommand(text);
    if (!parsed) return false;
    const file = await readFeatures();
    if (!file.chats) file.chats = {};
    const block = file.chats[chatKey] && typeof file.chats[chatKey] === 'object'
      ? file.chats[chatKey]
      : (file.chats[chatKey] = {});

    if (parsed.action === 'status') {
      const state = currentImageEdit(chatKey);
      const lines = [
        `🖼 修图能力：${state.on ? '✅ 已开启' : '⭕ 已关闭'}`,
        state.on
          ? (state.until ? `有效期至：${new Date(state.until).toLocaleString('zh-CN')}（到期自动关闭）` : '有效期：一直有效，直到发「修图关」')
          : '开启方式：发送「修图开」（可加时长，如「修图开 30分钟」）',
        '',
        '开启后直接发图说要求即可，例如：',
        '· 帮我美颜一下 / 把背景虚化 / 转成黑白',
        '· 抠图换蓝底 / 做成一寸证件照',
        '· 给我脸上打个码 / 拼成九宫格 / 做成表情包',
        `开关文件：${config.featureFile}`,
      ];
      sendReply(event, lines.join('\n'));
      return true;
    }

    const on = parsed.action === 'on';
    block.imageEdit = on;
    block.until = on && parsed.minutes > 0 ? Date.now() + parsed.minutes * 60000 : 0;
    await writeFeatures(file);
    if (on) {
      sendReply(event, `✅ 修图能力已开启${parsed.minutes > 0 ? `（${parsed.minutes} 分钟后自动关闭）` : ''}。\n`
        + '现在直接把图发给我并说要什么效果就行，比如「帮我美颜一下」「做成一寸证件照」。');
    } else {
      sendReply(event, '⭕ 修图能力已关闭。需要时再发「修图开」即可。');
    }
    log.info('修图能力 %s（%s%s）', on ? '开启' : '关闭', chatKey, parsed.minutes ? `，${parsed.minutes} 分钟` : '');
    return true;
  }

  // ── 人格系统 ─────────────────────────────────────────────────
  /** 读取人格文件（不存在时按模板创建）。 */
  async function readPersonas() {
    let file = loadPersonaFile(config.personaFile);
    if (!file) {
      // 首次运行：写出模板，方便用户直接编辑
      try {
        await mkdir(dirname(config.personaFile), { recursive: true });
        await writeFile(config.personaFile, `${JSON.stringify(PERSONA_FILE_TEMPLATE, null, 2)}\n`, 'utf8');
        file = loadPersonaFile(config.personaFile);
        log.info('已创建人格文件模板：%s', config.personaFile);
      } catch (error) {
        log.warn('创建人格文件失败：%s', error?.message ?? error);
      }
    }
    return file ?? PERSONA_FILE_TEMPLATE;
  }

  /** 写回人格文件。 */
  async function writePersonas(file) {
    await mkdir(dirname(config.personaFile), { recursive: true });
    await writeFile(config.personaFile, `${JSON.stringify(file, null, 2)}\n`, 'utf8');
  }

  /** 取某会话的人格配置块（不存在则创建）。 */
  function ensureChatPersona(file, chatKey) {
    if (!file.chats) file.chats = {};
    if (!file.chats[chatKey] || typeof file.chats[chatKey] !== 'object') {
      file.chats[chatKey] = { active: '默认', modes: { 默认: '' } };
    }
    const block = file.chats[chatKey];
    if (!block.modes || typeof block.modes !== 'object') block.modes = { 默认: '' };
    if (Object.keys(block.modes).length === 0) block.modes['默认'] = '';
    if (typeof block.active !== 'string' || !(block.active in block.modes)) {
      block.active = Object.keys(block.modes)[0];
    }
    return block;
  }

  /** 当前会话生效的人格。 */
  function currentPersona(chatKey, event) {
    if (!config.personaEnabled) return { mode: '默认', prompt: '', title: '默认', available: [] };
    // 私聊用自己的键；群聊优先用群键，回退到发送者的私聊人格
    const senderKey = event?.user_id ? `private:${event.user_id}` : senderKeyOf(chatKey);
    return resolvePersona(loadPersonaFile(config.personaFile), chatKey, senderKey);
  }

  /** 人格指令处理；返回是否已消费该消息。 */
  async function handlePersonaCommand(text, chatKey, event) {
    const raw = String(text).trim();
    const personas = await readPersonas();
    const file = personas;

    // 「性格」/「性格 模式名」
    const showMatch = /^(?:性格|\/persona)(?:\s+(.+))?$/i.exec(raw);
    if (showMatch) {
      const wanted = (showMatch[1] ?? '').trim();
      const block = ensureChatPersona(file, chatKey);
      const names = Object.keys(block.modes);

      if (wanted && !/^(查看|列表|list)$/i.test(wanted)) {
        // 切换模式
        if (!(wanted in block.modes)) {
          sendReply(event, `❌ 没有名为「${wanted}」的性格。现有：${names.join('、')}\n用「设定性格 ${wanted}：描述」新建。`);
          return true;
        }
        block.active = wanted;
        await writePersonas(file);
        const prompt = composeModeBody(block.modes[wanted]);
        sendReply(event, `✅ 已切换到性格「${wanted}」${prompt ? `\n设定：${prompt}` : '\n（此为默认性格，无额外设定）'}\n下一条消息起生效。`);
        return true;
      }

      // 查看
      const active = block.active;
      const lines = [
        `🎭 当前性格：${active}`,
        '',
        `可用模式（${names.length} 个）：`,
        ...names.map((name) => {
          const value = block.modes[name];
          // 老格式字符串 / 新三段式对象都走 composeModeBody；列表只取第一行、截到 40 字
          const body = composeModeBody(value);
          const first = (body.split('\n')[0] ?? '').trim();
          const mark = name === active ? '▶ ' : '· ';
          const tag = isThreePartMode(value) ? '（三段式）' : '';
          if (!first) return `${mark}${name}${tag}（默认）`;
          const more = body.includes('\n') || first.length > 40 ? '…' : '';
          return `${mark}${name}${tag}：${first.slice(0, 40)}${more}`;
        }),
        '',
        '切换：性格 模式名',
        '新建/修改：设定性格 模式名：描述',
        '删除：删除性格 模式名',
        `文件：${config.personaFile}`,
      ];
      sendReply(event, lines.join('\n'));
      return true;
    }

    // 「设定性格 模式名：描述」
    const setMatch = /^(?:设定性格|\/persona\s+set)\s+([^：:]+)[：:]\s*([\s\S]+)$/i.exec(raw);
    if (setMatch) {
      const name = setMatch[1].trim();
      const prompt = setMatch[2].trim();
      if (!name || !prompt) { sendReply(event, '❌ 格式：设定性格 模式名：描述'); return true; }
      const block = ensureChatPersona(file, chatKey);
      const existed = name in block.modes;
      const wasThreePart = isThreePartMode(block.modes[name]);
      block.modes[name] = prompt;
      block.active = name;
      await writePersonas(file);
      sendReply(event, `✅ 已${existed ? '更新' : '新建'}性格「${name}」并切换到它。\n设定：${prompt}\n`
        + `${wasThreePart ? `已把「${name}」改成一整段文字格式。\n` : ''}下一条消息起生效。`);
      return true;
    }

    // 「删除性格 模式名」
    const delMatch = /^(?:删除性格|\/persona\s+del(?:ete)?)\s+(.+)$/i.exec(raw);
    if (delMatch) {
      const name = delMatch[1].trim();
      const block = ensureChatPersona(file, chatKey);
      if (!(name in block.modes)) { sendReply(event, `❌ 没有名为「${name}」的性格。`); return true; }
      if (Object.keys(block.modes).length <= 1) { sendReply(event, '❌ 至少要保留一个性格模式。'); return true; }
      delete block.modes[name];
      if (block.active === name) block.active = Object.keys(block.modes)[0];
      await writePersonas(file);
      sendReply(event, `✅ 已删除性格「${name}」，当前使用「${block.active}」。`);
      return true;
    }

    return false;
  }

  // ── 跨重启记忆：聊天 ↔ 会话 id 映射 ──────────────────────────
  /** 读取会话映射文件（不存在时按模板创建）。 */
  async function readSessions() {
    let file = loadSessionFile(config.sessionFile);
    if (!file) {
      try {
        await mkdir(dirname(config.sessionFile), { recursive: true });
        await writeFile(config.sessionFile, `${JSON.stringify(SESSION_FILE_TEMPLATE, null, 2)}\n`, 'utf8');
        file = loadSessionFile(config.sessionFile);
        log.info('已创建会话映射文件：%s', config.sessionFile);
      } catch (error) {
        log.warn('创建会话映射文件失败：%s', error?.message ?? error);
      }
    }
    return file ?? SESSION_FILE_TEMPLATE;
  }

  async function writeSessions(file) {
    await mkdir(dirname(config.sessionFile), { recursive: true });
    await writeFile(config.sessionFile, `${JSON.stringify(file, null, 2)}\n`, 'utf8');
  }

  /** 记住某聊天当前用的会话 id（+ 设定指纹），供重启后恢复。 */
  async function rememberSession(chatKey, sessionId, signature) {
    try {
      const file = await readSessions();
      if (!file.chats) file.chats = {};
      file.chats[chatKey] = { sessionId, signature: signature ?? '', updatedAt: Date.now() };
      await writeSessions(file);
    } catch (error) {
      // 记不住不影响本次对话，只是重启后恢复不了，所以只警告
      log.warn('写入会话映射失败：%s', error?.message ?? error);
    }
  }

  /** 忘掉某聊天的会话（重置时调用，避免下次又把旧历史接回来）。 */
  async function forgetSession(chatKey) {
    try {
      const file = await readSessions();
      if (file.chats && chatKey in file.chats) {
        delete file.chats[chatKey];
        await writeSessions(file);
      }
    } catch (error) {
      log.warn('清除会话映射失败：%s', error?.message ?? error);
    }
  }

  // ── 群聊规则：@ 开启 60 秒回复窗口 + 群记忆共享 ───────────────
  const GROUP_AT_WINDOW_MS = 60000;
  // 额度按聊天键（群号 + 成员）分开；窗口和次数都在 GroupReplyWindow 里
  const groupReplyWindow = new GroupReplyWindow(GROUP_AT_WINDOW_MS);

  /** 群工作区里的共享记忆文件：群内所有成员的会话都读它、写它。 */
  const groupMemoryFileFor = (workspacePath) => join(workspacePath, '群记忆.md');

  /** 读群记忆并拼一小段上下文给 Agent 当消息前缀（文件不存在就是还没记过）。 */
  async function groupContextFor(entry) {
    const lines = [];
    try {
      const raw = String(await readFile(groupMemoryFileFor(entry.workspace.path), 'utf8')).trim();
      if (raw) {
        lines.push(
          '【群聊共享记忆（本群所有成员共用，来自 群记忆.md）】',
          raw.length > 4000 ? raw.slice(-4000) : raw,
          '【群记忆结束】',
          '',
        );
      }
    } catch { /* 还没有群记忆，正常 */ }
    const who = [entry.nickname || '', entry.userId ? `QQ ${entry.userId}` : '']
      .filter(Boolean).join(' / ');
    lines.push(`[群聊：${entry.groupName || entry.groupId || '本群'}｜发言人：${who || '群成员'}]`);
    return lines.join('\n');
  }

  // ── 昵称 / 群名（OneBot get_stranger_info / get_group_info / get_group_member_info）──
  const nameCacheFile = join(dirname(config.sessionFile), 'qq-names.json');
  const nameCache = loadNameCache(nameCacheFile);

  function saveNameCache() {
    try {
      mkdirSync(dirname(nameCacheFile), { recursive: true });
      writeFileSync(nameCacheFile, `${JSON.stringify(nameCache, null, 2)}\n`, 'utf8');
    } catch (error) {
      log.warn('写昵称缓存失败：%s', error?.message ?? error);
    }
  }

  async function queryOneBot(action, params, timeoutMs = 4000) {
    if (sockets.size === 0) throw new Error('机器人还没连上');
    return await sendActionAwait(action, params, timeoutMs);
  }

  function cachedName(key) {
    const hit = nameCache[key];
    return hit && hit.name ? String(hit.name) : '';
  }

  function rememberName(key, name) {
    if (!name) return;
    nameCache[key] = { name, at: Date.now() };
    saveNameCache();
  }

  /** 私聊：对方昵称；群聊：群名片（没有就用 QQ 昵称）。 */
  async function nicknameOf(userId, groupId) {
    if (!userId) return '';
    const key = groupId ? `group-member:${groupId}:${userId}` : `private:${userId}`;
    if (cachedName(key)) return cachedName(key);
    let name = '';
    try {
      if (groupId) {
        const data = await queryOneBot('get_group_member_info', {
          group_id: Number(groupId), user_id: Number(userId), no_cache: false,
        });
        name = String(data?.card || data?.nickname || '').trim();
      } else {
        const data = await queryOneBot('get_stranger_info', {
          user_id: Number(userId), no_cache: false,
        });
        name = String(data?.nickname || '').trim();
      }
    } catch (error) {
      log.info('读取 %s 昵称失败：%s', key, error?.message ?? error);
    }
    if (name) rememberName(key, name);
    return name;
  }

  /** 群名（群工作区的标题用它）。 */
  async function groupNameOf(groupId) {
    if (!groupId) return '';
    const key = `group-name:${groupId}`;
    if (cachedName(key)) return cachedName(key);
    let name = '';
    try {
      const data = await queryOneBot('get_group_info', { group_id: Number(groupId), no_cache: false });
      name = String(data?.group_name || '').trim();
    } catch (error) {
      log.info('读取群 %s 名称失败：%s', groupId, error?.message ?? error);
    }
    if (name) rememberName(key, name);
    return name;
  }

  /**
   * 一个聊天该叫什么：工作区标题 + 会话标题。
   *  - 私聊：工作区/会话都叫对方昵称（拿不到就 QQ <号>）。
   *  - 群聊：工作区叫群名；会话叫「群名 · 发言人昵称」，群里每个人一个会话。
   */
  async function describeChat(event) {
    const chatKey = chatKeyForEvent(event);
    const parsed = parseChatKey(chatKey);
    if (parsed.type === 'group') {
      const [groupName, nickname] = await Promise.all([
        groupNameOf(parsed.groupId),
        nicknameOf(parsed.userId, parsed.groupId),
      ]);
      const groupLabel = groupName || `QQ群 ${parsed.groupId}`;
      return {
        chatKey,
        isGroup: true,
        groupId: parsed.groupId,
        userId: parsed.userId,
        nickname,
        groupName,
        workspaceTitle: groupName,
        sessionTitle: nickname ? `${groupLabel} · ${nickname}` : `${groupLabel} · QQ ${parsed.userId}`,
      };
    }
    const nickname = await nicknameOf(parsed.userId);
    return {
      chatKey,
      isGroup: false,
      groupId: '',
      userId: parsed.userId,
      nickname,
      groupName: '',
      workspaceTitle: nickname,
      sessionTitle: nickname || `QQ私聊 ${parsed.userId}`,
    };
  }

  // ── Agent 会话管理 ───────────────────────────────────────────
  async function createChat(chatKey, title, display) {
    const presetId = config.agentPreset;
    const preset = await ctx.agentPresets.resolve(presetId);
    const workspace = await ensureWorkspaceFor(chatKey, display?.workspaceTitle);
    const workspacePath = workspace.path;
    const sessionId = `qq-${randomUUID()}`;
    const current = ctx.agentDefaultModel.currentSelection();
    const selection = {
      provider: config.provider || current.provider,
      model: config.model || current.model,
      reasoningEffort: (config.provider || config.model) ? undefined : current.reasoningEffort,
    };
    const handle = await ctx.agents.create({
      sessionId,
      meta: { cwd: workspace.path, agentPreset: presetId },
      agentOptions: { provider: selection.provider, model: selection.model },
      setup: async (agentCtx) => {
        await ctx.agentPresets.mount(agentCtx, preset.id);
        installModelSelection(agentCtx, selection);
      },
    });
    await workspace.attachSession(sessionId);
    ctx.permissionPresets.set(handle.agent.session, config.permissionPreset);
    ctx.sessionTitle.rename(handle.agent.session, title);
    // 注入基础规则 + 当前人格 + 功能开关状态
    const persona = resolvePersona(loadPersonaFile(config.personaFile), chatKey, senderKeyOf(chatKey));
    const imgEdit = evalImageEdit(loadFeatureFile(config.featureFile), chatKey, config.imageEditEnabled === true);
    if (imgEdit.on) await mkdir(editedDirOf(workspacePath), { recursive: true });
    // 群聊：把群记忆文件位置与群名写进开场规则（各成员会话都指向同一份）
    const personaExtras = display?.isGroup
      ? { groupMemoryFile: groupMemoryFileFor(workspacePath), groupName: display.groupName }
      : {};
    const injected = personaTextFor(persona, workspace.path, imgEdit.on, personaExtras);
    handle.agent.inject(makeUserMessage(injected, { kind: 'qq-bridge' }));
    log.info('创建会话 %s <- %s（%s，人格：%s，修图：%s）',
      sessionId, chatKey, presetId, persona.mode, imgEdit.on ? '开' : '关');
    return {
      handle,
      workspace,
      sessionId,
      personaSignature: JSON.stringify([persona, imgEdit.on]),
      resumed: false,
      persona,
      personaExtras,
      imgEditOn: imgEdit.on,
    };
  }

  /**
   * 恢复一个持久化会话：DSH 把磁盘上的事件日志读回来，Agent 重建在它上面，
   * 于是重启前说过的话都还在。
   *
   * 和 createChat 的两点不同：
   *  - resume 不接受 sessionId / meta —— 身份和 cwd 都取自存储的会话头，
   *    参数名是 resumeSessionId。
   *  - 不再 inject 开场规则 / 人格 —— 它们已经在历史里了，重复注入只会白烧 token。
   */
  async function resumeChat(chatKey, sessionId, display) {
    const presetId = config.agentPreset;
    const preset = await ctx.agentPresets.resolve(presetId);
    const workspace = await ensureWorkspaceFor(chatKey, display?.workspaceTitle);
    const workspacePath = workspace.path;
    const current = ctx.agentDefaultModel.currentSelection();
    const selection = {
      provider: config.provider || current.provider,
      model: config.model || current.model,
      reasoningEffort: (config.provider || config.model) ? undefined : current.reasoningEffort,
    };
    const handle = await ctx.agents.resume({
      resumeSessionId: sessionId,
      agentOptions: { provider: selection.provider, model: selection.model },
      setup: async (agentCtx) => {
        await ctx.agentPresets.mount(agentCtx, preset.id);
        installModelSelection(agentCtx, selection);
      },
    });
    await workspace.attachSession(sessionId);
    ctx.permissionPresets.set(handle.agent.session, config.permissionPreset);
    const persona = resolvePersona(loadPersonaFile(config.personaFile), chatKey, senderKeyOf(chatKey));
    const imgEdit = evalImageEdit(loadFeatureFile(config.featureFile), chatKey, config.imageEditEnabled === true);
    if (imgEdit.on) await mkdir(editedDirOf(workspacePath), { recursive: true });
    const personaExtras = display?.isGroup
      ? { groupMemoryFile: groupMemoryFileFor(workspacePath), groupName: display.groupName }
      : {};
    const history = handle.agent.session.deriveMessages().length;
    log.info('恢复会话 %s <- %s（历史 %d 条，人格：%s，修图：%s）',
      sessionId, chatKey, history, persona.mode, imgEdit.on ? '开' : '关');
    return {
      handle,
      workspace,
      sessionId,
      personaSignature: JSON.stringify([persona, imgEdit.on]),
      resumed: true,
      persona,
      personaExtras,
      imgEditOn: imgEdit.on,
    };
  }

  /**
   * 借用（而不是恢复）一个已经活着的会话。
   *
   * 场景：这个 QQ 会话正被 DSH 界面（或别的组件）打开着 —— 那边持有写句柄，
   * ctx.agents.resume() 必然报 "already owned by an active write handle"，
   * 于是桥接只能新建会话、把记忆整段丢掉（2026-10-23 实测就是这样，连 5 次）。
   * 既然 Agent 已经活着，就别再 resume，直接 ctx.agents.get() 拿来用。
   *
   * 唯一约束：**不能 dispose**（不是我创建的），所以 handle 用空实现。
   */
  async function adoptChat(chatKey, sessionId, agent, display) {
    const workspace = await ensureWorkspaceFor(chatKey, display?.workspaceTitle);
    const workspacePath = workspace.path;
    try { await workspace.attachSession(sessionId); } catch (error) {
      log.warn('借用会话时绑定工作区失败（不影响对话）：%s', error?.message ?? error);
    }
    try { ctx.permissionPresets.set(agent.session, config.permissionPreset); } catch { /* 尽力而为 */ }
    const persona = resolvePersona(loadPersonaFile(config.personaFile), chatKey, senderKeyOf(chatKey));
    const imgEdit = evalImageEdit(loadFeatureFile(config.featureFile), chatKey, config.imageEditEnabled === true);
    if (imgEdit.on) await mkdir(editedDirOf(workspacePath), { recursive: true });
    const personaExtras = display?.isGroup
      ? { groupMemoryFile: groupMemoryFileFor(workspacePath), groupName: display.groupName }
      : {};
    let history = 0;
    try { history = agent.session.deriveMessages().length; } catch { /* 忽略 */ }
    log.info('借用已在运行的会话 %s <- %s（历史 %d 条；多半是 DSH 界面开着它）', sessionId, chatKey, history);
    return {
      // 空 dispose：这个 Agent 不属于桥接，热重载/重置时不能销毁它，否则会把界面那边也干掉
      handle: { agent, dispose: async () => { /* 借用，不销毁 */ } },
      workspace,
      sessionId,
      personaSignature: JSON.stringify([persona, imgEdit.on]),
      resumed: true,
      borrowed: true,
      persona,
      personaExtras,
      imgEditOn: imgEdit.on,
    };
  }

  /** 恢复/借用会话后，若「设定指纹」变了就补一条更新说明给 Agent。 */
  async function syncPersonaAfterOpen(chatKey, stored, entry) {
    const sig = entry.personaSignature;
    if (stored?.signature && stored.signature !== sig) {
      entry.handle.agent.inject(makeUserMessage(
        personaTextFor(entry.persona, entry.workspace.path, entry.imgEditOn, entry.personaExtras)
          .replace(/^/, '[会话设定已更新]\n'),
        { kind: 'qq-bridge' },
      ));
      log.info('会话设定已变（性格 %s，修图 %s），已补发更新',
        entry.persona.mode, entry.imgEditOn ? '开' : '关');
    }
    if (stored?.signature !== sig) await rememberSession(chatKey, entry.sessionId, sig);
    return entry;
  }

  /**
   * 取（或新建）某聊天的会话。
   *
   * 顺序：已经在跑（被界面打开）→ 借用；否则 resume 持久化会话；都不行才新建。
   * 任何情况下都不会让用户「发消息没人理」，最差也只是退化成没有记忆的新会话。
   */
  async function openChat(chatKey, title, display) {
    const stored = config.resumeOnStart === true
      ? evalSessionRecord(loadSessionFile(config.sessionFile), chatKey)
      : undefined;

    if (stored?.sessionId) {
      // ① 这个会话已经有活的 Agent 了（DSH 界面打开着）——直接借用，resume 一定会失败
      try {
        const live = ctx.agents.get(stored.sessionId);
        if (live) {
          const adopted = await adoptChat(chatKey, stored.sessionId, live, display);
          return await syncPersonaAfterOpen(chatKey, stored, adopted);
        }
      } catch (error) {
        log.warn('检查会话 %s 是否在运行失败：%s', stored.sessionId, error?.message ?? error);
      }

      // ② 没有活的 Agent，正常 resume
      const attempts = 5;
      for (let i = 0; i < attempts; i++) {
        try {
          const entry = await resumeChat(chatKey, stored.sessionId, display);
          return await syncPersonaAfterOpen(chatKey, stored, entry);
        } catch (error) {
          const msg = String(error?.message ?? error);
          // resume 失败 = 用户「失忆」，必须留下可查的证据（DSH 的插件日志不进文件）
          try {
            const { appendFileSync } = await import('node:fs');
            appendFileSync(
              join(dirname(config.sessionFile), 'resume-debug.log'),
              `${new Date().toISOString()}  resume ${stored.sessionId} (${chatKey}) attempt=${i + 1}/${attempts} FAILED: ${msg}\n`,
            );
          } catch { /* 记不了就算 */ }
          const busy = /already owned|already exists|已.*占用/i.test(msg);
          if (busy && i < attempts - 1) {
            // 被占住多半是刚有人打开了它 —— 多等几轮，别急着新建会话把记忆丢掉
            await new Promise((resolve) => { setTimeout(resolve, 500 * (2 ** i)); });
            continue;
          }
          log.warn('恢复会话 %s（%s）失败：%s —— 改为新建会话', stored.sessionId, chatKey, msg);
          break;
        }
      }
    }

    const entry = await createChat(chatKey, title, display);
    await rememberSession(chatKey, entry.sessionId, entry.personaSignature);
    return entry;
  }

  async function ensureChat(chatKey, event) {
    const existing = chats.get(chatKey);
    if (existing) return existing;
    // 昵称/群名读不到时 describeChat 会退回 QQ <号>，不会挡住对话
    const display = await describeChat(event);
    const entry = await openChat(chatKey, display.sessionTitle, display);
    entry.chatKey = chatKey;
    entry.isGroup = display.isGroup;
    entry.groupId = display.groupId;
    entry.userId = display.userId;
    entry.nickname = display.nickname;
    entry.groupName = display.groupName;
    // 老会话（或旧版本建的会话）标题可能还是「QQ私聊 xxx / QQ群 群号」，
    // 恢复时顺手改成昵称 / 群名·昵称，下次发言就能在侧栏看到对的名字。
    try {
      ctx.sessionTitle.rename(entry.handle.agent.session, display.sessionTitle);
    } catch (error) {
      log.warn('会话标题改名失败（不影响对话）：%s', error?.message ?? error);
    }
    chats.set(chatKey, entry);
    return entry;
  }

  async function resetChat(chatKey) {
    // 先忘掉映射：否则下一条消息又会把旧会话恢复回来，"重置"就白按了
    await forgetSession(chatKey);
    const entry = chats.get(chatKey);
    if (!entry) return;
    chats.delete(chatKey);
    if (entry.borrowed) {
      // 借来的会话（界面开着它）不能解绑、更不能销毁——只清掉桥接这边的引用，
      // 下一条消息会开一个全新会话，同样达到「重置」的效果。
      log.info('已重置会话 %s（该会话属于界面，只解除桥接引用）', chatKey);
      return;
    }
    try { await settleWithTimeout(entry.workspace.detachSession(entry.sessionId), 8000, log, '解绑工作区'); } catch { /* 尽力而为 */ }
    await settleWithTimeout(entry.handle.dispose(), 10000, log, `销毁会话 ${chatKey}`);
    log.info('已重置会话 %s', chatKey);
  }

  /** 这个 Agent 最近一次 turn/end 的结束原因；拿不到就返回 null。 */
  function lastTurnEndKind(agent) {
    try {
      const events = agent.session.snapshotEvents();
      for (let i = events.length - 1; i >= 0; i -= 1) {
        if (events[i]?.type !== 'turn/end') continue;
        const kind = events[i]?.data?.reason?.kind;
        return kind === undefined || kind === null ? null : String(kind);
      }
    } catch { /* 读不到就当不知道，不耽误回复 */ }
    return null;
  }

  /** 这一轮新冒出来的 assistant 文本（旧的回复绝不重发）。 */
  function freshAssistantIds(agent) {
    const seen = new Set();
    try {
      for (const message of agent.session.deriveMessages()) {
        if (message?.role === 'assistant' && message.id) seen.add(message.id);
      }
    } catch { /* 忽略 */ }
    return seen;
  }

  /** 读当前会话的上下文占用（tokenMeter 是可选服务，没装就返回 null）。 */
  function contextOccupancyOf(entry) {
    let meter;
    try { meter = ctx.get('tokenMeter'); } catch { meter = undefined; }
    if (!meter || typeof meter.measure !== 'function') return null;
    try {
      const session = entry.handle.agent.session;
      const measurement = meter.measure(session);
      const contextWindow = session.requestContext?.()?.contextWindow;
      return contextOccupancy(measurement, contextWindow);
    } catch (error) {
      log.warn('读取上下文占用失败（不影响对话）：%s', error?.message ?? error);
      return null;
    }
  }

  /** 每轮结束后刷新上下文占用；到阈值就标记「下一条消息换新会话」。 */
  function refreshContextRotation(entry) {
    const threshold = Math.max(0, Math.min(100, Number(config.contextRotatePercent) || 0));
    if (threshold <= 0) {
      entry.rotatePending = false;
      return null;
    }
    const occupancy = contextOccupancyOf(entry);
    if (!occupancy) return null;
    entry.contextPercent = occupancy.percent;
    entry.contextTokens = occupancy.usedTokens;
    if (occupancy.percent >= threshold && !entry.rotatePending) {
      entry.rotatePending = true;
      log.info('上下文 %d%%（阈值 %d%%），下一条消息换新会话（%s）',
        occupancy.percent, threshold, entry.chatKey ?? '?');
    }
    return occupancy;
  }

  /**
   * 上下文到阈值：忘掉旧映射，开一个新会话。
   * 旧会话记录留在归档里；借来的会话（界面开着）不销毁，只解除桥接引用。
   */
  async function rotateForContext(entry, event) {
    const chatKey = entry.chatKey ?? chatKeyForEvent(event);
    const task = (async () => {
      log.info('上下文 %s%%（阈值 %s%%），换新会话：%s（旧 %s 保留）',
        entry.contextPercent ?? '?', config.contextRotatePercent, chatKey, entry.sessionId);
      await forgetSession(chatKey);
      chats.delete(chatKey);
      if (!entry.borrowed) {
        try {
          await settleWithTimeout(entry.workspace.detachSession(entry.sessionId), 8000, log, '上下文轮换解绑');
        } catch { /* 尽力而为 */ }
        await settleWithTimeout(entry.handle.dispose(), 10000, log, `上下文轮换销毁 ${chatKey}`);
      }
      const fresh = await ensureChat(chatKey, event);
      fresh.chatKey = chatKey;
      // 已经排在旧队列里的消息，继续跟着新会话跑
      if (entry.queue) fresh.queue = entry.queue;
      entry.replacement = fresh;
      return fresh;
    })();
    rotationLocks.set(chatKey, task);
    try {
      return await task;
    } finally {
      if (rotationLocks.get(chatKey) === task) rotationLocks.delete(chatKey);
    }
  }

  /**
   * DSH 会把「归档过的会话」每个 turn 都直接挡掉（turn/end reason=blocked，一步都不跑），
   * 桥接这边看着就像机器人不回。这种情况换一个新会话再试一次——旧会话记录还在，不删。
   */
  async function replaceBlockedChat(entry, event) {
    const chatKey = entry.chatKey ?? chatKeyForEvent(event);
    log.warn('会话 %s 被 DSH 挡掉了（reason=blocked，多半是旧会话被归档过），换新会话重试', chatKey);
    await forgetSession(chatKey);
    chats.delete(chatKey);
    if (!entry.borrowed) {
      try { await settleWithTimeout(entry.handle.dispose(), 10000, log, `销毁被挡住的会话 ${chatKey}`); } catch { /* 尽力而为 */ }
    }
    const fresh = await ensureChat(chatKey, event);
    fresh.chatKey = chatKey;
    return fresh;
  }

  // ── 单轮处理：followup → 等 idle → 取最终回复 → 发回 QQ ───────
  async function runTurn(entry, event, text, retried = false) {
    if (config.ackEnabled && config.ackMessage) sendReply(event, config.ackMessage);
    const agent = entry.handle.agent;
    if (agent.status === undefined && !ctx.agents.get(entry.sessionId)) {
      // Agent 已被外部销毁（例如用户在 GUI 里停掉）——重建会话
      chats.delete(entry.chatKey);
      const fresh = await ensureChat(entry.chatKey, event);
      return runTurn(fresh, event, text, retried);
    }
    // 先把已有回复的 id 记下来：这一轮只认之后新出的 assistant 文本
    const seen = freshAssistantIds(agent);
    try {
      agent.followup(makeUserMessage(text, { kind: 'user' }));
    } catch (error) {
      logError(error);
      sendReply(event, `❌ 发送失败：${error?.message ?? error}`);
      return;
    }
    const outcome = await withTimeout(agent.whenIdle(), config.turnTimeoutMs);
    const messages = agent.session.deriveMessages();
    let reply = '';
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const message = messages[i];
      if (message.role !== 'assistant') continue;
      if (message.id && seen.has(message.id)) continue; // 上一轮的旧回复，不能重发
      reply = extractAssistantText(message);
      if (reply) break;
    }
    const endKind = lastTurnEndKind(agent);
    if (!reply && !retried && endKind === 'blocked') {
      // 旧会话被归档过 → 换新会话，把这条消息再送一遍
      const fresh = await replaceBlockedChat(entry, event);
      if (event.message_type !== 'group') {
        sendReply(event, '（这个聊天的旧会话被归档过、跑不动了，我换了个新的，重来一次）');
      }
      return runTurn(fresh, event, text, true);
    }
    if (reply) {
      sendReply(event, reply, { sticker: true });
      if (outcome === 'timeout') sendReply(event, '（以上为部分回复，仍在继续处理中…）');
    } else if (outcome === 'timeout') {
      sendReply(event, '⏳ 处理超时，本轮尚未产生文本回复。');
    } else {
      // 无文本回复：附上会话状态与末尾消息摘要，便于排查
      const summary = messages.slice(-5).map((m) => {
        const text = extractAssistantText(m)
          || (Array.isArray(m.content)
            ? m.content.map((b) => b?.type ?? '?').join(',')
            : typeof m.content === 'string' ? m.content.slice(0, 60) : '');
        return `${m.role ?? '?'}:${String(text).slice(0, 80)}`;
      }).join(' | ');
      let eventTail = '';
      try {
        const events = agent.session.snapshotEvents();
        eventTail = events.slice(-10).map((e) => {
          const extra = e.data?.reason ? `(${JSON.stringify(e.data.reason).slice(0, 60)})` : '';
          return `${e.type}${extra}`;
        }).join(' > ');
      } catch (error) {
        eventTail = `events-err:${error?.message}`;
      }
      let pending = '';
      try {
        pending = `nextTurn=${agent.inbox?.nextTurn?.length ?? '?'} nextStep=${agent.inbox?.nextStep?.length ?? '?'}`;
      } catch (error) {
        pending = `inbox-err:${error?.message}`;
      }
      sendReply(event, `（本轮没有产生文本回复）\n[debug] status=${agent.status ?? '?'} ${pending} derived=${messages.length}\nevents: ${eventTail}`);
    }
  }

  // ── 主动消息（定时醒来）─────────────────────────────────────
  // 思路：每 wakeIntervalMinutes 分钟掷一次骰子，点数 < wakeChance 就「醒来」，
  // 用该聊天原来的 DSH 会话生成一句话主动发出去（不是固定模板，语气跟着人格走）。
  const WAKE_PROMPT = [
    '[系统] 现在没有新消息。你刚睡醒，想主动找对方说句话。',
    '直接写出你想说的第一句话，保持你现在的性格和说话习惯；短一点，像平时聊天那样。',
    '不要提“系统 / 定时 / 唤醒 / 主动发消息”这些词，也不要解释，更不要问对方在不在。',
    '只发这一条。',
  ].join('\n');

  /** 主动消息该发给哪些私聊：配置优先，没配就用会话映射里聊过天的私聊。 */
  function wakeTargetKeys() {
    const stored = loadSessionFile(config.sessionFile);
    return resolveWakeTargets(stored?.chats, config.wakeTargets, config.allowlist);
  }

  /** 给主动消息造一个「私聊空事件」，复用 ensureChat / sendReply 那套。 */
  function wakeEventFor(chatKey) {
    const parsed = parseChatKey(chatKey);
    return {
      post_type: 'message',
      message_type: 'private',
      sub_type: 'friend',
      self_id: 0,
      user_id: Number(parsed.userId) || parsed.userId,
      message: [],
      raw_message: '',
      time: Math.floor(Date.now() / 1000),
    };
  }

  /** 醒来后跑一轮：把唤醒提示交给 Agent，等它说完，再把话发回 QQ（不带「收到」）。 */
  async function runWakeTurn(entry, event, retried = false) {
    const agent = entry.handle.agent;
    if (agent.status === undefined && !ctx.agents.get(entry.sessionId)) {
      chats.delete(entry.chatKey);
      const fresh = await ensureChat(entry.chatKey, event);
      return runWakeTurn(fresh, event, retried);
    }
    const seen = freshAssistantIds(agent);
    try {
      agent.followup(makeUserMessage(WAKE_PROMPT, { kind: 'qq-bridge' }));
    } catch (error) {
      logError(error);
      wakeState.lastResult = `发送失败：${error?.message ?? error}`;
      return;
    }
    const outcome = await withTimeout(agent.whenIdle(), config.turnTimeoutMs);
    const messages = agent.session.deriveMessages();
    let reply = '';
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const message = messages[i];
      if (message.role !== 'assistant') continue;
      if (message.id && seen.has(message.id)) continue;
      reply = extractAssistantText(message);
      if (reply) break;
    }
    const endKind = lastTurnEndKind(agent);
    if (!reply && !retried && endKind === 'blocked') {
      // 旧会话被归档过 → 换个新会话再唤醒一次（和用户消息的处理一致）
      const fresh = await replaceBlockedChat(entry, event);
      return runWakeTurn(fresh, event, true);
    }
    if (reply) {
      sendReply(event, reply, { sticker: true });
      wakeState.lastWakeAt = Date.now();
      wakeState.lastResult = `已发送（${entry.chatKey ?? chatKeyForEvent(event)}）`;
      log.info('主动消息已发（%s）：%s', chatKeyForEvent(event), reply.slice(0, 80));
    } else {
      wakeState.lastResult = outcome === 'timeout' ? '超时，没产生回复' : '本轮没有文本回复';
      log.info('主动消息：%s 这轮没产生文本回复（%s）', chatKeyForEvent(event), wakeState.lastResult);
    }
  }

  /** 给某个聊天下一次主动消息（复用该聊天的队列，避免和用户消息抢会话）。 */
  async function wakeChat(chatKey) {
    let entry;
    try {
      entry = await ensureChat(chatKey, wakeEventFor(chatKey));
    } catch (error) {
      log.warn('主动消息：打开会话失败（%s）：%s', chatKey, error?.message ?? error);
      wakeState.lastResult = `打开会话失败：${error?.message ?? error}`;
      return;
    }
    entry.chatKey = chatKey;
    const prev = entry.queue ?? Promise.resolve();
    entry.queue = prev.then(async () => {
      let active = entry;
      while (active.replacement) active = active.replacement;
      active.chatKey = chatKey;
      await runWakeTurn(active, wakeEventFor(chatKey));
    }).catch((error) => {
      logError(error);
      wakeState.lastResult = `出错：${error?.message ?? error}`;
    });
    await entry.queue;
  }

  /** 掷一次骰子；掷中就醒来给目标发消息。 */
  async function wakeOnce() {
    wakeState.lastCheckAt = Date.now();
    if (stopped || paused) {
      wakeState.lastResult = '桥接已暂停';
      return;
    }
    if (sockets.size === 0) {
      wakeState.lastResult = 'OneBot 未连接';
      log.info('主动消息：到点了，但 OneBot 没连上，这次不醒');
      return;
    }
    const chance = clampProbability(config.wakeChance, 0.6);
    const roll = Math.random();
    wakeState.lastRoll = Number(roll.toFixed(4));
    if (roll >= chance) {
      wakeState.lastResult = `没掷中（${roll.toFixed(2)} ≥ ${chance}）`;
      log.info('主动消息：掷骰子 %.2f ≥ %.2f，这次不醒', roll, chance);
      return;
    }
    const targets = wakeTargetKeys();
    if (targets.length === 0) {
      wakeState.lastResult = '没有可唤醒的私聊';
      log.info('主动消息：掷中了，但会话里还没有聊过天的私聊（发条消息就有了）');
      return;
    }
    // 一次醒来只发一条：随机挑一个对象，避免两个人同时被刷
    const target = targets[Math.floor(Math.random() * targets.length)];
    wakeState.lastTargets = [target];
    log.info('主动消息：掷骰子 %.2f < %.2f，醒来给 %s 发消息', roll, chance, target);
    await wakeChat(target);
  }

  /**
   * 排下一次主动消息。间隔/开关/暂停有变化时重排；已经排着的先取消。
   * 间隔 ≤ 0 视为关闭。
   */
  function scheduleWake() {
    if (wakeTimer) {
      clearTimeout(wakeTimer);
      wakeTimer = null;
    }
    wakeState.nextCheckAt = 0;
    const minutes = Number(config.wakeIntervalMinutes);
    if (stopped || paused || config.wakeEnabled !== true || !(minutes > 0)) {
      if (config.wakeEnabled === true && !(minutes > 0)) {
        log.warn('主动消息：间隔必须大于 0 分钟，已停用');
      }
      return;
    }
    // 0.05 分钟 = 3 秒，测试用；正常配置就是 60 分钟
    const delay = Math.max(0.05, minutes) * 60000;
    wakeState.nextCheckAt = Date.now() + delay;
    wakeTimer = setTimeout(async () => {
      wakeTimer = null;
      try {
        await wakeOnce();
      } catch (error) {
        logError(error);
        wakeState.lastResult = `出错：${error?.message ?? error}`;
      }
      writeRuntimeSnapshot({ wakeAction: 'tick' });
      scheduleWake();
    }, delay);
    log.info('主动消息：每 %s 分钟掷一次骰子，醒来概率 %s，下次 %s',
      minutes, clampProbability(config.wakeChance, 0.6), new Date(wakeState.nextCheckAt).toLocaleString('zh-CN', { hour12: false }));
  }

  // ── OneBot 入站事件 ──────────────────────────────────────────
  async function handleMessage(event) {
    try {
      if (event.message_type !== 'private' && event.message_type !== 'group') return;
      if (event.message_type === 'private' && !config.privateEnabled) return;
      if (event.message_type === 'group' && !config.groupEnabled) return;
      const userId = String(event.user_id ?? '');
      if (config.allowlist.length > 0 && !config.allowlist.map(String).includes(userId)) return;
      const chatKey = chatKeyForEvent(event);
      // 正在换新会话时，后来的消息等它换完再拿会话，别同时建两个
      while (rotationLocks.has(chatKey)) {
        try { await rotationLocks.get(chatKey); } catch { /* 轮换失败也继续 */ }
      }
      const isGroup = event.message_type === 'group';
      const { text: rawText, images, voices, mentions } = extractContent(event);
      const text = rawText.trim();
      if (config.debugInbound) {
        log.info('[inbound] text=%s images=%d voices=%d raw=%s',
          JSON.stringify(text.slice(0, 60)), images.length, voices.length,
          JSON.stringify(event.message).slice(0, 300));
        try {
          const { appendFileSync } = await import('node:fs');
          const picked = voices.map((v) => resolveMediaSource(v)?.kind ?? 'none').join(',');
          appendFileSync(DEBUG_LOG_FILE,
            `${new Date().toISOString()} text=${JSON.stringify(text)} images=${images.length} voices=${voices.length} picked=[${picked}] stt=${getSpeechToText() ? 'yes' : 'no'} raw=${JSON.stringify(event.message ?? event.raw_message).slice(0, 400)}\n`);
        } catch { /* 忽略 */ }
      }
      // 纯图片 / 纯语音消息（无文字）也要处理
      if (!text && images.length === 0 && voices.length === 0) return;

      // ── 群聊规则：没 @ 就不回；@ 一次开 60 秒窗口，窗口内最多回 N 条 ──
      if (isGroup) {
        const selfId = String(event.self_id ?? '');
        const mentioned = (mentions ?? []).map(String).includes(selfId);
        if (config.groupRequireAt !== false) {
          // 关掉 groupRequireAt = 群里所有消息都处理，@ 窗口和次数限制都不生效
          if (!groupReplyWindow.take(chatKey, { mentioned, limit: config.groupAtReplyLimit })) {
            if (config.debugInbound) {
              log.info('[group] 没 @ 或 @ 后额度已用完，忽略（%s，limit=%s）',
                chatKey, config.groupAtReplyLimit);
            }
            return;
          }
        }
      }

      const lower = text.toLowerCase();
      if (['/help', 'help', '帮助', '/帮助'].includes(lower)) { sendReply(event, HELP); return; }
      if (['/reset', 'reset', '重置', '重置会话'].includes(lower)) {
        await resetChat(chatKey);
        sendReply(event, '✅ 会话已重置，上下文已清空。');
        return;
      }
      if (['/status', 'status', '状态'].includes(lower)) {
        const entry = chats.get(chatKey);
        if (!entry) {
          const stored = evalSessionRecord(loadSessionFile(config.sessionFile), chatKey);
          sendReply(event, stored?.sessionId
            ? `💤 ${chatKey} 当前没有活跃会话。\n上次的会话 ${stored.sessionId} 已记住，你发下一条消息就会带着历史恢复。`
            : `📭 ${chatKey} 尚无会话，发条消息即可开始。`);
        } else {
          const status = entry.handle.agent.status ?? 'unknown';
          const count = entry.handle.agent.session.deriveMessages().length;
          const persona = currentPersona(chatKey, event);
          const imgEdit = currentImageEdit(chatKey);
          const occ = contextOccupancyOf(entry);
          const threshold = Math.max(0, Math.min(100, Number(config.contextRotatePercent) || 0));
          const contextLine = occ
            ? `\n上下文：${occ.percent}%（${occ.usedTokens}/${occ.contextWindow}）`
              + (threshold > 0 ? `，达 ${threshold}% 自动换新会话` : '')
            : '';
          sendReply(event, `📋 会话：${entry.sessionId}\n状态：${status}\n历史消息：${count} 条`
            + `\n记忆：${entry.resumed ? '已从磁盘恢复（跨重启保留）' : '本次新建'}`
            + `\n当前性格：${persona.mode}\n修图能力：${imgEdit.on ? '已开启' : '已关闭'}${contextLine}\n工作区：${entry.workspace.path}`);
        }
        return;
      }
      // 人格指令（性格 / 设定性格 / 删除性格）
      if (await handlePersonaCommand(text, chatKey, event)) return;
      // 修图开关指令（修图 / 修图开 / 修图关）——带图片时不当指令，避免吃掉真实请求
      if (images.length === 0 && await handleFeatureCommand(text, chatKey, event)) return;

      let base = await ensureChat(chatKey, event);
      base.chatKey = chatKey;
      while (base.replacement) base = base.replacement;
      refreshContextRotation(base);
      const prev = base.queue ?? Promise.resolve();
      base.queue = prev.then(async () => {
        let active = base;
        while (active.replacement) active = active.replacement;
        if (active.rotatePending) {
          active = await rotateForContext(active, event);
        }
        active.chatKey = chatKey;
        // 人格/功能开关变更检测：用户改了文件或切换了模式时，实时告诉 Agent
        try {
          const persona = currentPersona(chatKey, event);
          const imgEdit = currentImageEdit(chatKey);
          const signature = JSON.stringify([persona, imgEdit.on]);
          if (active.personaSignature !== undefined && active.personaSignature !== signature) {
            active.handle.agent.inject(makeUserMessage(
              personaTextFor(persona, active.workspace.path, imgEdit.on, active.personaExtras)
                .replace(/^/, '[会话设定已更新]\n'),
              { kind: 'qq-bridge' },
            ));
            log.info('会话设定已更新（性格 %s，修图 %s）', persona.mode, imgEdit.on ? '开' : '关');
          }
          active.personaSignature = signature;
        } catch (error) {
          log.warn('会话设定更新检测失败：%s', error?.message ?? error);
        }

        let payload = text || (voices.length > 0 ? '(用户只发了一条语音，没有文字)' : '(用户只发了一张图片，没有文字)');
        if (images.length > 0) {
          const note = await downloadImages(images, active.workspace.path, event);
          payload += note;
        }
        if (voices.length > 0) {
          const note = await transcribeVoices(voices, active.workspace.path, event);
          payload += note;
        }
        // 群聊：把群工作区里那份共享记忆 + 当前发言人拼在消息前面，群内所有成员的会话看到的是同一份记忆
        if (isGroup && config.groupSharedMemory !== false) {
          payload = `${await groupContextFor(active)}\n\n${payload}`;
        }
        await runTurn(active, event, payload);
        const current = chats.get(chatKey) || active;
        refreshContextRotation(current);
      }).catch((error) => {
        logError(error);
        try { sendReply(event, `❌ 处理出错：${error?.message ?? error}`); } catch { /* 忽略 */ }
      });
      await base.queue;
    } catch (error) {
      logError(error);
      try { sendReply(event, `❌ 处理出错：${error?.message ?? error}`); } catch { /* 忽略 */ }
    }
  }

  function handlePayload(data) {
    if (!data || typeof data !== 'object') return;
    // 机器人对我们发出的 action 的应答（send_msg / get_record 等）
    if (data.echo !== undefined && settlePendingAction(data)) return;
    if (data.post_type === 'message') void handleMessage(data);
    // meta_event / notice / request / message_sent：忽略
  }

  function acceptSocket(socket) {
    sockets.add(socket);
    log.info('OneBot 连接建立（当前 %d 个）', sockets.size);
    writeRuntimeSnapshot({ transportAction: 'socket-open' });
    socket.on('message', (raw) => {
      try {
        handlePayload(JSON.parse(String(raw)));
      } catch (error) {
        log.warn('无法解析入站帧：%s', String(raw).slice(0, 200));
      }
    });
    socket.on('close', () => {
      sockets.delete(socket);
      log.info('OneBot 连接断开（剩余 %d 个）', sockets.size);
      writeRuntimeSnapshot({ transportAction: 'socket-close' });
    });
    socket.on('error', (error) => log.warn('OneBot 连接错误：%s', error?.message ?? error));
  }

  // ── 设置页控制面（同源 HTTP API，只给本机回环用）──────────────
  // 页面在 lib/client.js，注册到「设置 → QQ 桥接」。
  /** 改了这些字段要重开 WS（端口/地址/鉴权等传输层）。 */
  const TRANSPORT_FIELDS = ['mode', 'host', 'port', 'path', 'accessToken', 'url', 'reconnectMs'];

  /** 只收 DEFAULTS 里有的字段，按默认值类型做一次归一化（表单传进来的是字符串）。 */
  function sanitizeUiConfig(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('config 必须是一个对象');
    const next = {};
    for (const [key, value] of Object.entries(input)) {
      if (!(key in DEFAULTS)) continue; // 不认识的键直接忽略（防止页面写脏配置）
      const template = DEFAULTS[key];
      let normalized = value;
      if (Array.isArray(template)) {
        if (!Array.isArray(normalized)) throw new Error(`字段 ${key} 应该是数组`);
        normalized = key === 'allowlist'
          ? normalizeAllowlist(normalized, log)
          : normalized.map((item) => String(item ?? '').trim()).filter(Boolean);
      } else if (template && typeof template === 'object') {
        if (!normalized || typeof normalized !== 'object' || Array.isArray(normalized)) {
          throw new Error(`字段 ${key} 应该是对象`);
        }
        normalized = Object.fromEntries(
          Object.entries(normalized)
            .map(([k, v]) => [String(k).trim(), String(v ?? '').trim()])
            .filter(([k, v]) => k && v),
        );
      } else if (typeof template === 'number') {
        const num = typeof normalized === 'number' ? normalized : Number(String(normalized ?? '').trim());
        if (!Number.isFinite(num)) throw new Error(`字段 ${key} 应该是数字`);
        normalized = num;
      } else if (typeof template === 'boolean') {
        if (typeof normalized === 'string') normalized = normalized === 'true' || normalized === '1';
        normalized = !!normalized;
      } else {
        normalized = String(normalized ?? '');
      }
      next[key] = normalized;
    }
    return next;
  }

  /** 把设置页提交的字段并进生效配置，能热的立刻热。 */
  function applyUiConfig(next) {
    const changed = Object.keys(next).filter((key) => JSON.stringify(config[key]) !== JSON.stringify(next[key]));
    const transportChanged = changed.some((key) => TRANSPORT_FIELDS.includes(key));
    Object.assign(config, next);
    if (Object.prototype.hasOwnProperty.call(next, 'workspaceMap')) {
      // workspaceMap 是被闭包按引用共享的对象，原地换内容，别整体替换
      for (const key of Object.keys(workspaceMap)) delete workspaceMap[key];
      Object.assign(workspaceMap, next.workspaceMap);
    }
    if (transportChanged) {
      restartTransport();
      log.info('传输配置已改，WS 按新配置重开（%s）',
        config.mode === 'server' ? `${config.host}:${config.port}` : (config.url || '（client 模式没填 url）'));
    }
    // 主动消息相关改了：按新间隔/概率重排（关掉就只是清掉定时器）
    if (changed.some((key) => key.startsWith('wake'))) {
      scheduleWake();
      log.info('主动消息配置已更新（%s）', changed.filter((key) => key.startsWith('wake')).join('、'));
    }
    writeRuntimeSnapshot({ settingsUpdatedAt: new Date().toISOString(), settingsChanged: changed });
    return { changed, transportChanged };
  }

  /** 页面能看到的配置：accessToken 只回显是否存在，不把明文送到浏览器。 */
  function publicConfig() {
    const out = { ...config };
    out.hasAccessToken = !!config.accessToken;
    out.accessToken = config.accessToken ? '（已设置，不回显）' : '';
    return out;
  }

  function installControlApi() {
    const disposers = [];

    /** 只接受本机回环 + DSH 信任栅栏（写的是桥接配置，不能放任意网页进来）。 */
    function rejected(req, res) {
      const host = String(req.headers?.host ?? '').toLowerCase().split(':')[0];
      const loopback = host === '127.0.0.1' || host === 'localhost' || host === '[::1]' || host === '::1';
      if (!loopback) {
        sendJson(res, 403, { ok: false, error: '只接受本机回环访问' });
        return true;
      }
      try {
        const conn = ctx.get('connection');
        if (!conn || typeof conn.requestRejection !== 'function') {
          sendJson(res, 503, { ok: false, error: '信任栅栏不可用，拒绝访问' });
          return true;
        }
        const code = conn.requestRejection(req);
        if (code === undefined || code === null || code === false) return false;
        res.statusCode = typeof code === 'number' ? code : 403;
        res.end();
        return true;
      } catch {
        sendJson(res, 503, { ok: false, error: '信任栅栏异常，拒绝访问' });
        return true;
      }
    }

    function route(method, pathname, handler) {
      disposers.push(ctx.webServer.register({
        kind: 'exact',
        path: pathname,
        handler: async (req, res) => {
          if (rejected(req, res)) return;
          if (method && req.method !== method) {
            sendJson(res, 405, { ok: false, error: `只支持 ${method}` });
            return;
          }
          try {
            await handler(req, res);
          } catch (error) {
            try { sendJson(res, 500, { ok: false, error: String(error?.message ?? error) }); } catch { /* ignore */ }
          }
        },
      }));
    }

    // ── 状态 ──
    route('GET', '/dsh-qq-bridge/api/state', async (req, res) => {
      const ui = readUiSettings(settingsFile);
      const sessionFileState = loadSessionFile(config.sessionFile);
      sendJson(res, 200, {
        ok: true,
        settingsFile,
        settingsExists: ui.exists,
        settingsMtimeMs: ui.mtimeMs,
        settingsError: ui.error ?? null,
        settingsKeys: Object.keys(ui.values),
        config: publicConfig(),
        defaults: DEFAULTS,
        runtime: {
          startedAt,
          pid: process.pid,
          paused,
          stopped,
          sockets: sockets.size,
          listening: !!wss,
          transport: config.mode,
          workspaceRoot: config.workspaceRoot || workspaceRoot,
          workspaceMap: activeWorkspaceMapNow(),
          chats: [...chats.entries()].map(([chatKey, entry]) => ({
            chatKey,
            sessionId: entry.sessionId ?? null,
            workspace: entry.workspace?.path ?? null,
            borrowed: !!entry.borrowed,
          })),
          sessions: sessionFileState?.chats ?? {},
          workspaces: ctx.workspaceRegistry.list().map((ws) => ({
            id: ws.id,
            title: ws.title,
            path: ws.path,
            sessions: ws.sessionIds.length,
          })),
          speechToText: !!getSpeechToText(),
          stickers: stickerSummary(),
          wake: wakeSummary(),
          runtimeFile,
        },
      });
    });

    // ── 存设置（写文件 + 立即应用）──
    route('POST', '/dsh-qq-bridge/api/settings', async (req, res) => {
      const raw = await readJsonBody(req);
      let body;
      try {
        body = raw ? JSON.parse(raw) : {};
      } catch {
        sendJson(res, 400, { ok: false, error: '请求体不是 JSON' });
        return;
      }
      let next;
      try {
        next = sanitizeUiConfig(body?.config);
      } catch (error) {
        sendJson(res, 400, { ok: false, error: String(error?.message ?? error) });
        return;
      }
      if (Object.keys(next).length === 0) {
        sendJson(res, 400, { ok: false, error: '没有可保存的字段' });
        return;
      }
      // 冲突检测：读进来之后文件又被别处改过（手改 / agent 改）就 409，不静默覆盖
      const nowMtime = fileMtimeMs(settingsFile);
      const baseMtimeMs = Number(body?.baseMtimeMs ?? 0);
      if (nowMtime && Math.abs(nowMtime - baseMtimeMs) > 1) {
        sendJson(res, 409, {
          ok: false,
          error: '设置文件在你编辑期间被别处改过，先点「重新读取」再改，免得互相覆盖。',
          mtimeMs: nowMtime,
        });
        return;
      }
      const written = writeUiSettings(settingsFile, { ...readUiSettings(settingsFile).values, ...next });
      const applied = applyUiConfig(next);
      log.info('设置页已保存：%s', applied.changed.join('、') || '（无变化）');
      sendJson(res, 200, {
        ok: true,
        config: publicConfig(),
        settingsMtimeMs: written.mtimeMs,
        backup: written.backup,
        applied: applied.changed,
        transportChanged: applied.transportChanged,
      });
    });

    // ── 传输控制：暂停 / 恢复 / 重开 ──
    route('POST', '/dsh-qq-bridge/api/transport/pause', async (req, res) => {
      paused = true;
      stopTransport();
      scheduleWake();
      writeRuntimeSnapshot({ transportAction: 'pause' });
      log.info('设置页暂停了桥接（WS 已断开，会话都保留）');
      sendJson(res, 200, { ok: true, paused });
    });

    route('POST', '/dsh-qq-bridge/api/transport/resume', async (req, res) => {
      paused = false;
      startTransport();
      scheduleWake();
      writeRuntimeSnapshot({ transportAction: 'resume' });
      log.info('设置页恢复了桥接');
      sendJson(res, 200, { ok: true, paused });
    });

    route('POST', '/dsh-qq-bridge/api/transport/restart', async (req, res) => {
      paused = false;
      restartTransport();
      scheduleWake();
      sendJson(res, 200, { ok: true, paused });
    });

    // ── 查询 NapCat 账号（走 WS 的 get_login_info）──
    route('GET', '/dsh-qq-bridge/api/napcat', async (req, res) => {
      if (sockets.size === 0) {
        sendJson(res, 200, { ok: false, error: 'OneBot 还没连上（NapCat 是不是没开？）' });
        return;
      }
      try {
        const info = await sendActionAwait('get_login_info', {}, 5000);
        sendJson(res, 200, {
          ok: true,
          userId: String(info?.user_id ?? ''),
          nickname: String(info?.nickname ?? ''),
        });
      } catch (error) {
        sendJson(res, 200, { ok: false, error: String(error?.message ?? error) });
      }
    });

    // ── 清掉某个聊天的会话映射（下一条消息会在当前映射的工作区新建会话）──
    route('POST', '/dsh-qq-bridge/api/sessions/clear', async (req, res) => {
      const raw = await readJsonBody(req);
      let body;
      try {
        body = raw ? JSON.parse(raw) : {};
      } catch {
        sendJson(res, 400, { ok: false, error: '请求体不是 JSON' });
        return;
      }
      const chatKey = String(body?.chatKey ?? '').trim();
      if (!chatKey) {
        sendJson(res, 400, { ok: false, error: '缺 chatKey' });
        return;
      }
      await forgetSession(chatKey);
      const entry = chats.get(chatKey);
      if (entry) {
        chats.delete(chatKey);
        if (!entry.borrowed) {
          Promise.resolve()
            .then(() => settleWithTimeout(entry.workspace.detachSession(entry.sessionId), 5000, log, '解绑工作区'))
            .then(() => settleWithTimeout(entry.handle.dispose(), 5000, log, '销毁会话'))
            .catch(() => { /* 后台尽力而为 */ });
        }
      }
      log.info('设置页清除了会话映射：%s（下一条消息会新建会话）', chatKey);
      sendJson(res, 200, { ok: true, chatKey, hadLoadedSession: !!entry });
    });

    ctx.effect(() => () => {
      for (const dispose of disposers) {
        try { dispose(); } catch { /* ignore */ }
      }
    }, 'qq-bridge: control api');

    log.info('设置页 API 已挂载：/dsh-qq-bridge/api/*（设置文件 %s）', settingsFile);
  }

  // ── 传输启动 / 停止（设置页可以暂停、恢复、改端口后重开）──────
  function stopTransport() {
    // 先断开所有已建立连接，避免客户端挂在已销毁实例的僵尸连接上
    for (const socket of [...sockets]) {
      try { socket.terminate(); } catch { /* 忽略 */ }
    }
    sockets.clear();
    const server = wss;
    wss = null;
    try { server?.close(); } catch { /* 忽略 */ }
    const conn = client;
    client = null;
    try { conn?.terminate(); } catch { /* 忽略 */ }
  }

  function startTransport() {
    if (stopped || paused) return;
    const gen = ++transportGen;
    if (config.mode === 'server') {
      const server = new WebSocketServer({ host: config.host, port: config.port }, () => {
        log.info('反向 WS 已监听 ws://%s:%d%s（OneBot 客户端连接地址）', config.host, config.port, config.path === '/' ? '/' : config.path);
      });
      wss = server;
      server.on('connection', (socket, request) => {
        const urlPath = (request.url ?? '/').split('?')[0];
        if (config.path && config.path !== '/' && !urlPath.startsWith(config.path)) {
          log.warn('拒绝连接：路径 %s 不在允许前缀 %s 内', urlPath, config.path);
          socket.close();
          return;
        }
        if (config.accessToken) {
          const header = request.headers.authorization ?? '';
          if (header !== `Bearer ${config.accessToken}`) {
            log.warn('拒绝连接：access token 不匹配');
            socket.close();
            return;
          }
        }
        acceptSocket(socket);
      });
      server.on('error', (error) => log.warn('WS 服务端错误：%s', error?.message ?? error));
      return;
    }
    if (config.mode === 'client') {
      const connect = () => {
        if (stopped || paused || gen !== transportGen) return;
        if (!config.url) {
          log.warn('正向 WS 模式需要配置 url');
          return;
        }
        const socket = new WebSocket(config.url, {
          headers: config.accessToken ? { Authorization: `Bearer ${config.accessToken}` } : undefined,
        });
        client = socket;
        socket.on('open', () => {
          log.info('已连接机器人 WS：%s', config.url);
          if (gen === transportGen) acceptSocket(socket);
        });
        socket.on('close', () => {
          sockets.delete(socket);
          if (!stopped && !paused && gen === transportGen) {
            log.info('机器人 WS 断开，%d 毫秒后重连…', config.reconnectMs);
            setTimeout(connect, config.reconnectMs);
          }
        });
        socket.on('error', (error) => {
          if (!stopped) log.warn('机器人 WS 错误：%s', error?.message ?? error);
        });
      };
      connect();
      return;
    }
    log.warn('未知 mode：%s（应为 server 或 client），插件未启动传输', config.mode);
  }

  function restartTransport() {
    stopTransport();
    transportGen += 1; // 让上一代的 client 重连定时器失效
    startTransport();
    writeRuntimeSnapshot({ transportAction: 'restart' });
  }

  installControlApi();
  startTransport();
  scheduleWake();
  writeRuntimeSnapshot({ transportAction: 'start' });

  // 自检：客户端半边（「设置 → QQ 桥接」页）有没有被宿主登记成浏览器模块。
  // 插件日志不进文件，所以把结果落到磁盘，排查「装上了但设置里没这一页」时看它。
  setTimeout(() => {
    let report;
    try {
      const cm = ctx.get('clientModules');
      if (!cm) {
        report = { ok: false, error: 'clientModules 服务不可用' };
      } else {
        const sources = cm.sources;
        const names = sources instanceof Map
          ? [...sources.values()].map((source) => source?.packageName).filter(Boolean)
          : [];
        report = { ok: names.includes('dsh-qq-bridge'), registered: names.includes('dsh-qq-bridge'), clientModules: names };
      }
    } catch (error) {
      report = { ok: false, error: String(error?.message ?? error) };
    }
    writeFile(join(dirname(runtimeFile), 'bridge-client-probe.json'),
      `${JSON.stringify({ at: new Date().toISOString(), ...report }, null, 2)}\n`, 'utf8')
      .catch(() => { /* 自检失败不影响桥接 */ });
  }, 3000);

  // ── 卸载清理 ─────────────────────────────────────────────────
  ctx.effect(() => async () => {
    stopped = true;
    paused = true;
    transportGen += 1;
    if (wakeTimer) {
      clearTimeout(wakeTimer);
      wakeTimer = null;
    }
    stopTransport();
    // 关键：卸载必须尽快返回。会话销毁偶尔会长时间挂住，若在这里 await，
    // HMR 的配置重载队列会被永久阻塞（表现为改了 cordis.patch.yml 毫无反应，只能重启应用）。
    const pending = [...chats.values()];
    chats.clear();
    for (const entry of pending) {
      // 借来的会话是界面那边的，卸载时一根手指都别碰
      if (entry.borrowed) continue;
      Promise.resolve()
        .then(() => settleWithTimeout(entry.workspace.detachSession(entry.sessionId), 5000, log, '解绑工作区'))
        .then(() => settleWithTimeout(entry.handle.dispose(), 5000, log, '销毁会话'))
        .catch(() => { /* 后台尽力而为 */ });
    }
    log.info('qq-bridge 已卸载');
  }, 'qq-bridge lifecycle');
}

/** 声明插件依赖的 cordis 服务（在 ctx 上直接访问它们）。 */
qqBridge.inject = [
  'agents',
  'agentDefaultModel',
  'agentPresets',
  'permissionPresets',
  'sessionTitle',
  'workspaceRegistry',
  'webServer',
  'connection',
];


