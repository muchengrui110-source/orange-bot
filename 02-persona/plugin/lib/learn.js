/**
 * dsh-persona · 「从互联网学习角色」核心流程
 *
 * 输入一个角色名，做三件事：
 *   1. 找资料：萌娘百科 / 360 百科 / 360 搜索 / Bing（都是直连，不需要 key）；
 *   2. 抓正文：用 parse.js 的解析规则把页面抽成纯文本，拼成一份「语料」，带来源标注；
 *   3. 让模型提炼：用 DSH 当前的默认模型（ctx.llm）把语料提炼成结构化人设 + 一段可直接用的角色提示词。
 *
 * 这里不依赖任何 @deepseek-ai 包：消息对象按宿主 createUserMessage 的形状自己造，
 * 流式片段只取 text-delta / finish，失败原样抛给调用方（由 index.js 记进任务日志）。
 */
import {
  baike360Clean,
  bingParse,
  decodeEntities,
  genericClean,
  is360Captcha,
  moegirlClean,
  pageTitle,
  so360Parse,
  stripTags,
} from './parse.js'

export { decodeEntities, stripTags }

/** 统一用浏览器 UA：这批站点对非浏览器 UA 很敏感。 */
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'
const ACCEPT_LANGUAGE = 'zh-CN,zh;q=0.9,en;q=0.6'

/** 单个页面的截取上限（字符）。 */
const PAGE_CHARS = 5200
/** 整份语料的上限（字符）。 */
const MAX_CORPUS_CHARS = 22000
/** 一次最多抓几个搜索结果的页面。 */
const MAX_FETCHED_PAGES = 3
/** 单次 HTTP 请求超时。 */
const HTTP_TIMEOUT_MS = 15000

/** 搜索结果里点开也打不开 / 没必要抓的域名。 */
const SKIP_HOSTS = [
  'baike.baidu.com',
  'zhihu.com',
  'weibo.com',
  'weibo.cn',
  'douyin.com',
  'tieba.baidu.com',
  'xiaohongshu.com',
  'bilibili.com',
  'baijiahao.baidu.com',
]

/** 360 搜索的跳转链接（JS/meta 跳转，抓不出正文，只当来源地址）。 */
function is360Link(url) {
  try {
    const u = new URL(url)
    return u.hostname === 'www.so.com' || u.hostname === 'so.com' ? u.pathname.startsWith('/link') : false
  } catch {
    return false
  }
}

