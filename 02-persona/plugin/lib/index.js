/**
 * dsh-persona —— 宿主半边
 *
 * 给设置页「身份与人设」提供同源接口，读写的对象就是 QQ 桥接在用的那份人格文件
 * （默认 <DSH_HOME>/qq-bridge/personas.json）。桥接每条消息都会重新读这个文件，
 * 所以这里一保存，QQ 下一条消息就是新人设，不用重启。
 *
 * 文件还不存在时，用包里的 templates/personas.template.json 初始化（模板里只带一个示例性格），
 * 这样第一次打开页面就能看到/改一份现成的人设，而不是面对一个空文件。
 *
 * 路由（同源，仅本机回环 + 信任栅栏放行）：
 *   GET    /dsh-persona/api/personas  → { ok, personas, path, exists, mtimeMs }
 *   POST   /dsh-persona/api/personas  → body { personas, baseMtimeMs }
 *   POST   /dsh-persona/api/learn     → body { name, extra? } → { ok, jobId, job }
 *   GET    /dsh-persona/api/learn?jobId=…  → 轮询学习进度 / 结果
 *   DELETE /dsh-persona/api/learn?jobId=…  → 取消
 *   POST   /dsh-persona/api/split     → body { text, name? } → { ok, mode, model }（老格式拆成三段式）
 *
 * 模式的两种写法见 lib/mode.js：老格式是一整段字符串，新格式是三段式对象
 * （identity / behavior / replyStyle + variants + variantChance）。同一个 modes 里可以混用。
 *
 * 「学习角色」是后台任务：先搜资料（萌娘百科 / 360 百科 / 360 搜索 / Bing），
 * 再抓页面、拼语料，最后用当前默认模型提炼成人设 + 一段可直接用的角色提示词。
 * 学出来的结果不自动落盘，等用户在页面上确认/微调后再存进 personas.json.characters。
 *
 * 写入规矩：
 *   1. 先备份旧文件（personas.json.bak-YYYYMMDD-HHMMSS，最多留 20 份）；
 *   2. 写临时文件再原子改名，避免写一半留下半个 JSON；
 *   3. baseMtimeMs 对不上 = 文件被别处改过（agent / 手改），返回 409 让用户先重新读取，
 *      绝不静默覆盖别人的改动。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { learnCharacter } from './learn.js'
import { composeModeBody, normalizeModeValue } from './mode.js'
import { splitModeWithLlm } from './split.js'
import {
  addSample,
  emptySpeechState,
  loadSpeechFile,
  looksLikeHumanMessage,
  saveSpeechFile,
} from './speech.js'

/** 插件包根目录（lib/ 的上一级），用来找包里的模板。 */
const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
/** 人格模板：personas.json 不存在时用它初始化。 */
const DEFAULT_TEMPLATE_FILE = path.join(PKG_ROOT, 'templates', 'personas.template.json')
/** DSH 数据目录：和 QQ 桥接的默认位置保持一致。 */
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
/** 默认人格文件：<DSH_HOME>/qq-bridge/personas.json；可在 cordis config.personaFile 里改。 */
const DEFAULT_PERSONA_FILE = path.join(DSH_HOME, 'qq-bridge', 'personas.json')
/** 备份最多留几份（多了会占目录）。 */
const BACKUP_KEEP = 20

/** 文件不存在时的兜底空骨架（模板读不到才用它）。 */
const EMPTY_PERSONAS = {
  version: 1,
  note: '每个会话可配置多个性格模式；active 是当前生效的模式名。可直接手改本文件，保存后下一条消息即生效。',
  default: { title: '默认', prompt: '' },
  chats: {},
  rules: {},
  characters: {},
}

/** 当前生效的初始人格（apply 时按配置的模板文件加载）。 */
let initialPersonas = normalizeSafe(EMPTY_PERSONAS)

/** normalizePersonas 还没定义时先占位，apply 之后一定被替换成真正整理过的模板。 */
function normalizeSafe(input) {
  try {
    return normalizePersonas(input)
  } catch {
    return input
  }
}

/** 角色库里每个字段的类型与上限（AI 学出来的东西可能超长，保存前统一收一下）。 */
const TEXT_LIMITS = {
  title: 120,
  summary: 400,
  personality: 3000,
  speechStyle: 4000,
  address: 400,
  prompt: 20000,
}
const LIST_LIMITS = { catchphrases: 20, examples: 20, taboos: 20 }
const ITEM_LIMIT = 400

