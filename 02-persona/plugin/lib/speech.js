/**
 * dsh-persona · 说话习惯学习（只统计长度和标点，不存原话）
 *
 * 在 DSH 里聊天时，宿主监听 `session/event` 里的 `user/message`，
 * 把「用户自己发的话」拿来做统计：
 *   - 每条多少字、几行；
 *   - 句号 / 逗号 / 感叹号 / 问号 / 省略号 / 空格断句的使用频率；
 *   - 结尾带不带标点。
 * 统计结果攒在内存里、定期写到 personaFile 旁边的 speech-habits.json；
 * 再从统计里生成一段「回复时照着这个节奏」的提示词，用户可以在页面上
 * 一键追加到某个会话模式。
 *
 * 隐私：落盘只有数字，没有原话。
 */

/** 内存里最多留多少条样本（老的丢掉，统计按最近这些算）。 */
export const MAX_SAMPLES = 300
/** 少于这么多条就先不生成提示词（样本太少，结论容易离谱）。 */
export const MIN_SAMPLES_FOR_PROMPT = 8

/** 标点统计项。空格单独算「空格断句」。 */
export const PUNCT_MARKS = ['。', '，', '！', '？', '……', '、', '～', '~']

/** 空状态。 */
export function emptySpeechState() {
  return {
    version: 1,
    samples: 0,
    updatedAt: 0,
    lengths: [],
    lines: [],
    counts: {},
    ends: 0,
    spaces: 0,
    prompt: '',
    stats: null,
  }
}

/** 从一条消息里抽出统计需要的数字。 */
export function sampleText(text) {
  const raw = String(text ?? '')
  const trimmed = raw.trim()
  if (!trimmed) return undefined
  const normalized = trimmed.replace(/\r/g, '')
  const lines = normalized.split('\n').map((line) => line.trim()).filter(Boolean).length || 1
  const counts = {}
  for (const mark of PUNCT_MARKS) {
    const hits = normalized.split(mark).length - 1
    if (hits > 0) counts[mark] = hits
  }
  const spaces = normalized.split(' ').length - 1
  const endsWithPunct = /[。！？…～~!?.,，]$/.test(trimmed)
  return { chars: [...trimmed].length, lines, counts, spaces, endsWithPunct }
}

