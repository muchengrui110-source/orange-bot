/**
 * dsh-persona —— 人格模式的值
 *
 * 一个模式有两种写法（同一个 modes 里可以混用）：
 *   1. 老格式：一整段字符串，原样注入；
 *   2. 新格式：三段式对象 { title?, identity, behavior, replyStyle, variants[], variantChance }
 *
 * 拼正文的格式必须和 QQ 桥接（dsh-qq-bridge/lib/index.js 的 composeModeBody）一字不差，
 * 否则设置页预览和真实注入会对不上。改动时两边一起改：
 *   你是谁：
 *   <identity>
 *
 *   什么时候开口：
 *   <behavior>
 *
 *   说话方式：
 *   <replyStyle>
 *
 * 空的段落整段跳过，不输出标签；三段全空 → 空字符串。字符串 → trim 后原样返回。
 */

/** 三段式的三个字段：顺序固定，标签固定。 */
export const MODE_PARTS = [
  {
    key: 'identity',
    title: '是谁',
    label: '你是谁：',
    hint: '这个人是谁、什么身份、什么性格。写 1~3 句就够，太长会稀释效果。',
  },
  {
    key: 'behavior',
    title: '什么时候开口',
    label: '什么时候开口：',
    hint: '什么时候插话、什么时候安静：不硬找话题、不刷屏、对方忙就少说。',
  },
  {
    key: 'replyStyle',
    title: '怎么说话',
    label: '说话方式：',
    hint: '长短、语气、口头禅、称呼、用不用表情、不列清单不总结这类硬规矩。',
  },
]

/** 各字段上限（保存时统一截断，防止手滑粘一大坨）。 */
export const MODE_LIMITS = {
  identity: 4000,
  behavior: 3000,
  replyStyle: 4000,
  title: 60,
  variant: 200,
  variants: 8,
}

/** 对象形式 = 三段式；数组和 null 都不算。 */
export function isStructuredMode(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

/** 收一段文本：非字符串当空，trim，超长截断。 */
function asText(value, limit) {
  if (typeof value !== 'string') return ''
  const text = value.trim()
  return limit && text.length > limit ? text.slice(0, limit) : text
}

/** 备用风格：字符串数组，去空、去重、限条数和单条长度。 */
function asVariantList(value) {
  if (!Array.isArray(value)) return []
  const out = []
  const seen = new Set()
  for (const item of value) {
    const text = asText(item, MODE_LIMITS.variant)
    if (!text || seen.has(text)) continue
    seen.add(text)
    out.push(text)
    if (out.length >= MODE_LIMITS.variants) break
  }
  return out
}

/** 换风格概率：0~1，非法值当 0，保留 3 位小数。 */
function asChance(value) {
  const number = Number(value)
  if (!Number.isFinite(number) || number <= 0) return 0
  if (number >= 1) return 1
  return Math.round(number * 1000) / 1000
}

/**
 * 把模式值整理成合法结构（保存时调用）。
 * 对象 → 保留不认识的自定义字段，已知字段统一收口；字符串 → 原样返回（老行为不变）。
 */
export function normalizeModeValue(value) {
  if (isStructuredMode(value)) {
    const out = { ...value }
    for (const part of MODE_PARTS) out[part.key] = asText(value[part.key], MODE_LIMITS[part.key])
    out.variants = asVariantList(value.variants)
    out.variantChance = asChance(value.variantChance)
    const title = asText(value.title, MODE_LIMITS.title)
    if (title) out.title = title
    else delete out.title
    return out
  }
  return typeof value === 'string' ? value : String(value ?? '')
}

/**
 * 拼成最终注入的那段正文（三段式带小标题，老格式就是原文 trim）。
 * QQ 桥接里有同名同逻辑的函数，改这里记得同步那边。
 */
export function composeModeBody(value) {
  if (!isStructuredMode(value)) {
    return typeof value === 'string' ? value.trim() : ''
  }
  const blocks = []
  for (const part of MODE_PARTS) {
    const text = typeof value[part.key] === 'string' ? value[part.key].trim() : ''
    if (!text) continue
    blocks.push(`${part.label}\n${text}`)
  }
  return blocks.join('\n\n').trim()
}

/** 一个模式能占多少字（列表里显示、判断空不空都用它）。 */
export function modeCharCount(value) {
  return composeModeBody(value).length
}

/** 三段各自多少字：['谁12','开口0','说30'] 这种，给页面列表用。 */
export function modePartCounts(value) {
  if (!isStructuredMode(value)) return null
  return MODE_PARTS.map((part) => {
    const text = typeof value[part.key] === 'string' ? value[part.key].trim() : ''
    return { key: part.key, title: part.title, chars: text.length }
  })
}