/** 收一个字符串字段：非字符串当空，去掉首尾空白并截断。 */
function asText(value, limit) {
  if (typeof value !== 'string') return ''
  const text = value.trim()
  return limit && text.length > limit ? text.slice(0, limit) : text
}

/** 收一个字符串列表字段。 */
function asList(value, limit, itemLimit) {
  if (!Array.isArray(value)) return []
  const out = []
  for (const item of value) {
    const text = typeof item === 'string' ? item.trim() : ''
    if (!text) continue
    out.push(itemLimit && text.length > itemLimit ? text.slice(0, itemLimit) : text)
    if (out.length >= limit) break
  }
  return out
}

/**
 * 把角色库（characters）整理成合法结构。
 * 角色是「从互联网学的」或用户手写的都行，键名就是角色名。
 */
function normalizeCharacters(input) {
  const out = {}
  const raw = input && typeof input === 'object' && !Array.isArray(input) ? input : {}
  for (const [key, block] of Object.entries(raw)) {
    if (!block || typeof block !== 'object' || Array.isArray(block)) continue
    const name = asText(block.name, 60) || asText(key, 60)
    if (!name) continue
    const sources = []
    if (Array.isArray(block.sources)) {
      for (const source of block.sources) {
        if (!source || typeof source !== 'object') continue
        const url = asText(source.url, 1000)
        if (!url) continue
        sources.push({ title: asText(source.title, 200), url })
        if (sources.length >= 12) break
      }
    }
    const createdAt = Number(block.createdAt)
    const updatedAt = Number(block.updatedAt)
    const item = {
      name,
      title: asText(block.title, TEXT_LIMITS.title),
      summary: asText(block.summary, TEXT_LIMITS.summary),
      personality: asText(block.personality, TEXT_LIMITS.personality),
      speechStyle: asText(block.speechStyle, TEXT_LIMITS.speechStyle),
      catchphrases: asList(block.catchphrases, LIST_LIMITS.catchphrases, ITEM_LIMIT),
      address: asText(block.address, TEXT_LIMITS.address),
      examples: asList(block.examples, LIST_LIMITS.examples, ITEM_LIMIT),
      taboos: asList(block.taboos, LIST_LIMITS.taboos, ITEM_LIMIT),
      prompt: asText(block.prompt, TEXT_LIMITS.prompt),
      sources,
      createdAt: Number.isFinite(createdAt) ? createdAt : 0,
      updatedAt: Number.isFinite(updatedAt) ? updatedAt : 0,
    }
    if (block.degraded === true) item.degraded = true
    const model = asText(block.model, 120)
    if (model) item.model = model
    // 全空的条目没有意义，别让它占着名字（比如手滑写了个 "{}"）。
    const hasContent =
      item.title ||
      item.summary ||
      item.personality ||
      item.speechStyle ||
      item.address ||
      item.prompt ||
      item.catchphrases.length > 0 ||
      item.examples.length > 0 ||
      item.taboos.length > 0 ||
      item.sources.length > 0
    if (!hasContent) continue
    out[name] = item
  }
  return out
}

export const inject = ['webServer', 'connection']

/** JSON 响应。 */
function json(res, code, obj) {
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  })
  res.end(JSON.stringify(obj))
}