/** 判断一个 url 值不值得抓。 */
function usableUrl(value) {
  if (typeof value !== 'string') return undefined
  let url
  try {
    url = new URL(value)
  } catch {
    return undefined
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
  const host = url.hostname.toLowerCase()
  if (SKIP_HOSTS.some((skip) => host === skip || host.endsWith(`.${skip}`))) return undefined
  return url.href
}

/** 只保留和角色相关的段落（名字或人设关键词命中），并截断。 */
export function trimToRelevant(text, name) {
  const lines = String(text).split('\n')
  const keyword = /(性格|人设|说话|台词|口癖|口头禅|自称|称呼|喜好|喜欢|讨厌|声优|配音|角色|设定|登场|外貌|背景|经历|名言|梗|身份)/
  const picked = []
  let total = 0
  for (const line of lines) {
    const hit = line.includes(name) || keyword.test(line)
    if (!hit) continue
    if (line.length > 600) {
      picked.push(line.slice(0, 600))
      total += 600
    } else {
      picked.push(line)
      total += line.length
    }
    if (total >= PAGE_CHARS) break
  }
  if (picked.length === 0) return String(text).slice(0, PAGE_CHARS)
  return picked.join('\n').slice(0, PAGE_CHARS)
}

/**
 * 通用正文抽取：优先已知正文容器（萌娘/360 百科），否则全页去标签。
 * @param {string} html
 * @returns {string}
 */
export function extractReadable(html) {
  const moe = moegirlClean(html)
  if (moe.containerFound && moe.text.length > 80) return moe.text
  const baike = baike360Clean(html)
  if (baike.containerFound && baike.text.length > 80) return baike.text
  return genericClean(html)
}

/** 解析 360 搜索的结果块。 */
export function parseSearch360(html) {
  const out = so360Parse(html)
  return out.map((item) => {
    let url = item.url
    if (url.startsWith('/')) url = `https://www.so.com${url}`
    return { ...item, url }
  })
}

/** 解析 Bing 结果块。 */
export function parseSearchBing(html) {
  return bingParse(html)
}

/** 单个 GET，带浏览器 UA、超时、取消；options.log 用来把请求记进学习任务日志。 */
export async function httpGet(url, { timeoutMs = HTTP_TIMEOUT_MS, signal, headers = {}, log } = {}) {
  const timeout = AbortSignal.timeout(timeoutMs)
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout
  log?.(`→ ${url}`)
  try {
    const response = await fetch(url, {
      headers: {
        'user-agent': UA,
        'accept-language': ACCEPT_LANGUAGE,
        accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
        ...headers,
      },
      redirect: 'follow',
      signal: combined,
    })
    const text = await response.text()
    log?.(`← ${response.status} ${url}`)
    return { status: response.status, url: response.url || url, text }
  } catch (error) {
    log?.(`✗ ${String(error?.name ?? 'ERR')} ${url}`)
    throw error
  }
}

/** 360 搜索。 */
export async function search360(query, options = {}) {
  const url = `https://www.so.com/s?q=${encodeURIComponent(query)}`
  const page = await httpGet(url, options)
  if (page.status !== 200) throw new Error(`360 搜索 HTTP ${page.status}`)
  if (is360Captcha(page.text)) throw new Error('360 搜索触发安全验证')
  return parseSearch360(page.text)
}

/** Bing 搜索。注意：中文多词查询会被 Bing 截断，只适合用名字单词查。 */
export async function searchBing(query, options = {}) {
  const url = `https://www.bing.com/search?q=${encodeURIComponent(query)}&setlang=zh-CN`
  const page = await httpGet(url, options)
  if (page.status !== 200) throw new Error(`Bing HTTP ${page.status}`)
  return parseSearchBing(page.text)
}

/** 从萌娘百科的搜索结果页/消歧义页里选一个最像的条目链接。 */
function pickMoegirlCandidate(candidates, name) {
  if (!Array.isArray(candidates) || candidates.length === 0) return undefined
  const exact = candidates.find((item) => item.title.replace(/\(.*?\)/g, '').trim() === name)
  if (exact) return exact
  const hasName = candidates.find((item) => item.title.includes(name))
  if (hasName) return hasName
  return candidates[0]
}

/** 萌娘百科是不是把人挡去登录/认证页了（触发限流时会出现）。 */
function moegirlBlocked(page) {
  try {
    if (/^\/Special:/i.test(new URL(page.url).pathname)) return true
  } catch {
    /* 忽略 */
  }
  const title = pageTitle(page.text)
  return /萌娘认证系统|用户登录|需要登录|登录\s*-\s*萌娘百科/.test(title)
}

/** 这篇文章是不是真的在讲这个角色（标题或正文里得出现名字）。 */
function matchesName(title, text, name) {
  return (title && title.includes(name)) || (text && text.includes(name))
}

/**
 * 萌娘百科：先按「条目名」直接抓（同名条目最准），不行再用搜索页兜底；
 * 遇到消歧义页挑最像的条目，遇到登录/认证页直接放弃。
 * @returns {Promise<{title: string, url: string, text: string}|undefined>}
 */
export async function lookupMoegirl(name, options = {}) {
  const finish = (page, cleaned) => {
    const text = trimToRelevant(cleaned.text, name)
    if (text.length < 60) return undefined
    const title = (cleaned.title || pageTitle(page.text) || name).replace(/\s*-\s*萌娘百科.*$/, '').trim()
    return { title: title || name, url: page.url, text }
  }
  const tryArticle = async (url) => {
    const page = await httpGet(url, options)
    if (page.status !== 200 || moegirlBlocked(page)) return undefined
    const cleaned = moegirlClean(page.text)
    if (!cleaned.containerFound) return undefined
    if (cleaned.isDisambig) {
      const picked = pickMoegirlCandidate(cleaned.candidates, name)
      if (!picked) return undefined
      const next = await httpGet(picked.href, options)
      if (next.status !== 200 || moegirlBlocked(next)) return undefined
      const clean2 = moegirlClean(next.text)
      if (!clean2.containerFound || clean2.isDisambig || !matchesName(clean2.title, clean2.text, name)) return undefined
      return finish(next, clean2)
    }
    if (!matchesName(cleaned.title, cleaned.text, name)) return undefined
    return finish(page, cleaned)
  }

  // 1) 直接条目名
  const direct = await tryArticle(`https://mzh.moegirl.org.cn/${encodeURIComponent(name)}`)
  if (direct) return direct

  // 2) 搜索页兜底（会 302 到条目，也可能是搜索结果列表）
  const searchUrl = `https://mzh.moegirl.org.cn/index.php?search=${encodeURIComponent(
    name,
  )}&title=Special%3A%E6%90%9C%E7%B4%A2`
  const first = await httpGet(searchUrl, options)
  if (first.status !== 200 || moegirlBlocked(first)) return undefined
  const parsedUrl = new URL(first.url)
  if (!/\/index\.php\?/.test(parsedUrl.pathname + parsedUrl.search)) {
    // 已经跳到条目页
    const again = await tryArticle(first.url)
    if (again) return again
  } else {
    const heading = (text) => {
      const out = []
      const re = /<div[^>]+class="mw-search-result-heading"[^>]*>[\s\S]*?<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi
      let m
      while ((m = re.exec(text)) && out.length < 20) out.push({ href: new URL(m[1], 'https://mzh.moegirl.org.cn/').href, title: stripTags(m[2]).trim() })
      return out
    }
    const list = heading(first.text)
    const picked = pickMoegirlCandidate(list, name)
    if (picked) {
      const again = await tryArticle(picked.href)
      if (again) return again
    }
  }
  return undefined
}

/** 把 360 百科正文 + 基本信息卡拼成一段。 */
function baikeItemFrom(html, url, name) {
  const cleaned = baike360Clean(html)
  if (!cleaned.containerFound && !cleaned.text) return undefined
  const infoLines = Object.entries(cleaned.info)
    .slice(0, 12)
    .map(([key, value]) => `${key}：${value}`)
  const body = cleaned.containerFound ? cleaned.text : genericClean(html)
  if (!body) return undefined
  const text = trimToRelevant([infoLines.join('\n'), body].filter(Boolean).join('\n'), name)
  if (text.length < 60) return undefined
  const title = (cleaned.title || pageTitle(html) || name).split('_')[0].trim()
  return { title: title || name, url, text }
}

/** 直接抓一个 360 百科词条页（doc/search 被验证码挡住时，用搜索结果里的词条地址兜底）。 */
async function fetchBaikeDoc(url, name, options = {}) {
  if (!/baike\.so\.com\/doc\/\d+/.test(String(url))) return undefined
  const page = await httpGet(url, options)
  if (page.status !== 200 || is360Captcha(page.text)) return undefined
  return baikeItemFrom(page.text, page.url || url, name)
}

/**
 * 360 百科：doc/search?word= 会跳到词条页（同源 302，可以自动跟）；
 * 搜索入口偶尔弹验证码，就返回失败，让调用方用搜索结果里的词条地址兜底。
 * @returns {Promise<{title: string, url: string, text: string}|undefined>}
 */
export async function lookupBaike360(name, options = {}) {
  const searchUrl = `https://baike.so.com/doc/search?word=${encodeURIComponent(name)}`
  const page = await httpGet(searchUrl, options)
  if (page.status !== 200) return undefined
  if (is360Captcha(page.text)) throw new Error('360 百科触发验证码（IP 限流），先跳过')
  let finalUrl = page.url
  if (!/\/doc\/\d+[-]?\d*\.html/.test(new URL(finalUrl).pathname)) {
    const hit = /href="(\/doc\/[^"]+\.html)"/i.exec(page.text)
    if (!hit) return undefined
    finalUrl = new URL(hit[1], 'https://baike.so.com/').href
  }
  return fetchBaikeDoc(finalUrl, name, options)
}