/** 是不是桥上/系统塞进来的提示词，不是人打的字。 */
export function looksLikeHumanMessage(text) {
  const raw = String(text ?? '').trim()
  if (!raw) return false
  if (raw.length > 500) return false
  if (/^\/[a-z]/i.test(raw)) return false
  if (/\[QQ ?(私信|私聊|群聊)\]|\[抖音私信\]|【隐私红线|用账号主人的口吻|最近对话（旧到新）/.test(raw)) return false
  // 大段带标题的提示词（桥接拼出来的）也跳过
  if (/^#{1,3} /m.test(raw)) return false
  return true
}

/** 追加一条样本（返回新状态，不原地改）。 */
export function addSample(state, text) {
  const sample = sampleText(text)
  if (!sample) return state
  const lengths = [...(state.lengths ?? []), sample.chars].slice(-MAX_SAMPLES)
  const lines = [...(state.lines ?? []), sample.lines].slice(-MAX_SAMPLES)
  const counts = { ...(state.counts ?? {}) }
  for (const [mark, hits] of Object.entries(sample.counts)) counts[mark] = (counts[mark] ?? 0) + hits
  const next = {
    ...state,
    version: 1,
    samples: (state.samples ?? 0) + 1,
    lengths,
    lines,
    counts,
    ends: (state.ends ?? 0) + (sample.endsWithPunct ? 1 : 0),
    spaces: (state.spaces ?? 0) + sample.spaces,
    updatedAt: Date.now(),
  }
  next.stats = computeStats(next)
  next.prompt = buildPrompt(next.stats)
  return next
}

/** 平均值（空数组返回 0）。 */
function mean(values) {
  if (!values || values.length === 0) return 0
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

/** 中位数。 */
function median(values) {
  if (!values || values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
}

/** 按最近样本算统计（rate 都是 0~1）。 */
export function computeStats(state) {
  const lengths = state.lengths ?? []
  const lines = state.lines ?? []
  const n = lengths.length
  if (n === 0) return null
  const counts = state.counts ?? {}
  const rates = {}
  for (const mark of PUNCT_MARKS) rates[mark] = (counts[mark] ?? 0) / n
  const avgChars = mean(lengths)
  const medianChars = median(lengths)
  const avgLines = mean(lines)
  const oneLineRate = lines.filter((value) => value === 1).length / n
  const endPunctRate = (state.ends ?? 0) / Math.max(1, state.samples ?? n)
  const spaceRate = (state.spaces ?? 0) / Math.max(1, state.samples ?? n)
  const buckets = {
    short: lengths.filter((value) => value <= 8).length / n,
    medium: lengths.filter((value) => value > 8 && value <= 20).length / n,
    long: lengths.filter((value) => value > 20).length / n,
  }
  return {
    samples: n,
    total: state.samples ?? n,
    avgChars: Number(avgChars.toFixed(1)),
    medianChars: Number(medianChars.toFixed(1)),
    avgLines: Number(avgLines.toFixed(2)),
    oneLineRate: Number(oneLineRate.toFixed(2)),
    endPunctRate: Number(endPunctRate.toFixed(2)),
    spaceRate: Number(spaceRate.toFixed(2)),
    rates: Object.fromEntries(Object.entries(rates).map(([key, value]) => [key, Number(value.toFixed(2))])),
    buckets: Object.fromEntries(Object.entries(buckets).map(([key, value]) => [key, Number(value.toFixed(2))])),
    updatedAt: state.updatedAt ?? 0,
  }
}

/** 百分比文字（0.18 → 18%）。 */
function pct(value) {
  return `${Math.round((value ?? 0) * 100)}%`
}

/**
 * 从统计生成一段提示词；样本不够就返回空串。
 * 语气保持短句、口语、一句一条。
 */
export function buildPrompt(stats) {
  if (!stats || stats.samples < MIN_SAMPLES_FOR_PROMPT) return ''
  const lines = ['# 对方的打字习惯（参考）']
  const avg = stats.avgChars
  const medianText = stats.medianChars !== Math.round(stats.medianChars) ? stats.medianChars : Math.round(stats.medianChars)
  lines.push(`- 平均每条 ${avg} 字（中位数 ${medianText} 字），${pct(stats.oneLineRate)} 的消息只有一行。`)
  // 断句方式
  const breakers = []
  if (stats.spaceRate >= 0.25) breakers.push('空格')
  if ((stats.rates['，'] ?? 0) >= 0.25) breakers.push('逗号')
  if ((stats.rates['……'] ?? 0) >= 0.15) breakers.push('省略号')
  if ((stats.rates['、'] ?? 0) >= 0.1) breakers.push('顿号')
  if (breakers.length > 0) lines.push(`- 常用「${breakers.join('」「')}」断句。`)
  // 句号
  const period = stats.rates['。'] ?? 0
  if (period <= 0.25) lines.push(`- 很少用句号（${pct(period)} 的消息里出现）。`)
  else if (period >= 0.6) lines.push(`- 句号用得比较多（${pct(period)} 的消息里出现）。`)
  // 感叹号/问号
  const excl = stats.rates['！'] ?? 0
  const ques = stats.rates['？'] ?? 0
  if (excl + ques >= 0.35) lines.push(`- 感叹号/问号用得多（${pct(excl)} / ${pct(ques)}）。`)
  else if (excl + ques <= 0.08) lines.push('- 感叹号和问号都很少用。')
  // 收尾
  if (stats.endPunctRate <= 0.4) lines.push(`- ${pct(1 - stats.endPunctRate)} 的消息结尾不带标点。`)
  else if (stats.endPunctRate >= 0.75) lines.push('- 消息结尾基本都带标点。')
  // 节奏结论
  lines.push('- 回复时照这个节奏：短、口语、一句一条；该停就停，别写成大段，也别每句都挂句号。')
  return lines.join('\n')
}

/** 读统计文件；不存在/坏了就返回空状态。 */
export function loadSpeechFile(file, fs) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (!parsed || typeof parsed !== 'object') return emptySpeechState()
    const state = { ...emptySpeechState(), ...parsed }
    state.stats = computeStats(state)
    state.prompt = buildPrompt(state.stats)
    return state
  } catch {
    return emptySpeechState()
  }
}

/** 原子写统计文件（只写数字和提示词，不写原话）。 */
export function saveSpeechFile(file, state, fs, path) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
    const payload = {
      version: 1,
      samples: state.samples ?? 0,
      updatedAt: state.updatedAt ?? 0,
      lengths: state.lengths ?? [],
      lines: state.lines ?? [],
      counts: state.counts ?? {},
      ends: state.ends ?? 0,
      spaces: state.spaces ?? 0,
      prompt: state.prompt ?? '',
      stats: state.stats ?? null,
    }
    fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
    fs.renameSync(tmp, file)
  } catch {
    /* 写不进去不影响聊天 */
  }
}