/** 读请求体（限 2MB，人设文件本身可能几十 KB，留足余量）。 */
function readBody(req, limit = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('请求体太大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

/** 时间戳：20261023-211500 */
function stamp() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

/**
 * 把任意输入整理成合法的 personas 结构。
 * 结构：{ version, note, default:{title,prompt}, chats:{ key:{active,modes:{名:正文或三段式}} }, rules:{名:正文} }
 * 不认识的顶层字段 / 会话字段原样保留，免得以后加字段被这个页面抹掉。
 */
function normalizePersonas(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('personas 必须是一个 JSON 对象')
  }
  const out = { ...input }

  const version = Number(out.version)
  out.version = Number.isFinite(version) ? version : 1
  if (typeof out.note !== 'string') out.note = ''

  const def = out.default && typeof out.default === 'object' && !Array.isArray(out.default) ? out.default : {}
  out.default = {
    ...def,
    title: typeof def.title === 'string' && def.title.trim() ? def.title.trim() : '默认',
    prompt: typeof def.prompt === 'string' ? def.prompt : '',
  }

  const chats = {}
  const rawChats = out.chats && typeof out.chats === 'object' && !Array.isArray(out.chats) ? out.chats : {}
  for (const [key, block] of Object.entries(rawChats)) {
    const chatKey = String(key).trim()
    if (!chatKey) continue
    if (!block || typeof block !== 'object' || Array.isArray(block)) {
      throw new Error(`会话「${chatKey}」的结构不对（应该是一个对象）`)
    }
    const modes = {}
    const rawModes = block.modes && typeof block.modes === 'object' && !Array.isArray(block.modes) ? block.modes : {}
    for (const [name, prompt] of Object.entries(rawModes)) {
      const modeName = String(name).trim()
      if (!modeName) continue
      if (modeName in modes) throw new Error(`会话「${chatKey}」里有重复的性格名「${modeName}」`)
      // 字符串 = 老格式（原样保留）；对象 = 三段式（统一收口，见 lib/mode.js）
      modes[modeName] = normalizeModeValue(prompt)
    }
    if (Object.keys(modes).length === 0) modes['默认'] = ''
    const active = typeof block.active === 'string' && block.active in modes ? block.active : Object.keys(modes)[0]
    chats[chatKey] = { ...block, active, modes }
  }
  out.chats = chats

  const rules = {}
  const rawRules = out.rules && typeof out.rules === 'object' && !Array.isArray(out.rules) ? out.rules : {}
  for (const [name, text] of Object.entries(rawRules)) {
    const ruleName = String(name).trim()
    if (!ruleName) continue
    rules[ruleName] = typeof text === 'string' ? text : String(text ?? '')
  }
  out.rules = rules

  // 角色库：从互联网学来的角色（或手写的角色）都放在这里，QQ 桥接不读它，
  // 由设置页负责「套用到某个会话的模式」。
  out.characters = normalizeCharacters(out.characters)

  return out
}

/** 读当前文件的 mtime（毫秒）；文件不存在返回 0。 */
function currentMtime(file) {
  try {
    const st = fs.statSync(file, { throwIfNoEntry: false })
    return st && st.isFile() ? st.mtimeMs : 0
  } catch {
    return 0
  }
}

/** 读模板文件并整理成合法 personas；读不到就用空骨架。 */
function loadTemplate(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    const normalized = normalizePersonas(parsed)
    try {
      console.log(`[dsh-persona] 人格模板已加载：${file}`)
    } catch { /* ignore */ }
    return normalized
  } catch (error) {
    try {
      console.warn(`[dsh-persona] 读模板失败（${file}）：${String(error?.message ?? error)}，改用空骨架`)
    } catch { /* ignore */ }
    return normalizePersonas(EMPTY_PERSONAS)
  }
}

/** 读文件；不存在时返回模板内容（第一次保存会把模板落到 personas.json）。 */
function readPersonas(file) {
  const mtimeMs = currentMtime(file)
  if (!mtimeMs) {
    return { exists: false, mtimeMs: 0, personas: initialPersonas }
  }
  const raw = fs.readFileSync(file, 'utf8')
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new Error(`personas.json 不是合法 JSON：${String(error?.message ?? error)}（先用编辑器修好，或直接覆盖保存）`)
  }
  return { exists: true, mtimeMs, personas: normalizePersonas(parsed) }
}

/** 清理旧备份，只留最近 BACKUP_KEEP 份（只动本插件自己生成的文件名）。 */
function pruneBackups(file) {
  try {
    const dir = path.dirname(file)
    const base = path.basename(file) + '.bak-'
    const backups = fs
      .readdirSync(dir)
      .filter((name) => name.startsWith(base))
      .sort()
      .reverse()
    for (const name of backups.slice(BACKUP_KEEP)) {
      try {
        fs.unlinkSync(path.join(dir, name))
      } catch {
        /* 删不掉就算了，不影响保存 */
      }
    }
  } catch {
    /* 目录读不了时跳过清理 */
  }
}

/** 备份 + 原子写。返回 { backup, mtimeMs }。 */
function writePersonas(file, next) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  let backup = null
  if (currentMtime(file)) {
    backup = `${file}.bak-${stamp()}`
    try {
      fs.copyFileSync(file, backup)
    } catch {
      backup = null // 备份失败也照常保存（原文件还在，写的是临时文件）
    }
    pruneBackups(file)
  }
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
  fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
  try {
    fs.renameSync(tmp, file) // Windows 上覆盖已有文件也走 MoveFileEx(REPLACE_EXISTING)
  } catch (error) {
    try { fs.unlinkSync(tmp) } catch { /* ignore */ }
    throw error
  }
  return { backup, mtimeMs: currentMtime(file) }
}