/** 抓一个搜索结果页并抽正文。 */
async function fetchPage(url, name, options = {}) {
  if (is360Link(url)) return undefined
  const safe = usableUrl(url)
  if (!safe) return undefined
  const page = await httpGet(safe, options)
  if (page.status !== 200) return undefined
  if (is360Captcha(page.text)) return undefined
  const text = trimToRelevant(extractReadable(page.text), name)
  if (text.length < 60) return undefined
  const title = (pageTitle(page.text) || safe).trim().slice(0, 80)
  return { title, url: page.url || safe, text }
}

/** 拼语料：每条来源一段，带标题和地址，总长封顶。 */
export function buildCorpus(sections) {
  const parts = []
  let total = 0
  for (const section of sections) {
    if (!section || !section.text) continue
    const body = section.text.slice(0, PAGE_CHARS)
    const head = `### ${section.label}｜${section.title || ''}\n${section.url || ''}\n`
    const piece = `${head}${body}\n`
    if (total + piece.length > MAX_CORPUS_CHARS) break
    parts.push(piece)
    total += piece.length
  }
  return parts.join('\n')
}

/** 系统提示：让模型只输出一个 JSON 对象。 */
export const DISTILL_SYSTEM_PROMPT = [
  '你是资深的角色设定分析师，专门从资料里提炼「一个人物是谁、怎么说话」。',
  '你会收到一份从互联网抓来的资料（可能夹着网页导航、防复制乱码、无关内容）。',
  '请只输出一个 JSON 对象，不要 markdown 代码块，不要解释，不要前后缀。',
  'JSON 字段：',
  '{',
  '  "name": "角色名（用用户给的名字）",',
  '  "title": "出处 / 身份，一句话，比如《名侦探柯南》中的角色、中国内地女演员",',
  '  "summary": "一两句话介绍这个人",',
  '  "personality": "性格，120-220 字，具体到行为习惯，不要空话",',
  '  "speechStyle": "说话方式，180-300 字：句子长短、语气、用词偏好、标点习惯、口癖、称呼人的方式、什么时候会变软/变凶",',
  '  "catchphrases": ["口头禅或标志性台词，3-8 条，原文优先"],',
  '  "address": "自称和怎么称呼对方/别人",',
  '  "examples": ["能体现语气的例句 3-6 条，可以改编，但要像这个人会说的话"],',
  '  "taboos": ["这个人不会说 / 不会做的事，2-5 条"],',
  '  "prompt": "一段可以直接塞给聊天模型用的角色扮演提示词，中文，250-450 字，包含：你是谁、性格、说话方式、口癖、称呼、底线；用第二人称「你」；不要写「你是AI」「扮演」这类词"',
  '}',
  '规则：资料不足就用你自己的知识补，但不要编造和资料冲突的硬事实；宁可写少一点也不要瞎编。',
  '资料里的网页导航、广告、乱码直接忽略。',
].join('\n')

