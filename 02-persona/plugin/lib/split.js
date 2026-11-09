/**
 * dsh-persona —— 把「一整段老格式人格」拆成三段式
 *
 * 页面上的「拆成三段」按钮走这里：拿现有人格正文 → 当前默认模型 → 三段 + 备用风格。
 * 只做一件事：拆。不编造原文没有的身份信息，原文里的底线/禁忌要跟着走。
 * 结果不自动落盘，页面拿到后填进编辑区，等用户看过、改过、点保存才写文件。
 */
import { runLlmText } from './learn.js'
import { normalizeModeValue, MODE_PARTS } from './mode.js'

const SPLIT_SYSTEM_PROMPT = [
  '你负责把一段现成的人格提示词拆成三块，只输出一个 JSON 对象，不要输出解释、不要用代码块。',
  'JSON 结构固定为（字段名必须完全一致）：',
  '{"identity":"","behavior":"","replyStyle":"","variants":[],"variantChance":0}',
  '字段含义：',
  '- identity：这个人是谁、什么身份、什么性格。',
  '- behavior：什么时候开口、什么时候闭嘴，怎么参与聊天（不硬找话题、不刷屏之类）。',
  '- replyStyle：说话方式——长短、语气、口头禅、称呼、格式禁忌。',
  '- variants：0~3 条「一句话的备用说话风格」，原文没提到就返回空数组。',
  '- variantChance：0~1，原文没提到就填 0。',
  '下面是一个填好的例子（输入是「你叫小明，说话很短，爱怼人」）：',
  '{"identity":"你叫小明","behavior":"","replyStyle":"说话很短，爱怼人","variants":[],"variantChance":0}',
  '硬性要求：',
  '1. 只用原文里已有的信息，不许编造新的身份、经历、关系。',
  '2. 原文里的底线、禁忌、不许做的事，必须留在对应的段落里，不能丢。',
  '3. 原文某方面确实没写，就返回空字符串，不要硬凑。',
  '4. 但 identity 和 replyStyle 不能同时为空：原文只要写了「你是谁」或「怎么说」，对应那段就必须填上。',
  '5. 上面的结构只是格式示例，绝对不许把空字符串原样交回来。',
  '6. 全部用中文。',
].join('\n')

/** 拼给模型看的用户消息。 */
export function buildSplitUserPrompt({ text, name }) {
  return [
    name ? `人格名：${name}` : '人格名：未命名',
    '下面是要拆的人格原文（老格式，一整段）：',
    '<<<',
    String(text ?? ''),
    '>>>',
    '按系统提示的要求，只输出那个 JSON 对象。',
  ].join('\n')
}

/** 从模型输出里抠 JSON（容错：带代码块、带前后废话也能救）。 */
export function parseSplitJson(raw) {
  const cleaned = String(raw ?? '')
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim()
  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  if (start === -1 || end === -1 || end <= start) throw new Error('模型返回的不是 JSON，拆不了')
  let parsed
  try {
    parsed = JSON.parse(cleaned.slice(start, end + 1))
  } catch (error) {
    throw new Error(`模型返回的 JSON 解析失败：${String(error?.message ?? error)}`)
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('模型返回的不是对象，拆不了')
  const mode = normalizeModeValue({
    identity: parsed.identity,
    behavior: parsed.behavior,
    replyStyle: parsed.replyStyle,
    variants: parsed.variants,
    variantChance: parsed.variantChance,
  })
  // 拆完三段全空 = 模型没干活，直接报错，别把用户原来的字覆盖成空气
  const filled = MODE_PARTS.some((part) => mode[part.key])
  if (!filled) throw new Error('模型没拆出内容，原来的文字保持不变')
  return mode
}

/**
 * 调模型拆一段人格正文。
 * 模型偶尔会把模板里的空字符串原样交回来，所以空结果会带着更硬的提醒再试一次。
 * @returns {Promise<{mode: object, model: string}>}
 */
export async function splitModeWithLlm(ctx, { text, name, config, signal } = {}) {
  const source = String(text ?? '').trim()
  if (source.length < 20) throw new Error('这段太短了，没什么可拆的（至少 20 个字）')
  if (source.length > 30000) throw new Error('这段太长了（超过 3 万字），先手动删一删再拆')

  let lastError
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const hint = attempt === 0
      ? ''
      : '\n注意：上一版把字段全填成了空字符串，那是错的。这次必须从原文里摘内容填进去，identity 和 replyStyle 至少填一个。'
    try {
      const { text: output, model } = await runLlmText(ctx, {
        system: SPLIT_SYSTEM_PROMPT,
        user: buildSplitUserPrompt({ text: source, name }) + hint,
        config,
        signal,
        maxTokens: 3000,
        sessionId: 'dsh-persona-split',
      })
      return { mode: parseSplitJson(output), model: attempt === 0 ? model : `${model}（重试）` }
    } catch (error) {
      lastError = error
      // 只有「拆出来是空的」值得重试；没有模型、超时、JSON 坏了都不重试
      if (!/没拆出内容/.test(String(error?.message ?? ''))) throw error
    }
  }
  throw lastError
}