/**
 * 安装插件。
 * @param {import('@cordisjs/core').Context} ctx
 * @param {{ personaFile?: string, templateFile?: string, speechFile?: string, provider?: string, model?: string }} [config]
 */
export function apply(ctx, config) {
  const personaFile = String(config?.personaFile || DEFAULT_PERSONA_FILE)
  const templateFile = String(config?.templateFile || DEFAULT_TEMPLATE_FILE)
  const speechFile = String(config?.speechFile || path.join(path.dirname(personaFile), 'speech-habits.json'))
  initialPersonas = loadTemplate(templateFile)
  const disposers = []

  /** 只接受本机回环 + DSH 信任栅栏（浏览器里任意网页都能打回环端口，必须挡）。 */
  function rejected(req, res) {
    const host = String(req.headers?.host ?? '').toLowerCase().split(':')[0]
    const loopback = host === '127.0.0.1' || host === 'localhost' || host === '[::1]' || host === '::1'
    if (!loopback) {
      json(res, 403, { ok: false, error: '只接受本机回环访问' })
      return true
    }
    try {
      const conn = ctx.get('connection')
      if (!conn || typeof conn.requestRejection !== 'function') {
        // 信任栅栏不可用 → fail-closed（写的是人格文件，不能放任意页面进来）
        json(res, 503, { ok: false, error: '信任栅栏不可用，拒绝访问' })
        return true
      }
      const code = conn.requestRejection(req)
      if (code === undefined || code === null || code === false) return false
      res.statusCode = typeof code === 'number' ? code : 403
      res.end()
      return true
    } catch {
      json(res, 503, { ok: false, error: '信任栅栏异常，拒绝访问' })
      return true
    }
  }

  // ── 说话习惯：监听会话里的用户消息，只统计长度和标点（不存原话） ──────────
  let speechState = loadSpeechFile(speechFile, fs)
  let speechTimer = null
  const flushSpeech = () => {
    if (speechTimer) {
      clearTimeout(speechTimer)
      speechTimer = null
    }
    saveSpeechFile(speechFile, speechState, fs, path)
  }
  const scheduleSpeechSave = () => {
    if (speechTimer) return
    speechTimer = setTimeout(() => {
      speechTimer = null
      saveSpeechFile(speechFile, speechState, fs, path)
    }, 3000)
  }
  const speechView = () => ({
    file: speechFile,
    samples: speechState.samples ?? 0,
    stats: speechState.stats ?? null,
    prompt: speechState.prompt ?? '',
    updatedAt: speechState.updatedAt ?? 0,
  })
  /** 一条用户消息 → 统计。桥接/系统拼的提示词会被 looksLikeHumanMessage 挡掉。 */
  function onSessionEvent(_session, event) {
    try {
      if (!event || event.type !== 'user/message') return
      const message = event.data
      if (!message || message.role !== 'user') return
      if (message.source && message.source.kind !== 'user') return
      const text = Array.isArray(message.content)
        ? message.content
            .filter((block) => block && block.type === 'text')
            .map((block) => String(block.text ?? ''))
            .join('\n')
        : ''
      if (!text || !looksLikeHumanMessage(text)) return
      speechState = addSample(speechState, text)
      scheduleSpeechSave()
    } catch {
      /* 统计出错不影响聊天 */
    }
  }
  ctx.effect(() => {
    if (typeof ctx.on !== 'function') return () => {}
    const off = ctx.on('session/event', onSessionEvent)
    return () => {
      try {
        if (typeof off === 'function') off()
      } catch { /* ignore */ }
      flushSpeech()
    }
  }, 'dsh-persona: speech collector')

  function route(kind, pathname, handler) {
    disposers.push(
      ctx.webServer.register({
        kind,
        path: pathname,
        handler: async (req, res) => {
          if (rejected(req, res)) return
          try {
            await handler(req, res)
          } catch (error) {
            try { json(res, 500, { ok: false, error: String(error?.message ?? error) }) } catch { /* ignore */ }
          }
        },
      }),
    )
  }

  route('exact', '/dsh-persona/api/personas', async (req, res) => {
    if (req.method === 'GET') {
      const state = readPersonas(personaFile)
      json(res, 200, { ok: true, path: personaFile, ...state })
      return
    }
    if (req.method !== 'POST') {
      json(res, 405, { ok: false, error: '只支持 GET / POST' })
      return
    }

    const raw = await readBody(req)
    let body
    try {
      body = raw ? JSON.parse(raw) : {}
    } catch {
      json(res, 400, { ok: false, error: '请求体不是 JSON' })
      return
    }
    const next = normalizePersonas(body?.personas)

    // 冲突检测：加载之后文件又被别人改过 → 不覆盖，让用户先重新读取
    const baseMtimeMs = Number(body?.baseMtimeMs ?? 0)
    const nowMtimeMs = currentMtime(personaFile)
    if (Math.abs(nowMtimeMs - baseMtimeMs) > 1) {
      json(res, 409, {
        ok: false,
        error: 'personas.json 在你编辑期间被别处改过（agent 或手改）。先点「重新读取」再改，免得互相覆盖。',
        mtimeMs: nowMtimeMs,
      })
      return
    }

    const written = writePersonas(personaFile, next)
    json(res, 200, {
      ok: true,
      path: personaFile,
      exists: true,
      personas: next,
      mtimeMs: written.mtimeMs,
      backup: written.backup,
    })
  })

  // ── 说话习惯：只读统计 / 重置 / 手动补一条（测试和人肉校准用） ────────────
  route('exact', '/dsh-persona/api/speech', async (req, res) => {
    if (req.method === 'GET') {
      json(res, 200, { ok: true, ...speechView() })
      return
    }
    if (req.method !== 'POST') {
      json(res, 405, { ok: false, error: '只支持 GET / POST' })
      return
    }
    const raw = await readBody(req)
    let body
    try {
      body = raw ? JSON.parse(raw) : {}
    } catch {
      json(res, 400, { ok: false, error: '请求体不是 JSON' })
      return
    }
    const action = String(body?.action ?? '')
    if (action === 'reset') {
      speechState = emptySpeechState()
      flushSpeech()
      json(res, 200, { ok: true, ...speechView() })
      return
    }
    if (action === 'add') {
      const text = String(body?.text ?? '')
      if (!text.trim()) {
        json(res, 400, { ok: false, error: 'text 不能为空' })
        return
      }
      if (!looksLikeHumanMessage(text)) {
        json(res, 400, { ok: false, error: '这段看起来像桥接/系统提示词，不计入' })
        return
      }
      speechState = addSample(speechState, text)
      flushSpeech()
      json(res, 200, { ok: true, ...speechView() })
      return
    }
    json(res, 400, { ok: false, error: 'action 只支持 add / reset' })
  })

  // ── 老格式 → 三段式：调一次模型拆，结果只回给页面，不落盘 ──────────────────
  route('exact', '/dsh-persona/api/split', async (req, res) => {
    if (req.method !== 'POST') {
      json(res, 405, { ok: false, error: '只支持 POST' })
      return
    }
    const raw = await readBody(req)
    let body
    try {
      body = raw ? JSON.parse(raw) : {}
    } catch {
      json(res, 400, { ok: false, error: '请求体不是 JSON' })
      return
    }
    if (!String(body?.text ?? '').trim()) {
      json(res, 400, { ok: false, error: '先把要拆的人格正文发过来' })
      return
    }
    try {
      const { mode, model } = await splitModeWithLlm(ctx, {
        text: String(body.text),
        name: String(body?.name ?? '').slice(0, 60),
        config: { provider: config?.provider, model: config?.model },
      })
      json(res, 200, { ok: true, mode, model, chars: composeModeBody(mode).length })
    } catch (error) {
      json(res, 500, { ok: false, error: String(error?.message ?? error) })
    }
  })

  // ── 从互联网学习角色：后台任务 + 前台轮询 ──────────────────────────────
  /** jobId → 任务对象（内存里，DSH 重启就没了）。 */
  const jobs = new Map()
  /** 任务结果保留 30 分钟。 */
  const JOB_TTL_MS = 30 * 60 * 1000
  /** 同时最多学几个（每个都要搜网页 + 调模型）。 */
  const MAX_RUNNING = 2

  function pruneJobs() {
    const now = Date.now()
    for (const [id, job] of jobs) {
      if (job.state === 'running') continue
      if (now - (job.finishedAt || job.startedAt) > JOB_TTL_MS) jobs.delete(id)
    }
  }

  /** 给前端的任务视图（不含 controller）。 */
  function publicJob(job) {
    return {
      id: job.id,
      name: job.name,
      state: job.state,
      step: job.step,
      logs: job.logs,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt || 0,
      elapsedMs: (job.finishedAt || Date.now()) - job.startedAt,
      result: job.result,
      error: job.error,
    }
  }

  function startLearnJob(name, extra) {
    pruneJobs()
    const running = [...jobs.values()].filter((job) => job.state === 'running').length
    if (running >= MAX_RUNNING) throw new Error('已经在学别的角色了，等它学完再试')
    const job = {
      id: randomUUID(),
      name,
      state: 'running',
      step: '准备中',
      logs: [],
      startedAt: Date.now(),
      finishedAt: 0,
      result: null,
      error: null,
      controller: new AbortController(),
    }
    const log = (step, text) => {
      if (step !== 'net') job.step = step
      job.logs.push({ t: Date.now(), step, text })
      if (job.logs.length > 300) job.logs.splice(0, job.logs.length - 300)
    }
    jobs.set(job.id, job)
    ;(async () => {
      try {
        const out = await learnCharacter({
          ctx,
          name,
          extra,
          log,
          signal: job.controller.signal,
          config: { provider: config?.provider, model: config?.model },
        })
        job.result = out
        job.state = 'done'
        job.step = '完成'
      } catch (error) {
        job.error = String(error?.message ?? error)
        job.state = job.controller.signal.aborted ? 'canceled' : 'error'
        job.step = job.state === 'canceled' ? '已取消' : '失败'
        try {
          console.warn(`[dsh-persona] 学习「${job.name}」失败：${job.error}`)
        } catch { /* ignore */ }
      } finally {
        job.finishedAt = Date.now()
      }
    })()
    return job
  }

  route('exact', '/dsh-persona/api/learn', async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://dsh.invalid')

    if (req.method === 'POST') {
      const raw = await readBody(req)
      let body
      try {
        body = raw ? JSON.parse(raw) : {}
      } catch {
        json(res, 400, { ok: false, error: '请求体不是 JSON' })
        return
      }
      const name = String(body?.name ?? '').trim()
      if (!name) {
        json(res, 400, { ok: false, error: '先给一个角色名字' })
        return
      }
      if (name.length > 60) {
        json(res, 400, { ok: false, error: '角色名太长了（60 字以内）' })
        return
      }
      const extra = String(body?.extra ?? '').slice(0, 1000)
      try {
        const job = startLearnJob(name, extra)
        json(res, 200, { ok: true, jobId: job.id, job: publicJob(job) })
      } catch (error) {
        json(res, 429, { ok: false, error: String(error?.message ?? error) })
      }
      return
    }

    if (req.method === 'GET') {
      pruneJobs()
      const job = jobs.get(url.searchParams.get('jobId') || '')
      if (!job) {
        json(res, 404, { ok: false, error: '没有这个学习任务（可能过期了，重新学一次）' })
        return
      }
      json(res, 200, { ok: true, job: publicJob(job) })
      return
    }

    if (req.method === 'DELETE') {
      const job = jobs.get(url.searchParams.get('jobId') || '')
      if (!job) {
        json(res, 404, { ok: false, error: '没有这个学习任务' })
        return
      }
      if (job.state === 'running') {
        try { job.controller.abort() } catch { /* ignore */ }
      }
      json(res, 200, { ok: true, job: publicJob(job) })
      return
    }

    json(res, 405, { ok: false, error: '只支持 GET / POST / DELETE' })
  })

  ctx.effect(() => () => {
    // 插件卸载/重载时把还在跑的学习任务停掉
    for (const job of jobs.values()) {
      if (job.state === 'running') {
        try { job.controller.abort() } catch { /* ignore */ }
      }
    }
    jobs.clear()
    for (const dispose of disposers) {
      try { dispose() } catch { /* ignore */ }
    }
  }, 'dsh-persona: routes')

  try {
    console.log(`[dsh-persona] 身份与人设设置页 API 已挂载：/dsh-persona/api/personas · /api/learn · /api/speech · /api/split · 文件 ${personaFile}`)
  } catch { /* ignore */ }
}
