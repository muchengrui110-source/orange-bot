/**
 * dsh-persona · 网页解析工具（无依赖）
 *
 * 规则来自实际抓下来的页面（2026-10-29 实测）：
 *   - 萌娘百科：正文在 `div.mw-parser-output`；要剔除信息栏表格、navbox、目录、注音、参考资料等；
 *   - 360 百科：正文在 `div.main_content_text`；防复制噪声 = 随机类名的 span 被页面自身 CSS 隐藏，
 *     所以先从 <style> 里收集「被隐藏的类名」，再按类名删元素，才能得到干净正文；
 *   - Bing / 360 搜索：结果块分别是 `li.b_algo` 和 `li.res-list`。
 */

const ENT = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  mdash: '—',
  ndash: '–',
  hellip: '…',
  middot: '·',
  laquo: '«',
  raquo: '»',
  ldquo: '“',
  rdquo: '”',
  lsquo: '‘',
  rsquo: '’',
  times: '×',
  copy: '©',
  reg: '®',
  deg: '°',
  ensp: ' ',
  emsp: ' ',
}

/** HTML 实体解码。 */
export function decodeEntities(s) {
  return String(s)
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => safeCp(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => safeCp(parseInt(d, 10)))
    .replace(/&([a-z]+);/gi, (m, n) => ENT[n.toLowerCase()] ?? m)
}

function safeCp(n) {
  try {
    return String.fromCodePoint(n)
  } catch {
    return ''
  }
}

/** 去标签 + 去零宽/控制字符。 */
export function stripTags(html) {
  let s = String(html)
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|template)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6]|dd|dt|table|section|blockquote)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
  s = decodeEntities(s)
  return s
    .replace(/\r/g, '')
    .replace(/[\u200b-\u200f\u202a-\u202e\u2060\ufeff]/g, '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
    .replace(/[ \t\u00a0\u3000]+/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim()
}

/** 从 startIdx（指向 `<tag`）起取配平的整个元素；找不到闭合就返回从 startIdx 到末尾。 */
export function balanced(html, startIdx, tag) {
  if (startIdx < 0) return ''
  const re = new RegExp(`<${tag}\\b|</${tag}>`, 'gi')
  re.lastIndex = startIdx
  let depth = 0
  let m
  while ((m = re.exec(html))) {
    if (m[0][1] === '/') {
      depth -= 1
      if (depth === 0) return html.slice(startIdx, m.index + m[0].length)
    } else {
      depth += 1
    }
  }
  return html.slice(startIdx)
}

const VOID = new Set(['img', 'br', 'hr', 'meta', 'link', 'input', 'source', 'area', 'base', 'col', 'embed', 'param', 'track', 'wbr'])

/** 反复删除满足 pred(openTagString) 的元素。 */
export function dropElements(html, tags, pred, max = 1200) {
  const re = new RegExp(`<(${tags.join('|')})\\b[^>]*>`, 'gi')
  let out = html
  let guard = 0
  for (;;) {
    re.lastIndex = 0
    let m
    let hit = -1
    let tag = ''
    while ((m = re.exec(out))) {
      if (pred(m[0])) {
        hit = m.index
        tag = m[1].toLowerCase()
        break
      }
    }
    if (hit < 0) break
    if (VOID.has(tag)) {
      out = out.slice(0, hit) + out.slice(hit + m[0].length)
    } else {
      const block = balanced(out, hit, tag)
      out = out.slice(0, hit) + out.slice(hit + block.length)
    }
    if (++guard > max) break
  }
  return out
}

/** 读一个开始标签里的 class 列表。 */
export function classTokens(openTag) {
  const m = /class\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(openTag)
  const v = m ? m[1] ?? m[2] ?? m[3] ?? '' : ''
  return v.split(/\s+/).filter(Boolean)
}

/** 页面标题。 */
export function pageTitle(html) {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)
  return m ? decodeEntities(m[1]).trim() : ''
}

/** 用于剔噪的通用行清洗（网页正文之外的短行）。 */
const NOISE_LINE = /登录|注册|扫码|下载客户端|打开APP|进入词条|编辑词条|百科专题|任务|悬赏|首页|上一页|下一页|展开全部|收起|相关推荐|热门推荐|猜你喜欢|版权|免责声明|举报|分享到|收藏|搜索词条|意见反馈|网站地图|关于我们|联系我们|招聘|客户端下载/

/** 按行清洗：去空行、去导航、去过短行。 */
export function cleanText(text) {
  const lines = String(text)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => {
      if (!line) return false
      if (line.length < 8) return false
      if (line.length < 32 && NOISE_LINE.test(line)) return false
      if (/^[\d\s.·•\-—+*/\\|()（）[\]【】]+$/.test(line)) return false
      return true
    })
  return lines.join('\n').trim()
}

/* ── 萌娘百科 ─────────────────────────────────────────────────────────── */