/** 拼给模型看的用户消息。 */
export function buildDistillUserPrompt({ name, extra, corpus, degraded }) {
  const lines = [`角色名：${name}`]
  if (extra && String(extra).trim()) lines.push(`用户的补充要求：${String(extra).trim()}`)
  if (degraded) lines.push('注意：网上能抓到的资料很少，主要靠你自己的知识，但 speechStyle 要写得具体。')
  lines.push('', '资料开始：', corpus || '（没有抓到资料）', '', '资料结束。现在输出 JSON。')
  return lines.join('\n')
}

/** 生成一条 user 消息（形状跟宿主 createUserMessage 一致即可）。 */
export function makeUserMessage(text) {
  return {
    id: `persona-learn-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }
}

/** 当前默认模型；插件配置里写了就用配置。 */
export function pickModel(ctx, config) {
  if (config && config.provider && config.model) return { provider: config.provider, model: config.model }
  try {
    const selection = ctx.get('agentDefaultModel')?.currentSelection?.()
    if (selection && selection.provider && selection.model) {
      return { provider: selection.provider, model: selection.model }
    }
  } catch {
    /* 拿不到就当没有 */
  }
  return undefined
}

/** 模型是否支持把 reasoning 关掉（支持就关，省时间）。 */
async function supportsReasoningOff(ctx, provider, model) {
  try {
    const info = await ctx.get('llm')?.resolveModelInfo?.(provider, model)
    return info?.reasoning?.efforts?.some((effort) => effort.id === 'off') ?? false
  } catch {
    return false
  }
}

/**
 * 调宿主 LLM 提炼人设。只取文本增量；finish 是 error/aborted 就抛错。
 */
export async function distillWithLlm(ctx, { name, extra, corpus, degraded, config, signal, log }) {
  const llm = ctx.get('llm')
  if (!llm || typeof llm.stream !== 'function') throw new Error('LLM 服务不可用，没法提炼人设')
  const target = pickModel(ctx, config)
  if (!target) throw new Error('当前没有配置模型（先在 DSH 里选一个模型），没法提炼人设')
  if (log) log('llm', `用 ${target.provider}/${target.model} 提炼人设…`)

  const off = await supportsReasoningOff(ctx, target.provider, target.model)
  const timeout = AbortSignal.timeout(240000)
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout
  const options = {
    provider: target.provider,
    model: target.model,
    sessionId: 'dsh-persona-learn',
    system: DISTILL_SYSTEM_PROMPT,
    messages: [makeUserMessage(buildDistillUserPrompt({ name, extra, corpus, degraded }))],
    maxTokens: 6000,
    ...(off ? { reasoningEffort: 'off' } : {}),
    signal: combined,
  }

  const parts = []
  let finish
  for await (const chunk of llm.stream(options)) {
    if (!chunk || typeof chunk !== 'object') continue
    if (chunk.type === 'text-delta') {
      parts.push(String(chunk.text ?? ''))
    } else if (chunk.type === 'finish') {
      finish = chunk.reason
    } else if (chunk.type === 'error') {
      throw new Error(`模型调用失败：${String(chunk.message ?? chunk.error ?? '未知错误')}`)
    }
  }
  if (finish && finish.kind === 'error') {
    const message = finish.failure?.message || finish.failure?.code || '模型调用失败'
    throw new Error(`模型调用失败：${String(message)}`)
  }
  if (finish && finish.kind === 'aborted') throw new Error('模型调用被取消或超时')
  const text = parts.join('').trim()
  if (!text) throw new Error('模型没返回内容')
  return { text, model: `${target.provider}/${target.model}` }
}

/**
 * 从模型输出里抠 JSON 并整理成角色对象。
 * @returns {object} character
 */
export function parseCharacterJson(text, fallbackName) {
  const raw = String(text).trim()
  const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim()
  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  if (start === -1 || end === -1 || end <= start) throw new Error('模型返回的不是 JSON')
  let parsed
  try {
    parsed = JSON.parse(cleaned.slice(start, end + 1))
  } catch (error) {
    throw new Error(`模型返回的 JSON 解析失败：${String(error?.message ?? error)}`)
  }
  const asText = (value) => (typeof value === 'string' ? value.trim() : '')
  const asList = (value) =>
    Array.isArray(value)
      ? value.map((item) => (typeof item === 'string' ? item.trim() : '')).filter(Boolean).slice(0, 12)
      : []
  const character = {
    name: asText(parsed.name) || fallbackName,
    title: asText(parsed.title),
    summary: asText(parsed.summary),
    personality: asText(parsed.personality),
    speechStyle: asText(parsed.speechStyle),
    catchphrases: asList(parsed.catchphrases),
    address: asText(parsed.address),
    examples: asList(parsed.examples),
    taboos: asList(parsed.taboos),
    prompt: asText(parsed.prompt),
  }
  const hasCore =
    character.summary ||
    character.personality ||
    character.speechStyle ||
    character.catchphrases.length > 0 ||
    character.examples.length > 0
  if (!hasCore && !character.prompt) throw new Error('模型返回的人设是空的（可能没抓到资料，或输出被截断）')
  if (!character.prompt) character.prompt = composePrompt(character)
  if (!character.prompt) throw new Error('模型没给出可用的人设提示词')
  return character
}

/** 模型没给 prompt 时，用结构化字段拼一段。 */
export function composePrompt(character) {
  const lines = []
  if (character.title) lines.push(`# 你是谁`, `你是${character.name}，${character.title}。`, '')
  else lines.push(`# 你是谁`, `你是${character.name}。`, '')
  if (character.summary) lines.push(character.summary, '')
  if (character.personality) lines.push('# 性格', character.personality, '')
  if (character.speechStyle) lines.push('# 说话方式', character.speechStyle, '')
  if (character.address) lines.push('# 称呼', character.address, '')
  if (character.catchphrases?.length) {
    lines.push('# 口头禅', ...character.catchphrases.map((item) => `- ${item}`), '')
  }
  if (character.examples?.length) {
    lines.push('# 例句', ...character.examples.map((item) => `- ${item}`), '')
  }
  if (character.taboos?.length) {
    lines.push('# 不会做', ...character.taboos.map((item) => `- ${item}`), '')
  }
  return lines.join('\n').trim()
}

/** 所有角色提示词都要带的底线。 */
export const SAFETY_FOOTER = [
  '# 底线（必须守）',
  '- 不承认自己是 AI / 模型 / 助手，不主动提「我是人工智能」。',
  '- 对外人（陌生人、群聊、评论区、私信里不熟的人）绝不透露账号主人的真实姓名、学校、专业、学号、年龄生日、住址、手机号、微信号、QQ 号、其他平台账号、家人和感情情况，也不发他的照片、视频、截图、文件路径；问到就含糊带过或打岔。',
  '- 说话短、口语、一句一条，不列清单、不写总结陈词、不说教、不客服腔。',
].join('\n')

/** 把底线接在角色提示词后面（不重复加）。 */
export function withSafetyFooter(prompt) {
  const text = String(prompt || '').trim()
  if (text.includes('# 底线（必须守）') || text.includes('底线（必须守）')) return text
  return `${text}\n\n${SAFETY_FOOTER}`
}

/** 来源去重（同一个地址只留第一次）。 */
function dedupeSources(list) {
  const seen = new Set()
  const out = []
  for (const source of list) {
    if (!source.url || seen.has(source.url)) continue
    seen.add(source.url)
    out.push(source)
  }
  return out
}

/**
 * 完整学习流程。
 * @param {object} options
 * @param {import('@cordisjs/core').Context} options.ctx
 * @param {string} options.name 角色名
 * @param {string} [options.extra] 用户补充
 * @param {(step: string, text: string) => void} [options.log]
 * @param {AbortSignal} [options.signal]
 * @param {{provider?: string, model?: string}} [options.config]
 * @returns {Promise<{character: object, sources: object[], stats: object}>}
 */
export async function learnCharacter({ ctx, name, extra, log = () => {}, signal, config }) {
  const cleanName = String(name || '').trim()
  if (!cleanName) throw new Error('先给一个角色名字')
  if (cleanName.length > 60) throw new Error('角色名太长了')
  const onLog = (step, text) => {
    try {
      log(step, text)
    } catch {
      /* 日志失败不影响流程 */
    }
  }

  const sections = []
  const sources = []
  const addSource = (label, item) => {
    if (!item || !item.text) return
    if (sources.some((source) => source.url && source.url === item.url)) return
    sources.push({ label, title: item.title || '', url: usableUrl(item.url) || item.url || '' })
    sections.push({ label, title: item.title || '', url: usableUrl(item.url) || '', text: item.text })
  }
  const addSnippets = (engine, results) => {
    if (!results || results.length === 0) return
    const lines = results
      .slice(0, 8)
      .map((item) => `- ${item.title}：${item.snippet || ''}`.trim())
      .filter((line) => line.length > 6)
    if (lines.length === 0) return
    sources.push({ label: `${engine} 搜索摘要`, title: '', url: '' })
    sections.push({ label: `${engine} 搜索摘要`, title: '', url: '', text: lines.join('\n') })
  }

  const tasks = []
  onLog('search', '搜索资料：萌娘百科 / 360 百科 / 360 搜索 / Bing…')
  const netOptions = { signal, log: (text) => onLog('net', String(text)) }

  // 萌娘百科（ACG 角色首选）
  tasks.push(
    lookupMoegirl(cleanName, netOptions)
      .then((item) => {
        if (item) {
          addSource('萌娘百科', item)
          onLog('search', `萌娘百科命中：${item.title}`)
        }
      })
      .catch((error) => onLog('warn', `萌娘百科没抓到：${String(error?.message ?? error)}`)),
  )
  // 360 百科（真人 / 历史人物 / 通用）
  tasks.push(
    lookupBaike360(cleanName, netOptions)
      .then((item) => {
        if (item) {
          addSource('360百科', item)
          onLog('search', `360 百科命中：${item.title}`)
        }
      })
      .catch((error) => onLog('warn', `360 百科没抓到：${String(error?.message ?? error)}`)),
  )
  // 360 搜索（多词查询可靠）
  tasks.push(
    search360(`${cleanName} 人设 性格`, netOptions)
      .then((results) => {
        addSnippets('360', results)
        return results
      })
      .catch((error) => {
        onLog('warn', `360 搜索没结果：${String(error?.message ?? error)}`)
        return []
      }),
  )
  // Bing（名字单词查询可靠）
  tasks.push(
    searchBing(cleanName, netOptions)
      .then((results) => {
        addSnippets('Bing', results)
        return results
      })
      .catch((error) => {
        onLog('warn', `Bing 没结果：${String(error?.message ?? error)}`)
        return []
      }),
  )

  const settled = await Promise.allSettled(tasks)
  if (signal?.aborted) throw new Error('已取消')
  const allResults = settled
    .filter((item) => item.status === 'fulfilled' && Array.isArray(item.value))
    .flatMap((item) => item.value)

  // 360 百科的搜索入口偶尔弹验证码：拿搜索结果里的词条地址直接抓一次
  if (!sources.some((source) => source.label === '360百科')) {
    const docHit = allResults.find((item) => /baike\.so\.com\/doc\/\d+/.test(String(item.url)))
    if (docHit) {
      const item = await fetchBaikeDoc(docHit.url, cleanName, netOptions)
      if (item) {
        addSource('360百科', item)
        onLog('search', `360 百科（搜索结果兜底）命中：${item.title}`)
      }
    }
  }

  // 抓搜索里的页面（最多 3 个，挑看起来像人物页的）
  const candidates = []
  for (const result of allResults) {
    const url = usableUrl(result.url)
    if (!url) continue
    if (sources.some((source) => source.url === url)) continue
    if (candidates.some((item) => item.url === url)) continue
    if (!result.title || result.title.length < 2) continue
    candidates.push({ ...result, url })
    if (candidates.length >= 6) break
  }
  if (candidates.length > 0) {
    onLog('fetch', `抓取 ${Math.min(candidates.length, MAX_FETCHED_PAGES)} 个相关页面…`)
    const pages = await Promise.allSettled(
      candidates.slice(0, MAX_FETCHED_PAGES).map((item) => fetchPage(item.url, cleanName, netOptions)),
    )
    for (const page of pages) {
      if (page.status !== 'fulfilled' || !page.value) continue
      addSource('网页', page.value)
      onLog('fetch', `抓到：${page.value.title || page.value.url}`)
    }
  }

  const corpus = buildCorpus(sections)
  const stats = {
    sourcesCount: sources.length,
    corpusChars: corpus.length,
    fetchedPages: sources.filter((source) => source.label === '网页' || source.label === '萌娘百科' || source.label === '360百科').length,
  }
  onLog('corpus', `语料 ${stats.corpusChars} 字，来源 ${stats.sourcesCount} 个`)
  const degraded = stats.corpusChars < 400
  if (degraded) onLog('warn', '网上资料很少，主要靠模型自己的知识，结果可能一般')

  const distilled = await distillWithLlm(ctx, {
    name: cleanName,
    extra,
    corpus,
    degraded,
    config,
    signal,
    log: onLog,
  })
  const parsed = parseCharacterJson(distilled.text, cleanName)
  const now = Date.now()
  const character = {
    ...parsed,
    prompt: withSafetyFooter(parsed.prompt),
    degraded,
    model: distilled.model,
    createdAt: now,
    updatedAt: now,
    sources: dedupeSources(
      sources
        .filter((source) => source.url)
        .map((source) => ({ title: source.title || source.label, url: source.url })),
    ).slice(0, 10),
  }
  onLog('done', `完成：${character.name}（${stats.corpusChars} 字语料）`)
  return { character, sources, stats }
}

/**
 * 通用的一发模型调用：拿纯文本回来。学角色、拆三段式都走它，省得各写一遍流式收尾。
 * 出错一律抛中文可读错误（页面直接显示）。
 */
export async function runLlmText(ctx, {
  system,
  user,
  config,
  signal,
  maxTokens = 4000,
  sessionId = 'dsh-persona',
} = {}) {
  const llm = ctx.get('llm')
  if (!llm || typeof llm.stream !== 'function') throw new Error('LLM 服务不可用')
  const target = pickModel(ctx, config)
  if (!target) throw new Error('当前没有配置模型（先在 DSH 里选一个模型）')
  const off = await supportsReasoningOff(ctx, target.provider, target.model)
  const timeout = AbortSignal.timeout(120000)
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout
  const parts = []
  let finish
  for await (const chunk of llm.stream({
    provider: target.provider,
    model: target.model,
    sessionId,
    system,
    messages: [makeUserMessage(String(user ?? ''))],
    maxTokens,
    ...(off ? { reasoningEffort: 'off' } : {}),
    signal: combined,
  })) {
    if (!chunk || typeof chunk !== 'object') continue
    if (chunk.type === 'text-delta') parts.push(String(chunk.text ?? ''))
    else if (chunk.type === 'finish') finish = chunk.reason
    else if (chunk.type === 'error') throw new Error(`模型调用失败：${String(chunk.message ?? chunk.error ?? '未知错误')}`)
  }
  if (finish && finish.kind === 'error') {
    const message = finish.failure?.message || finish.failure?.code || '模型调用失败'
    throw new Error(`模型调用失败：${String(message)}`)
  }
  if (finish && finish.kind === 'aborted') throw new Error('模型调用超时或被取消')
  const text = parts.join('').trim()
  if (!text) throw new Error('模型没返回内容')
  return { text, model: `${target.provider}/${target.model}` }
}

/** 给测试用：把整条流水线的内部函数集中导出。 */
export const __internals = {
  UA,
  usableUrl,
  stripTags,
  decodeEntities,
  extractReadable,
  trimToRelevant,
  parseSearch360,
  parseSearchBing,
  buildCorpus,
  parseCharacterJson,
  composePrompt,
  withSafetyFooter,
}