const MOE_DROP_DIV =
  /class\s*=\s*["']?[^"'>]*\b(navbox|moe-infobox|toc|toctitle|mw-editsection|ambox|mbox|mw-references-wrap|navbox-styles|template-documentation|ztdh|ztdhmenu|menu-content|menu-popout|menu-item|menu-title|noprint|reflist|sidebar|infobox|succession-box|printfooter|catlinks|mw-indicators|mw-jump-link|heimu-?\w*)\b/

/**
 * 萌娘百科正文。
 * @returns {{containerFound:boolean,text:string,title:string,isDisambig:boolean,candidates:{title:string,href:string}[]}}
 */
export function moegirlClean(html) {
  const m = /<div\b[^>]*class\s*=\s*(?:"[^"]*mw-parser-output|'[^']*mw-parser-output|[^\s>]*mw-parser-output)/i.exec(html)
  if (!m) return { containerFound: false, text: '', title: pageTitle(html), isDisambig: false, candidates: [] }
  let box = balanced(html, m.index, 'div')
  let out = box
  out = dropElements(out, ['table'], () => true)
  out = dropElements(out, ['div'], (a) => MOE_DROP_DIV.test(a))
  out = dropElements(out, ['ol', 'ul'], (a) => /class\s*=\s*["']?[^"'>]*\breferences\b/.test(a))
  out = dropElements(out, ['sup'], (a) => /class\s*=\s*["']?[^"'>]*\breference\b/.test(a))
  out = dropElements(out, ['span'], (a) => /class\s*=\s*["']?[^"'>]*\b(cite-bracket|template-ruby-hidden|mw-cite-backlink)\b/.test(a))
  out = dropElements(out, ['style', 'script', 'link', 'meta'], () => true)
  let text = stripTags(out)
  // 尾部章节：注释/参考资料/外部链接之后基本都是链接列表与分类
  text = text.replace(/\n?(注释与外部链接|注释|参考资料|参考文献|外部链接|扩展阅读)[\s\S]*$/, '').trim()
  text = text.replace(/^(宽屏模式显示视频|关闭弹幕|打开弹幕|加载中)\s*$/gm, '').replace(/\n{2,}/g, '\n').trim()
  const isDisambig =
    /^[\s\S]{0,40}?可以指|^[\s\S]{0,40}?可能指/.test(text) ||
    (/消歧义/.test(pageTitle(html)) && text.length < 1500)
  return { containerFound: true, text, title: pageTitle(html), isDisambig, candidates: isDisambig ? moegirlCandidates(box) : [] }
}

/** 消歧义页里的条目链接（优先「(原型)」条目）。 */
export function moegirlCandidates(box) {
  const out = []
  const seen = new Set()
  const re = /<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi
  let m
  while ((m = re.exec(box)) && out.length < 40) {
    let href = m[1]
    if (!/^\/(?!index\.php\?title=Special|wiki\/|Special)/.test(decodeURIComponent(href)) && !/index\.php\?title=/.test(href)) continue
    href = decodeEntities(href)
    const title = stripTags(m[2]).replace(/\s+/g, ' ').trim()
    if (!title || title.length > 40) continue
    const key = decodeURIComponent(href).toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ title, href: href.startsWith('http') ? href : `https://mzh.moegirl.org.cn${href}` })
  }
  out.sort((a, b) => (/原型/.test(b.title) ? 1 : 0) - (/原型/.test(a.title) ? 1 : 0))
  return out
}

/* ── 360 百科 ─────────────────────────────────────────────────────────── */

const BAIKE_INFO_KEYS =
  /^(中文名|外文名|其他名称|别名|配音|饰演|登场作品|性别|生日|年龄|身高|体重|血型|国籍|民族|出生地|出生日期|职业|代表作|主要成就|称号|所属|阵营|武器|声优|CV)$/

/** 从页面 <style> 里收集被隐藏的类名（360 百科的防复制噪声）。 */
export function hiddenClassSet(html) {
  const set = new Set()
  for (const m of String(html).matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)) {
    const css = m[1]
    const ruleRe = /([^{}]+)\{([^{}]*)\}/g
    let r
    while ((r = ruleRe.exec(css))) {
      if (/display\s*:\s*none|visibility\s*:\s*hidden|(?:width|height)\s*:\s*\.?1px/i.test(r[2])) {
        for (const c of r[1].matchAll(/\.([A-Za-z0-9_-]+)/g)) set.add(c[1])
      }
    }
  }
  return set
}

/**
 * 360 百科正文 + 基本信息卡。
 * @returns {{containerFound:boolean,text:string,title:string,info:Record<string,string>}}
 */
export function baike360Clean(html) {
  let start = -1
  const m1 = /<div\b[^>]*class\s*=\s*["']?[^"'>]*main_content_text/i.exec(html)
  if (m1) start = m1.index
  if (start < 0) {
    const m2 = /<div\b[^>]*(?:id\s*=\s*["']?main-content-text|class\s*=\s*["']?[^"'>]*lemma-meaning)/i.exec(html)
    if (m2) start = m2.index
  }
  if (start < 0) {
    const i = String(html).indexOf('main_content_text')
    if (i >= 0) start = String(html).lastIndexOf('<div', i)
  }
  if (start < 0) return { containerFound: false, text: '', title: pageTitle(html), info: {} }

  const info = {}
  const basic = /<div\b[^>]*(?:id\s*=\s*["']?basic-info|class\s*=\s*["']?[^"'>]*entry-basic)[^>]*>/i.exec(html)
  if (basic) {
    const block = balanced(html, basic.index, 'div')
    for (const li of block.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi)) {
      const name = /class\s*=\s*["']?cardlist-name[^>]*>([\s\S]*?)<\//i.exec(li[1])
      const val = /class\s*=\s*["']?cardlist-value[^>]*>([\s\S]*?)<\//i.exec(li[1])
      if (name && val) {
        const k = decodeEntities(stripTags(name[1])).trim()
        const v = decodeEntities(stripTags(val[1])).trim()
        if (k && v && BAIKE_INFO_KEYS.test(k) && Object.keys(info).length < 24) info[k] = v
      }
    }
  }

  const box = balanced(html, start, 'div')
  const hidden = hiddenClassSet(html)
  const isHiddenEl = (tagStr) => {
    const toks = classTokens(tagStr)
    if (toks.some((t) => hidden.has(t))) return true
    const st = /style\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tagStr)
    const sv = st ? st[1] ?? st[2] ?? st[3] ?? '' : ''
    return /display\s*:\s*none|visibility\s*:\s*hidden/i.test(sv)
  }
  const INLINE = ['span', 'em', 'i', 'font', 'b', 'strong', 'small', 'u', 's', 'sub', 'sup', 'a']
  let out = dropElements(box, INLINE, isHiddenEl)
  out = dropElements(out, ['table'], () => true)
  out = dropElements(out, ['div', 'ol', 'ul'], (a) =>
    /class\s*=\s*["']?[^"'>]*\b(sideCatalog|side-catalog|reference|recommend|ad-|advert|rtBox|g-classify|cardlist|basic-info|entry-classify|js-card-content|starVideo|new-album|share|comment|feedback|entry-basic)\b/.test(
      a,
    ),
  )
  out = dropElements(out, ['span'], (a) => /class\s*=\s*["']?[^"'>]*\b(opt|edit|js-edittext)\b/.test(a))
  out = dropElements(out, ['a'], (a) => /class\s*=\s*["']?[^"'>]*\b(conArrow)\b/.test(a))
  out = dropElements(out, ['script', 'style'], () => true)
  const text = stripTags(out)
    .replace(/^(折叠|编辑本段|展开)\s*$/gm, '')
    .replace(/\n{2,}/g, '\n')
    .trim()
  return { containerFound: true, text, title: pageTitle(html), info }
}

/* ── 搜索结果 ─────────────────────────────────────────────────────────── */

/** Bing 结果（li.b_algo）。 */
export function bingParse(html) {
  const results = []
  const re = /<li[^>]*class="[^"]*b_algo[^"]*"[^>]*>/gi
  let m
  while ((m = re.exec(html)) && results.length < 15) {
    const block = balanced(html, m.index, 'li')
    const a = /<h2[^>]*>[\s\S]*?<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(block)
    const cap =
      /<div[^>]*class="[^"]*b_caption[^"]*"[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/i.exec(block) ||
      /<p[^>]*class="[^"]*b_lineclamp[^"]*"[^>]*>([\s\S]*?)<\/p>/i.exec(block) ||
      /<p[^>]*>([\s\S]*?)<\/p>/i.exec(block)
    if (a) results.push({ title: stripTags(a[2]), url: decodeEntities(a[1]), snippet: cap ? stripTags(cap[1]) : '' })
  }
  return results
}

/** 360 搜索结果（li.res-list，含知识卡片）。 */
export function so360Parse(html) {
  const results = []
  const re = /<li[^>]*class="[^"]*res-list[^"]*"[^>]*>/gi
  let m
  while ((m = re.exec(html)) && results.length < 15) {
    const block = balanced(html, m.index, 'li')
    const a = /<h3[^>]*>[\s\S]*?<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(block)
    const sn =
      /<p[^>]*class="[^"]*(res-list-summary|res-desc|res-rich)[^"]*"[^>]*>([\s\S]*?)<\/p>/i.exec(block) ||
      /<p[^>]*>([\s\S]*?)<\/p>/i.exec(block)
    const snippet = sn ? stripTags(sn[2] ?? sn[1]) : ''
    if (a) results.push({ title: stripTags(a[2]), url: decodeEntities(a[1]), snippet })
    else if (/<h1[^>]*class="[^"]*mh-title/.test(block)) {
      const h1 = /<h1[^>]*>[\s\S]*?<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(block)
      if (h1) results.push({ title: stripTags(h1[2]), url: decodeEntities(h1[1]), snippet: '', kind: 'knowledge-card' })
    }
  }
  return results
}

/** 判断是不是 360 的验证码 / 异常页。 */
export function is360Captcha(html) {
  const text = String(html)
  return /qcaptcha\.so\.com|访问异常|安全验证|请输入验证码/.test(text) && text.length < 20000
}

/** 通用正文抽取（搜索结果的普通网页）：去脚本样式 + 按行清洗。 */
export function genericClean(html) {
  return cleanText(stripTags(html))
}
