/**
 * dsh-persona —— 客户端半边：DSH 设置里的「身份与人设」页
 *
 * 1.2.0：新增「从互联网学习角色 + 角色库」（输入角色名 → 后台搜资料/提炼 → 存库 → 套用到会话）。
 * 1.3.0：模式支持三段式（是谁 / 什么时候开口 / 怎么说话）+ 备用风格随机换；
 *        老格式的一整段文字照样能用，页面上可以一键「拆成三段」（调一次模型，拆完要确认才保存）。
 *
 * 数据流：设置页 ⇄ 同源 fetch(`/dsh-persona/api/personas`) ⇄ 宿主半边 ⇄
 *         QQ 桥接的 personas.json
 * 桥接每条消息都会重读那份文件，所以这里点保存 = QQ 下一条消息就用新人设（不用重启）。
 *
 * 一个模式的两种写法（见 lib/mode.js）：
 *   老格式：字符串；
 *   三段式：{ identity, behavior, replyStyle, variants[], variantChance }
 * 拼正文的格式和桥接一字不差：`你是谁：\n…\n\n什么时候开口：\n…\n\n说话方式：\n…`
 *
 * 页面：身份（默认人格） → QQ 会话人格（模式列表 + 编辑器） → 规则 → 保存栏。
 * 改了不点保存不会生效；保存冲突（文件被 agent 改过）会提示先重新读取。
 */
window.__ModuleLoader__.load({
  id: 'dsh-persona',
  factory(require) {
    const React = require('react')
    const { createElement: h, useCallback, useEffect, useState } = React

    const API = '/dsh-persona/api'

    const CSS = [
      '.dsp{max-width:820px;color:var(--dsw-alias-label-primary);display:flex;flex-direction:column;font-size:13px;line-height:20px}',
      '.dsp-title{margin:0;font-size:16px;font-weight:500;line-height:24px}',
      '.dsp-intro{color:var(--dsw-alias-label-secondary);margin:4px 0 2px;font-size:13px}',
      '.dsp-intro code,.dsp-hint code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11.5px;background:color-mix(in srgb,var(--dsw-alias-label-secondary) 14%,transparent);padding:1px 5px;border-radius:4px}',
      '.dsp-meta{display:flex;gap:8px;align-items:center;flex-wrap:wrap;color:var(--dsw-alias-label-secondary);font-size:12px;margin:2px 0 4px}',
      '.dsp-dot{opacity:.5}',
      '.dsp-dirty{color:var(--dsw-alias-state-warn-primary);font-size:12px;margin-left:4px}',
      '.dsp-group{margin-top:18px;font-size:13px;font-weight:600;line-height:20px;padding-bottom:6px;border-bottom:.5px solid var(--dsw-alias-border-l1)}',
      '.dsp-hint{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;margin:4px 0}',
      '.dsp-rows{display:flex;flex-direction:column}',
      '.dsp-row{display:flex;justify-content:space-between;align-items:center;gap:10px 20px;padding:8px 0;border-bottom:.5px solid var(--dsw-alias-border-l1);flex-wrap:wrap}',
      '.dsp-row:last-child{border-bottom:none}',
      '.dsp-label{font-size:13px;display:flex;align-items:center;gap:8px}',
      '.dsp-input,.dsp-select{background:transparent;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;color:var(--dsw-alias-label-primary);font-size:12.5px;height:30px;padding:0 9px;min-width:240px;outline:none;font-family:inherit}',
      '.dsp-input:focus-visible,.dsp-select:focus-visible,.dsp-textarea:focus-visible{border-color:var(--dsw-alias-brand-primary)}',
      '.dsp-select{min-width:180px}',
      '.dsp-textarea{background:transparent;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;color:var(--dsw-alias-label-primary);font-size:12.5px;line-height:19px;padding:9px 11px;width:100%;box-sizing:border-box;outline:none;resize:vertical;font-family:inherit;min-height:72px}',
      '.dsp-textarea-lg{min-height:300px;max-height:58vh;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px}',
      '.dsp-block{margin-top:8px;display:flex;flex-direction:column;gap:4px}',
      '.dsp-badge{font-size:11px;line-height:16px;padding:1px 7px;border-radius:999px;background:color-mix(in srgb,var(--dsw-alias-label-secondary) 14%,transparent);color:var(--dsw-alias-label-secondary);font-weight:400}',
      '.dsp-badge-on{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 16%,transparent);color:var(--dsw-alias-brand-primary)}',
      '.dsp-tabs{display:flex;gap:6px;flex-wrap:wrap;margin:8px 0 6px}',
      '.dsp-tab{display:flex;flex-direction:column;align-items:flex-start;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-primary);border-radius:8px;padding:5px 11px;font-size:12.5px;cursor:pointer;font-family:inherit;line-height:17px}',
      '.dsp-tab-on{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}',
      '.dsp-tab-sub{font-size:11px;color:var(--dsw-alias-label-secondary)}',
      '.dsp-tab-add{border-style:dashed;color:var(--dsw-alias-label-secondary)}',
      '.dsp-mode{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:5px 2px;border-bottom:.5px solid var(--dsw-alias-border-l1)}',
      '.dsp-mode:last-child{border-bottom:none}',
      '.dsp-modebtn{display:flex;align-items:center;gap:6px;background:transparent;border:none;color:inherit;font-size:13px;cursor:pointer;padding:2px 0;font-family:inherit;text-align:left;flex:1}',
      '.dsp-mode-on .dsp-modebtn{color:var(--dsw-alias-brand-primary)}',
      '.dsp-active{color:var(--dsw-alias-brand-primary)}',
      '.dsp-idle{opacity:.45}',
      '.dsp-count{font-size:11px;color:var(--dsw-alias-label-secondary);margin-left:4px}',
      '.dsp-mini{background:transparent;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary);border-radius:6px;font-size:11.5px;height:24px;padding:0 9px;cursor:pointer;font-family:inherit}',
      '.dsp-mini-danger{color:var(--dsw-alias-state-error-primary)}',
      '.dsp-addmode{margin-top:6px;align-self:flex-start}',
      '.dsp-editor{margin-top:12px;padding-top:4px;border-top:.5px solid var(--dsw-alias-border-l1);display:flex;flex-direction:column}',
      '.dsp-inline{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
      '.dsp-addrow{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:8px}',
      '.dsp-rule{padding:10px 0;border-bottom:.5px solid var(--dsw-alias-border-l1);display:flex;flex-direction:column;gap:6px}',
      '.dsp-rule:last-child{border-bottom:none}',
      '.dsp-rule-name{min-width:200px}',
      '.dsp-actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:18px;padding-top:14px;border-top:.5px solid var(--dsw-alias-border-l2)}',
      '.dsp-btn{background:var(--dsw-alias-brand-primary);color:#fff;border:none;border-radius:6px;font-size:12.5px;height:30px;padding:0 14px;cursor:pointer;font-family:inherit}',
      '.dsp-btn:disabled{opacity:.5;cursor:default}',
      '.dsp-btn2{background:transparent;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary)}',
      '.dsp-ok{color:var(--dsw-alias-state-success-primary);font-size:12px;line-height:18px;margin-top:8px;white-space:pre-wrap}',
      '.dsp-err{color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px;margin-top:8px;white-space:pre-wrap}',
      '.dsp-card{border:1px solid var(--dsw-alias-border-l2);border-radius:10px;padding:12px;display:flex;flex-direction:column;gap:8px;margin-top:8px}',
      '.dsp-card-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:13px;font-weight:600}',
      '.dsp-progress{margin-top:8px;padding:8px 10px;border-radius:8px;background:color-mix(in srgb,var(--dsw-alias-label-secondary) 8%,transparent);font-size:12px;line-height:18px;display:flex;flex-direction:column;gap:4px}',
      '.dsp-logline{white-space:pre-wrap;color:var(--dsw-alias-label-secondary);font-size:11.5px;line-height:17px;max-height:168px;overflow:auto}',
      '.dsp-spin{display:inline-block;width:10px;height:10px;border:2px solid currentColor;border-right-color:transparent;border-radius:50%;animation:dsp-spin 1s linear infinite;margin-right:6px;vertical-align:-1px}',
      '@keyframes dsp-spin{to{transform:rotate(360deg)}}',
      '.dsp-char{display:flex;justify-content:space-between;align-items:center;gap:8px 16px;padding:8px 0;border-bottom:.5px solid var(--dsw-alias-border-l1);flex-wrap:wrap}',
      '.dsp-char:last-child{border-bottom:none}',
      '.dsp-src{font-size:11.5px;line-height:17px;color:var(--dsw-alias-label-secondary);display:flex;flex-direction:column;gap:2px}',
      '.dsp-src a{color:var(--dsw-alias-brand-primary);text-decoration:none;word-break:break-all}',
      '.dsp-lines{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;min-height:56px}',
      '.dsp-warn{color:var(--dsw-alias-state-warn-primary);font-size:12px}',
      '.dsp-team{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
      '.dsp-parts{display:flex;flex-direction:column;gap:12px;margin-top:6px}',
      '.dsp-part{display:flex;flex-direction:column;gap:4px}',
      '.dsp-part-head{display:flex;align-items:center;gap:8px;justify-content:space-between;flex-wrap:wrap}',
      '.dsp-part-hint{font-size:11.5px;line-height:17px;color:var(--dsw-alias-label-secondary)}',
      '.dsp-inline-wrap{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:2px 0}',
      '.dsp-slider{accent-color:var(--dsw-alias-brand-primary);width:200px;height:18px}',
      '.dsp-tag{font-size:11px;line-height:16px;padding:0 7px;border-radius:999px;border:1px dashed var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);font-weight:400}',
      '.dsp-partzero{opacity:.55}',
    ].join('')

    const clone = (value) => JSON.parse(JSON.stringify(value ?? {}))

    /** 会话键 → 给人看的名字。 */
    function chatLabel(key) {
      const text = String(key || '')
      const priv = /^private:(\d+)$/.exec(text)
      if (priv) {
        const qq = priv[1]
                return '私聊 ' + qq
      }
      const group = /^group:(\d+)$/.exec(text)
      if (group) return '群聊 ' + group[1]
      return text || '未命名会话'
    }

    function fmtTime(ms) {
      if (!ms) return '还没有文件'
      try {
        return new Date(ms).toLocaleString('zh-CN', { hour12: false })
      } catch {
        return String(ms)
      }
    }

    function uniqueName(base, taken) {
      if (!taken.includes(base)) return base
      for (let i = 2; i < 1000; i += 1) {
        const candidate = base + i
        if (!taken.includes(candidate)) return candidate
      }
      return base + Date.now()
    }

    function confirmAsk(text) {
      if (typeof window === 'undefined' || typeof window.confirm !== 'function') return true
      return window.confirm(text)
    }

    /** 多行文本 ↔ 字符串数组（口癖 / 例句 / 禁忌这种一行一条的字段）。 */
    const linesToList = (text) => String(text ?? '').split('\n').map((line) => line.trim()).filter(Boolean)
    const listToLines = (list) => (Array.isArray(list) ? list.join('\n') : '')
    /** 0.18 → 18% */
    const pct = (value) => Math.round((Number(value) || 0) * 100) + '%'

    function fmtSeconds(ms) {
      if (!ms || ms < 1000) return '0 秒'
      const seconds = Math.round(ms / 1000)
      if (seconds < 60) return seconds + ' 秒'
      return Math.floor(seconds / 60) + ' 分 ' + (seconds % 60) + ' 秒'
    }

    // ── 模式的两种写法（与 lib/mode.js、QQ 桥接保持一致） ──────────────────
    /** 三段式字段：顺序、标签、提示都在这里，页面和拼正文共用。 */
    const MODE_PARTS = [
      {
        key: 'identity',
        title: '是谁',
        short: '谁',
        label: '你是谁：',
        hint: '这个人是谁、什么身份、什么性格。',
        rows: 4,
      },
      {
        key: 'behavior',
        title: '什么时候开口',
        short: '开口',
        label: '什么时候开口：',
        hint: '什么时候插话、什么时候安静：不硬找话题、不刷屏。',
        rows: 3,
      },
      {
        key: 'replyStyle',
        title: '怎么说话',
        short: '说话',
        label: '说话方式：',
        hint: '长短、语气、口头禅、称呼、格式禁忌。',
        rows: 5,
      },
    ]

    const isStructured = (value) => !!value && typeof value === 'object' && !Array.isArray(value)

    /** 拼成最终注入的正文（必须和桥接一字不差）。 */
    function composeModeBody(value) {
      if (!isStructured(value)) return typeof value === 'string' ? value.trim() : ''
      return MODE_PARTS
        .map((part) => {
          const text = typeof value[part.key] === 'string' ? value[part.key].trim() : ''
          return text ? part.label + '\n' + text : ''
        })
        .filter(Boolean)
        .join('\n\n')
        .trim()
    }

    const modeChars = (value) => composeModeBody(value).length
    const emptyStructuredMode = () => ({ identity: '', behavior: '', replyStyle: '', variants: [], variantChance: 0 })
    const partText = (value, key) => (isStructured(value) && typeof value[key] === 'string' ? value[key] : '')
    const partChars = (value, key) => partText(value, key).trim().length
    const variantList = (value) => (isStructured(value) && Array.isArray(value.variants) ? value.variants : [])
    const variantChance = (value) => (isStructured(value) && Number.isFinite(Number(value.variantChance)) ? Number(value.variantChance) : 0)
    /** 列表里那一行摘要：谁12 · 开口0 · 说话30 */
    const partBrief = (value) => MODE_PARTS.map((part) => part.short + partChars(value, part.key)).join(' · ')
    /** 节奏提示压成一行，当备用风格用。 */
    const oneLine = (text) => String(text ?? '').replace(/\s*\n+\s*/g, '；').replace(/；+/g, '；').trim().slice(0, 200)

    /** 一条规则：名字失焦才提交（避免边打边重建对象）。 */
    function RuleRow({ name, text, onRename, onChange, onDelete }) {
      const [draft, setDraft] = useState(name)
      useEffect(() => { setDraft(name) }, [name])
      return h('div', { className: 'dsp-rule' },
        h('div', { className: 'dsp-inline' },
          h('input', {
            className: 'dsp-input dsp-rule-name',
            value: draft,
            onChange: (e) => setDraft(e.target.value),
            onBlur: () => {
              const next = String(draft ?? '').trim()
              if (!next || next === name) { setDraft(name); return }
              onRename(next)
            },
            onKeyDown: (e) => { if (e.key === 'Enter') e.currentTarget.blur() },
          }),
          h('button', { type: 'button', className: 'dsp-mini dsp-mini-danger', onClick: onDelete }, '删除')),
        h('textarea', {
          className: 'dsp-textarea',
          rows: 2,
          value: text,
          onChange: (e) => onChange(e.target.value),
        }))
    }

    function PersonaSection() {
      const [data, setData] = useState(null)
      const [savedJson, setSavedJson] = useState('')
      const [mtimeMs, setMtimeMs] = useState(0)
      const [filePath, setFilePath] = useState('')
      const [exists, setExists] = useState(false)
      const [tab, setTab] = useState('')
      const [modeName, setModeName] = useState('')
      const [nameDraft, setNameDraft] = useState('')
      const [newChatKey, setNewChatKey] = useState('')
      const [showAddChat, setShowAddChat] = useState(false)
      const [newRuleName, setNewRuleName] = useState('')
      const [err, setErr] = useState('')
      const [msg, setMsg] = useState('')
      const [busy, setBusy] = useState('')

      // ── 从互联网学习角色 ──
      const [learnName, setLearnName] = useState('')
      const [learnExtra, setLearnExtra] = useState('')
      const [learnJob, setLearnJob] = useState(null)
      const [draft, setDraft] = useState(null)
      const [draftName, setDraftName] = useState('')
      const [draftPrompt, setDraftPrompt] = useState('')
      const [draftLines, setDraftLines] = useState({ catchphrases: '', examples: '', taboos: '' })
      const [applyChat, setApplyChat] = useState('')
      // ── 说话习惯（从聊天里学） ──
      const [speech, setSpeech] = useState(null)
      const [speechDraft, setSpeechDraft] = useState('')
      const [speechBusy, setSpeechBusy] = useState('')

      const load = useCallback(async () => {
        setErr('')
        setMsg('')
        try {
          const r = await fetch(API + '/personas', { headers: { accept: 'application/json' } })
          const j = await r.json().catch(() => ({}))
          if (!r.ok || j.ok === false) throw new Error(j.error || 'HTTP ' + r.status)
          const personas = j.personas ?? {}
          setData(personas)
          setSavedJson(JSON.stringify(personas))
          setMtimeMs(j.mtimeMs ?? 0)
          setFilePath(j.path ?? '')
          setExists(!!j.exists)
        } catch (e) {
          setErr('读取失败：' + e.message)
        }
      }, [])

      useEffect(() => { load() }, [load])

      const loadSpeech = useCallback(async () => {
        try {
          const r = await fetch(API + '/speech', { headers: { accept: 'application/json' } })
          const j = await r.json().catch(() => ({}))
          if (!r.ok || j.ok === false) throw new Error(j.error || 'HTTP ' + r.status)
          setSpeech(j)
          setSpeechDraft(j.prompt || '')
        } catch (e) {
          setSpeech({ error: String(e?.message ?? e) })
        }
      }, [])

      useEffect(() => { loadSpeech() }, [loadSpeech])

      const chats = data?.chats ?? {}
      const chatKeys = Object.keys(chats)
      const block = tab && chats[tab] ? chats[tab] : null
      const modes = block?.modes ?? {}
      const modeNames = Object.keys(modes)
      const rules = data?.rules ?? {}
      const ruleNames = Object.keys(rules)
      const characters = data?.characters ?? {}
      const characterNames = Object.keys(characters)

      // ── data 变化后：tab / 选中模式自动落在合法值上 ──
      useEffect(() => {
        if (!data) return
        if (tab && chats[tab]) return
        const first = Object.keys(chats)[0] ?? ''
        if (first !== tab) setTab(first)
      }, [data, tab])

      useEffect(() => {
        if (!tab || !chats[tab]) { setModeName(''); return }
        const names = Object.keys(chats[tab].modes ?? {})
        if (names.includes(modeName)) return
        const active = chats[tab].active
        setModeName(active && names.includes(active) ? active : (names[0] ?? ''))
      }, [data, tab])

      useEffect(() => { setNameDraft(modeName) }, [modeName])

      const dirty = !!data && savedJson !== '' && JSON.stringify(data) !== savedJson

      const mutate = useCallback((fn) => {
        setData((current) => {
          if (!current) return current
          const next = clone(current)
          fn(next)
          return next
        })
      }, [])

      // ── 从互联网学习角色 ──────────────────────────────────────────────

      /** 套用目标：默认选第一个会话。 */
      useEffect(() => {
        if (!data) return
        const keys = Object.keys(data.chats ?? {})
        if (applyChat && keys.includes(applyChat)) return
        setApplyChat(keys[0] ?? '')
      }, [data, applyChat])

      /** 把一条角色载入编辑区（学习结果 / 角色库里的都走这里）。 */
      const loadDraft = useCallback((character) => {
        if (!character) return
        setDraft(JSON.parse(JSON.stringify(character)))
        setDraftName(character.name || '')
        setDraftPrompt(character.prompt || '')
        setDraftLines({
          catchphrases: listToLines(character.catchphrases),
          examples: listToLines(character.examples),
          taboos: listToLines(character.taboos),
        })
        setErr('')
      }, [])

      const setDraftField = (field, value) => {
        setDraft((current) => (current ? { ...current, [field]: value } : current))
      }

      /** 统一保存：先 POST 再回填服务端整理后的 personas。 */
      const persist = useCallback(async (next, successText) => {
        const r = await fetch(API + '/personas', {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({ personas: next, baseMtimeMs: mtimeMs }),
        })
        const j = await r.json().catch(() => ({}))
        if (!r.ok || j.ok === false) {
          throw new Error((j.error || 'HTTP ' + r.status) + (r.status === 409 ? '（先点「重新读取」再改）' : ''))
        }
        setData(j.personas)
        setSavedJson(JSON.stringify(j.personas))
        setMtimeMs(j.mtimeMs ?? 0)
        setExists(true)
        setMsg(successText || '✓ 已保存')
      }, [mtimeMs])

      const startLearn = async () => {
        const name = learnName.trim()
        if (!name) { setErr('先填角色名字'); return }
        setErr('')
        setMsg('')
        setLearnJob({ id: '', state: 'starting', step: '提交中', logs: [], elapsedMs: 0 })
        try {
          const r = await fetch(API + '/learn', {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            body: JSON.stringify({ name, extra: learnExtra }),
          })
          const j = await r.json().catch(() => ({}))
          if (!r.ok || j.ok === false) throw new Error(j.error || 'HTTP ' + r.status)
          setLearnJob(j.job)
        } catch (e) {
          setLearnJob(null)
          setErr('开始学习失败：' + e.message)
        }
      }

      const cancelLearn = async () => {
        if (!learnJob?.id) { setLearnJob(null); return }
        try {
          await fetch(API + '/learn?jobId=' + encodeURIComponent(learnJob.id), {
            method: 'DELETE',
            headers: { accept: 'application/json' },
          })
        } catch { /* 取消失败就等它自己结束 */ }
      }

      // 学习任务轮询：900ms 拉一次，完成就把结果放进编辑区
      useEffect(() => {
        if (!learnJob || learnJob.state !== 'running' || !learnJob.id) return undefined
        let stopped = false
        let timer = null
        const tick = async () => {
          try {
            const r = await fetch(API + '/learn?jobId=' + encodeURIComponent(learnJob.id), { headers: { accept: 'application/json' } })
            const j = await r.json().catch(() => ({}))
            if (!r.ok || j.ok === false) throw new Error(j.error || 'HTTP ' + r.status)
            if (stopped) return
            setLearnJob(j.job)
            if (j.job.state === 'done') {
              if (j.job.result?.character) {
                loadDraft(j.job.result.character)
                setMsg('学完了，先在下面检查/改一改，再点「存入角色库」。')
              }
            } else if (j.job.state === 'running') {
              timer = setTimeout(tick, 900)
            }
          } catch (e) {
            if (stopped) return
            setLearnJob((current) => (current ? { ...current, state: 'error', step: '轮询失败', error: String(e?.message ?? e) } : current))
          }
        }
        timer = setTimeout(tick, 700)
        return () => { stopped = true; if (timer) clearTimeout(timer) }
      }, [learnJob?.id, learnJob?.state, loadDraft])

      /** 把编辑区里的角色存进 personas.json.characters。 */
      const saveDraft = async () => {
        if (!draft) return
        const name = String(draftName || draft.name || '').trim()
        if (!name) { setErr('先给这个角色起个名字'); return }
        if (characters[name] && !confirmAsk('角色库里已经有「' + name + '」，覆盖它？')) return
        const character = {
          ...draft,
          name,
          prompt: draftPrompt,
          catchphrases: linesToList(draftLines.catchphrases),
          examples: linesToList(draftLines.examples),
          taboos: linesToList(draftLines.taboos),
          updatedAt: Date.now(),
        }
        const next = clone(data)
        next.characters = { ...(next.characters || {}), [name]: character }
        setBusy('save-draft')
        setErr('')
        try {
          await persist(next, '✓ 已存入角色库：' + name)
          setDraft(character)
          setDraftName(name)
        } catch (e) {
          setErr('存角色库失败：' + e.message)
        } finally {
          setBusy('')
        }
      }

      const deleteCharacter = async (name) => {
        if (!characters[name]) return
        if (!confirmAsk('从角色库删除「' + name + '」？（已经套用到会话的模式不受影响）')) return
        const next = clone(data)
        delete next.characters[name]
        setBusy('save-draft')
        setErr('')
        try {
          await persist(next, '✓ 已删除：' + name)
        } catch (e) {
          setErr('删除失败：' + e.message)
        } finally {
          setBusy('')
        }
      }

      /** 把角色提示词复制成某个会话的一个模式，并设为当前生效。 */
      const applyCharacterToChat = async (character, chatKey) => {
        if (!character) return
        const key = chatKey || applyChat
        if (!key || !data.chats || !data.chats[key]) { setErr('先选一个要套用的会话'); return }
        const modeName = String(character.name || '').trim() || '角色'
        const existing = data.chats[key].modes || {}
        if (Object.prototype.hasOwnProperty.call(existing, modeName) && !confirmAsk('「' + chatLabel(key) + '」已经有「' + modeName + '」这个模式，覆盖？')) return
        const next = clone(data)
        const target = next.chats[key]
        target.modes = { ...(target.modes || {}), [modeName]: character.prompt || '' }
        target.active = modeName
        setBusy('save-draft')
        setErr('')
        try {
          await persist(next, '✓ 已套用到「' + chatLabel(key) + '」的模式「' + modeName + '」，QQ 下一条消息生效')
        } catch (e) {
          setErr('套用失败：' + e.message)
        } finally {
          setBusy('')
        }
      }

      // ── 说话习惯（从聊天里学） ──
      const refreshSpeech = async () => {
        setSpeechBusy('refresh')
        setErr('')
        try {
          await loadSpeech()
        } catch (e) {
          setErr('刷新说话习惯失败：' + e.message)
        } finally {
          setSpeechBusy('')
        }
      }

      const resetSpeech = async () => {
        if (!confirmAsk('清空从聊天里学到的说话习惯统计？（只清统计，不改人格文件）')) return
        setSpeechBusy('reset')
        setErr('')
        try {
          const r = await fetch(API + '/speech', {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            body: JSON.stringify({ action: 'reset' }),
          })
          const j = await r.json().catch(() => ({}))
          if (!r.ok || j.ok === false) throw new Error(j.error || 'HTTP ' + r.status)
          setSpeech(j)
          setSpeechDraft('')
          setMsg('✓ 说话习惯统计已清空')
        } catch (e) {
          setErr('清空失败：' + e.message)
        } finally {
          setSpeechBusy('')
        }
      }

      /**
       * 把学到的节奏提示接进当前模式：
       * - 三段式：默认追加到「怎么说话」，也可以压成一行存成一条备用风格；
       * - 老格式：照旧追加到正文末尾。
       */
      const appendSpeechToMode = async (target = 'replyStyle') => {
        if (!speechDraft.trim()) { setErr('还没有学出东西，先多聊几句再刷新'); return }
        if (!tab || !modeName) { setErr('先选一个会话的模式再追加'); return }
        const value = data?.chats?.[tab]?.modes?.[modeName]
        const structured = isStructured(value)
        const next = clone(data)
        const clonedMode = () => next.chats[tab].modes[modeName]
        const marker = '# 对方的打字习惯（参考）'

        if (structured && target === 'variant') {
          const line = oneLine(speechDraft)
          if (!line) { setErr('这段压不成一行，换「追加到怎么说话」吧'); return }
          const current = variantList(value)
          if (current.includes(line)) { setErr('备用风格里已经有这一条了。'); return }
          if (current.length >= 8) { setErr('备用风格最多 8 条，先删一条再加。'); return }
          clonedMode().variants = [...current, line].slice(0, 8)
        } else if (structured) {
          const current = partText(value, 'replyStyle')
          if (current.includes(marker)) {
            setErr('「怎么说话」里已经有说话习惯那一段了，先手动删掉旧的再加。')
            return
          }
          clonedMode().replyStyle = (current ? current + '\n\n' : '') + speechDraft.trim()
        } else {
          const current = typeof value === 'string' ? value : ''
          if (current.includes(marker)) {
            setErr('这个模式里已经有说话习惯那一段了，先手动删掉旧的再加。')
            return
          }
          next.chats[tab].modes[modeName] = (current ? current + '\n\n' : '') + speechDraft.trim()
        }

        setBusy('save-speech')
        setErr('')
        try {
          await persist(next, '✓ 已追加到「' + chatLabel(tab) + '」的「' + modeName + '」，QQ 下一条消息生效')
        } catch (e) {
          setErr('追加失败：' + e.message)
        } finally {
          setBusy('')
        }
      }

      // ── 身份（default） ──
      const setDefault = (field, value) => mutate((d) => {
        d.default = { ...(d.default ?? {}), [field]: value }
      })

      // ── 会话模式 ──
      const setActive = (name) => mutate((d) => {
        const b = d.chats?.[tab]
        if (b) b.active = name
      })

      const setModePrompt = (value) => mutate((d) => {
        const b = d.chats?.[tab]
        if (b) b.modes[modeName] = value
      })

      /** 三段式：改其中一格。当前是老格式时会先转成空的三段式（不会丢原文，原文要自己拆/搬）。 */
      const setModePart = (key, value) => mutate((d) => {
        const b = d.chats?.[tab]
        if (!b) return
        const current = b.modes[modeName]
        const base = isStructured(current) ? { ...current } : emptyStructuredMode()
        base[key] = value
        b.modes[modeName] = base
      })

      /** 三段式：备用风格的第 index 条。 */
      const setVariantAt = (index, value) => mutate((d) => {
        const b = d.chats?.[tab]
        if (!b) return
        const current = b.modes[modeName]
        if (!isStructured(current)) return
        const list = [...variantList(current)]
        list[index] = value
        b.modes[modeName] = { ...current, variants: list }
      })

      const addVariant = () => mutate((d) => {
        const b = d.chats?.[tab]
        if (!b) return
        const current = b.modes[modeName]
        const base = isStructured(current) ? { ...current } : emptyStructuredMode()
        const list = variantList(base)
        if (list.length >= 8) return
        b.modes[modeName] = { ...base, variants: [...list, ''] }
      })

      const removeVariant = (index) => mutate((d) => {
        const b = d.chats?.[tab]
        if (!b) return
        const current = b.modes[modeName]
        if (!isStructured(current)) return
        b.modes[modeName] = { ...current, variants: variantList(current).filter((_, i) => i !== index) }
      })

      /** 三段式：换风格的概率 0~1。 */
      const setModeChance = (value) => mutate((d) => {
        const b = d.chats?.[tab]
        if (!b) return
        const current = b.modes[modeName]
        const base = isStructured(current) ? { ...current } : emptyStructuredMode()
        const number = Number(value)
        base.variantChance = Number.isFinite(number) ? Math.min(1, Math.max(0, Math.round(number * 1000) / 1000)) : 0
        b.modes[modeName] = base
      })

      /** 老格式 → 三段式：调一次模型拆，结果只进编辑区，点保存才落盘。 */
      const splitMode = async () => {
        if (!tab || !modeName) return
        const value = data?.chats?.[tab]?.modes?.[modeName]
        if (isStructured(value)) { setErr('这个模式已经是三段式了。'); return }
        const text = typeof value === 'string' ? value.trim() : ''
        if (text.length < 20) { setErr('这段太短了，没什么可拆的（至少 20 个字）。'); return }
        setBusy('split')
        setErr('')
        setMsg('')
        try {
          const r = await fetch(API + '/split', {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            body: JSON.stringify({ text, name: modeName }),
          })
          const j = await r.json().catch(() => ({}))
          if (!r.ok || j.ok === false) throw new Error(j.error || 'HTTP ' + r.status)
          mutate((d) => {
            const b = d.chats?.[tab]
            if (b) b.modes[modeName] = j.mode
          })
          setMsg('✓ 拆好了：先看看三段分得对不对，改完再点保存（用 ' + (j.model || '默认模型') + ' 拆的）')
        } catch (e) {
          setErr('拆分失败：' + e.message)
        } finally {
          setBusy('')
        }
      }

      /** 三段式 → 一整段文字（合并，备用风格会丢）。 */
      const modeToPlainText = () => {
        if (!tab || !modeName) return
        const value = data?.chats?.[tab]?.modes?.[modeName]
        if (!isStructured(value)) return
        if (!confirmAsk('把「' + modeName + '」改回一整段文字？三段会按顺序合成一段，备用风格和概率会丢掉。')) return
        const body = composeModeBody(value)
        mutate((d) => {
          const b = d.chats?.[tab]
          if (b) b.modes[modeName] = body
        })
        setMsg('已合并成一整段文字，点保存才生效。')
        setErr('')
      }

      const addMode = () => {
        if (!tab) return
        const taken = Object.keys(chats[tab]?.modes ?? {})
        const name = uniqueName('新模式', taken)
        mutate((d) => {
          const b = d.chats?.[tab]
          if (b) b.modes[name] = emptyStructuredMode()
        })
        setModeName(name)
        setErr('')
        setMsg('')
      }

      const deleteMode = (name) => {
        if (!tab) return
        const names = Object.keys(chats[tab]?.modes ?? {})
        if (names.length <= 1) { setErr('至少要保留一个性格模式。'); return }
        if (!confirmAsk('删除模式「' + name + '」？正文也会一起没。')) return
        const remaining = names.filter((n) => n !== name)
        const nextSelected = modeName === name ? remaining[0] : modeName
        mutate((d) => {
          const b = d.chats?.[tab]
          if (!b) return
          delete b.modes[name]
          if (b.active === name) b.active = remaining[0]
        })
        setModeName(nextSelected)
        setErr('')
        setMsg('')
      }

      const commitModeName = () => {
        if (!tab) return
        const original = modeName
        const nextName = String(nameDraft ?? '').trim()
        if (!nextName || nextName === original) { setNameDraft(original); return }
        if (Object.prototype.hasOwnProperty.call(modes, nextName)) {
          setErr('已经有「' + nextName + '」这个模式了，换个名字。')
          setNameDraft(original)
          return
        }
        mutate((d) => {
          const b = d.chats?.[tab]
          if (!b) return
          const rebuilt = {}
          for (const [key, value] of Object.entries(b.modes ?? {})) {
            rebuilt[key === original ? nextName : key] = value
          }
          b.modes = rebuilt
          if (b.active === original) b.active = nextName
        })
        setModeName(nextName)
        setErr('')
      }

      // ── 会话键 ──
      const addChat = () => {
        const key = String(newChatKey ?? '').trim()
        if (!key) { setErr('先填一个会话键，比如 private:123456789'); return }
        if (chats[key]) { setErr('会话「' + key + '」已经存在。'); return }
        mutate((d) => {
          d.chats[key] = { active: '默认', modes: { 默认: '' } }
        })
        setTab(key)
        setNewChatKey('')
        setShowAddChat(false)
        setErr('')
        setMsg('')
      }

      // ── 规则 ──
      const renameRule = (oldName, nextRaw) => {
        const nextName = String(nextRaw ?? '').trim()
        if (!nextName || nextName === oldName) return
        if (Object.prototype.hasOwnProperty.call(rules, nextName)) {
          setErr('已经有「' + nextName + '」这条规则了。')
          return
        }
        mutate((d) => {
          const rebuilt = {}
          for (const [key, value] of Object.entries(d.rules ?? {})) {
            rebuilt[key === oldName ? nextName : key] = value
          }
          d.rules = rebuilt
        })
        setErr('')
      }

      const setRuleText = (name, value) => mutate((d) => {
        d.rules[name] = value
      })

      const addRule = () => {
        const name = String(newRuleName ?? '').trim()
        if (!name) { setErr('先填规则名。'); return }
        if (Object.prototype.hasOwnProperty.call(rules, name)) { setErr('已经有「' + name + '」这条规则了。'); return }
        mutate((d) => {
          d.rules[name] = ''
        })
        setNewRuleName('')
        setErr('')
        setMsg('')
      }

      const deleteRule = (name) => {
        if (!confirmAsk('删除规则「' + name + '」？')) return
        mutate((d) => {
          delete d.rules[name]
        })
        setErr('')
        setMsg('')
      }

      // ── 保存 / 重读 ──
      const save = async () => {
        if (!data) return
        setBusy('save')
        setErr('')
        setMsg('')
        try {
          const r = await fetch(API + '/personas', {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            body: JSON.stringify({ personas: data, baseMtimeMs: mtimeMs }),
          })
          const j = await r.json().catch(() => ({}))
          if (!r.ok || j.ok === false) {
            throw new Error((j.error || 'HTTP ' + r.status) + (r.status === 409 ? '（先点「重新读取」再改）' : ''))
          }
          setData(j.personas)
          setSavedJson(JSON.stringify(j.personas))
          setMtimeMs(j.mtimeMs ?? 0)
          setExists(true)
          setMsg('✓ 已保存' + (j.backup ? '（旧文件已备份）' : '') + '。QQ 下一条消息就用新人设，不用重启。')
        } catch (e) {
          setErr('保存失败：' + e.message)
        } finally {
          setBusy('')
        }
      }

      const reload = () => {
        if (dirty && !confirmAsk('有改动还没保存，重新读取会丢掉这些改动，确定？')) return
        load()
      }

      const head = (children) => [
        h('style', null, CSS),
        h('h3', { className: 'dsp-title' }, '身份与人设'),
        ...children,
      ]

      if (!data) {
        return h('div', { className: 'dsp' },
          ...head([err ? h('div', { className: 'dsp-err' }, err) : h('div', { className: 'dsp-hint' }, '读取中…')]))
      }

      const modeValue = modeName && modeName in modes ? modes[modeName] : ''
      const structuredMode = isStructured(modeValue)
      const learnRunning = !!learnJob && (learnJob.state === 'running' || learnJob.state === 'starting')

      return h('div', { className: 'dsp' },
        ...head([
          h('p', { className: 'dsp-intro' },
            '改的是 QQ 桥接的人格文件 ',
            h('code', null, filePath || 'personas.json'),
            '；保存后 QQ 下一条消息就生效，不用重启。'),
          h('div', { className: 'dsp-meta' },
            h('span', null, exists ? '文件已存在' : '文件还没建（第一次保存会创建）'),
            h('span', { className: 'dsp-dot' }, '·'),
            h('span', null, '最后修改：' + fmtTime(mtimeMs)),
            dirty ? h('span', { className: 'dsp-dirty' }, '● 有改动还没保存') : null),

          // ── 从互联网学习角色 ──
          h('div', { className: 'dsp-group' }, '从互联网学习角色'),
          h('div', { className: 'dsp-hint' },
            '给一个角色名，自动去萌娘百科 / 360 百科 / 搜索抓资料，用当前默认模型提炼出人设和说话方式。学完先给你看，确认、改好再存。'),
          h('div', { className: 'dsp-team' },
            h('input', {
              className: 'dsp-input',
              placeholder: '角色名，例如：灰原哀 / 迪丽热巴 / 派蒙',
              value: learnName,
              onChange: (e) => setLearnName(e.target.value),
              onKeyDown: (e) => { if (e.key === 'Enter' && !learnRunning) startLearn() },
            }),
            h('input', {
              className: 'dsp-input',
              placeholder: '补充（可选）：出处 / 想让他怎么说话',
              value: learnExtra,
              onChange: (e) => setLearnExtra(e.target.value),
            })),
          h('div', { className: 'dsp-addrow' },
            h('button', { type: 'button', className: 'dsp-btn', onClick: startLearn, disabled: learnRunning },
              learnRunning ? '学习中…' : '开始学习'),
            learnRunning ? h('button', { type: 'button', className: 'dsp-btn dsp-btn2', onClick: cancelLearn }, '取消') : null,
            draft ? h('button', {
              type: 'button',
              className: 'dsp-btn dsp-btn2',
              onClick: () => { setDraft(null); setDraftPrompt(''); setDraftName(''); setLearnJob(null) },
            }, '清空编辑区') : null),

          learnJob ? h('div', { className: 'dsp-progress' },
            h('div', { className: 'dsp-inline' },
              learnRunning ? h('span', { className: 'dsp-spin' }) : null,
              h('span', null,
                '[' + ({ running: '学习中', starting: '提交中', done: '完成', error: '失败', canceled: '已取消' }[learnJob.state] || learnJob.state) + '] ',
                learnJob.step || ''),
              learnJob.elapsedMs ? h('span', { className: 'dsp-hint' }, ' ' + fmtSeconds(learnJob.elapsedMs)) : null),
            learnJob.logs && learnJob.logs.length
              ? h('div', { className: 'dsp-logline' },
                  learnJob.logs
                    .filter((line) => line.step !== 'net')
                    .slice(-8)
                    .map((line) => line.text)
                    .join('\n'))
              : null,
            learnJob.error ? h('div', { className: 'dsp-err' }, learnJob.error) : null) : null,

          // ── 学习结果（可编辑，确认后再存） ──
          draft ? h('div', { className: 'dsp-card' },
            h('div', { className: 'dsp-card-head' },
              '学习结果 · 可以改',
              draft.degraded ? h('span', { className: 'dsp-warn' }, '网上资料少，结果可能一般') : null,
              draft.model ? h('span', { className: 'dsp-badge' }, draft.model) : null),
            h('div', { className: 'dsp-row' },
              h('div', { className: 'dsp-label' }, '角色名'),
              h('input', { className: 'dsp-input', value: draftName, onChange: (e) => setDraftName(e.target.value) })),
            h('div', { className: 'dsp-row' },
              h('div', { className: 'dsp-label' }, '出处 / 身份'),
              h('input', { className: 'dsp-input', value: draft.title ?? '', onChange: (e) => setDraftField('title', e.target.value) })),
            h('div', { className: 'dsp-block' },
              h('div', { className: 'dsp-label' }, '一句话介绍'),
              h('textarea', { className: 'dsp-textarea', rows: 2, value: draft.summary ?? '', onChange: (e) => setDraftField('summary', e.target.value) })),
            h('div', { className: 'dsp-block' },
              h('div', { className: 'dsp-label' }, '性格'),
              h('textarea', { className: 'dsp-textarea', rows: 3, value: draft.personality ?? '', onChange: (e) => setDraftField('personality', e.target.value) })),
            h('div', { className: 'dsp-block' },
              h('div', { className: 'dsp-label' }, '说话方式'),
              h('textarea', { className: 'dsp-textarea', rows: 4, value: draft.speechStyle ?? '', onChange: (e) => setDraftField('speechStyle', e.target.value) })),
            h('div', { className: 'dsp-row' },
              h('div', { className: 'dsp-label' }, '自称 / 称呼'),
              h('input', { className: 'dsp-input', value: draft.address ?? '', onChange: (e) => setDraftField('address', e.target.value) })),
            h('div', { className: 'dsp-block' },
              h('div', { className: 'dsp-label' }, '口头禅（一行一条）'),
              h('textarea', {
                className: 'dsp-textarea dsp-lines',
                rows: 4,
                value: draftLines.catchphrases,
                onChange: (e) => setDraftLines((current) => ({ ...current, catchphrases: e.target.value })),
              })),
            h('div', { className: 'dsp-block' },
              h('div', { className: 'dsp-label' }, '例句（一行一条）'),
              h('textarea', {
                className: 'dsp-textarea dsp-lines',
                rows: 4,
                value: draftLines.examples,
                onChange: (e) => setDraftLines((current) => ({ ...current, examples: e.target.value })),
              })),
            h('div', { className: 'dsp-block' },
              h('div', { className: 'dsp-label' }, '不会做 / 禁忌（一行一条）'),
              h('textarea', {
                className: 'dsp-textarea dsp-lines',
                rows: 3,
                value: draftLines.taboos,
                onChange: (e) => setDraftLines((current) => ({ ...current, taboos: e.target.value })),
              })),
            h('div', { className: 'dsp-block' },
              h('div', { className: 'dsp-label' }, '角色提示词（套用到会话时用的就是这段）',
                h('span', { className: 'dsp-badge' }, String(draftPrompt || '').length + ' 字')),
              h('textarea', {
                className: 'dsp-textarea dsp-textarea-lg',
                value: draftPrompt,
                onChange: (e) => setDraftPrompt(e.target.value),
              })),
            draft.sources && draft.sources.length
              ? h('div', { className: 'dsp-src' },
                  h('span', null, '来源（' + draft.sources.length + '）：'),
                  draft.sources.map((source, index) => h('a', {
                    key: index,
                    href: source.url,
                    target: '_blank',
                    rel: 'noreferrer',
                  }, (source.title || source.url) + '  ' + source.url)))
              : null,
            h('div', { className: 'dsp-addrow' },
              h('button', { type: 'button', className: 'dsp-btn', onClick: saveDraft, disabled: !!busy },
                busy === 'save-draft' ? '保存中…' : (characters[draftName || draft.name] ? '更新角色库' : '存入角色库')),
              h('button', {
                type: 'button',
                className: 'dsp-btn dsp-btn2',
                onClick: () => applyCharacterToChat({ ...draft, name: draftName || draft.name, prompt: draftPrompt }, applyChat),
                disabled: !!busy || !applyChat,
              }, '套用到：' + (applyChat ? chatLabel(applyChat) : '（先选会话）')),
              h('button', {
                type: 'button',
                className: 'dsp-btn dsp-btn2',
                onClick: () => { setDraft(null); setDraftPrompt(''); setDraftName(''); setLearnJob(null) },
              }, '丢弃'))) : null,

          // ── 角色库 ──
          h('div', { className: 'dsp-group' }, '角色库（' + characterNames.length + '）'),
          h('div', { className: 'dsp-hint' }, '学出来的角色存在 personas.json 的 characters 里；「套用」会把提示词复制成目标会话的一个模式（一整段文字格式），并设为当前生效；想拆成三段，套用后在下面编辑器里点「拆成三段」。'),
          h('div', { className: 'dsp-addrow' },
            h('span', { className: 'dsp-label' }, '套用目标'),
            h('select', {
              className: 'dsp-select',
              value: applyChat,
              onChange: (e) => setApplyChat(e.target.value),
            }, chatKeys.map((key) => h('option', { key, value: key }, chatLabel(key))))),
          characterNames.length === 0
            ? h('div', { className: 'dsp-hint', style: { padding: '8px 0' } }, '（还没有角色，上面学一个）')
            : h('div', null, characterNames.map((name) => {
                const item = characters[name]
                return h('div', { className: 'dsp-char', key: name },
                  h('div', null,
                    h('div', { className: 'dsp-label' }, item.name || name,
                      item.degraded ? h('span', { className: 'dsp-badge' }, '资料少') : null,
                      item.model ? h('span', { className: 'dsp-badge' }, item.model) : null),
                    h('div', { className: 'dsp-hint' },
                      [item.title, (item.prompt || '').length + ' 字', (item.sources?.length || 0) + ' 个来源', item.updatedAt ? fmtTime(item.updatedAt) : '']
                        .filter(Boolean)
                        .join(' · '))),
                  h('div', { className: 'dsp-inline' },
                    h('button', { type: 'button', className: 'dsp-mini', onClick: () => loadDraft(item) }, '编辑'),
                    h('button', { type: 'button', className: 'dsp-mini', onClick: () => applyCharacterToChat(item), disabled: !applyChat }, '套用'),
                    h('button', { type: 'button', className: 'dsp-mini dsp-mini-danger', onClick: () => deleteCharacter(name) }, '删除')))
              })),

          // ── 说话习惯（从聊天里学） ──
          h('div', { className: 'dsp-group' }, '说话习惯（从聊天里学）'),
          h('div', { className: 'dsp-hint' },
            '你在 DSH 里聊天时自动累计：只记每条多少字、几行和标点使用，不存原话；攒够 8 条会生成一段节奏提示，可以追加到当前会话模式。'),
          !speech
            ? h('div', { className: 'dsp-hint' }, '统计读取中…')
            : speech.error
              ? h('div', { className: 'dsp-err' }, '读取统计失败：' + speech.error)
              : h('div', null,
                  h('div', { className: 'dsp-meta' },
                    h('span', null, '已学 ' + (speech.samples || 0) + ' 条'),
                    speech.stats ? h('span', { className: 'dsp-dot' }, '·') : null,
                    speech.stats ? h('span', null, '平均 ' + speech.stats.avgChars + ' 字/条') : null,
                    speech.stats ? h('span', { className: 'dsp-dot' }, '·') : null,
                    speech.stats ? h('span', null, '中位数 ' + speech.stats.medianChars + ' 字') : null,
                    speech.stats ? h('span', { className: 'dsp-dot' }, '·') : null,
                    speech.stats ? h('span', null, '一行占 ' + pct(speech.stats.oneLineRate)) : null),
                  speech.stats
                    ? h('div', { className: 'dsp-hint' },
                        '标点：句号 ' + pct(speech.stats.rates['。']) +
                        ' · 逗号 ' + pct(speech.stats.rates['，']) +
                        ' · 感叹号 ' + pct(speech.stats.rates['！']) +
                        ' · 问号 ' + pct(speech.stats.rates['？']) +
                        ' · 省略号 ' + pct(speech.stats.rates['……']) +
                        ' · 空格 ' + speech.stats.spaceRate.toFixed(1) + ' 个/条')
                    : null,
                  (speech.samples || 0) < 8
                    ? h('div', { className: 'dsp-hint', style: { padding: '6px 0' } }, '先聊几句，攒够 8 条就会生成节奏提示。')
                    : h('div', { className: 'dsp-block' },
                        h('div', { className: 'dsp-label' }, '节奏提示（可改）',
                          h('span', { className: 'dsp-badge' }, speechDraft.length + ' 字')),
                        h('textarea', {
                          className: 'dsp-textarea',
                          rows: 7,
                          value: speechDraft,
                          onChange: (e) => setSpeechDraft(e.target.value),
                        })),
                  h('div', { className: 'dsp-addrow' },
                    (speech.samples || 0) >= 8
                      ? h('button', { type: 'button', className: 'dsp-btn', onClick: () => appendSpeechToMode('replyStyle'), disabled: !!busy },
                          busy === 'save-speech' ? '追加中…' : (structuredMode ? '追加到「怎么说话」' : '追加到当前模式'))
                      : null,
                    (speech.samples || 0) >= 8 && structuredMode
                      ? h('button', { type: 'button', className: 'dsp-btn dsp-btn2', onClick: () => appendSpeechToMode('variant'), disabled: !!busy },
                          '压成一条备用风格')
                      : null,
                    h('button', { type: 'button', className: 'dsp-btn dsp-btn2', onClick: refreshSpeech, disabled: !!speechBusy },
                      speechBusy === 'refresh' ? '刷新中…' : '刷新统计'),
                    h('button', { type: 'button', className: 'dsp-btn dsp-btn2', onClick: resetSpeech, disabled: !!speechBusy }, '清空统计'),
                    tab && modeName
                      ? h('span', { className: 'dsp-hint' }, '当前：' + chatLabel(tab) + ' / ' + modeName)
                      : h('span', { className: 'dsp-hint' }, '先在下面选一个会话模式'))),

          // ── 身份（默认人格） ──
          h('div', { className: 'dsp-group' }, '身份（默认人格）'),
          h('div', { className: 'dsp-hint' }, '没单独配过的聊天用这一份兜底。真正的身份在下面每个会话的模式里。'),
          h('div', { className: 'dsp-rows' },
            h('div', { className: 'dsp-row' },
              h('div', { className: 'dsp-label' }, '名字（title）'),
              h('input', {
                className: 'dsp-input',
                value: data.default?.title ?? '',
                onChange: (e) => setDefault('title', e.target.value),
              }))),
          h('div', { className: 'dsp-block' },
            h('div', { className: 'dsp-label' }, '默认人格正文',
              h('span', { className: 'dsp-badge' }, (data.default?.prompt ?? '').length + ' 字')),
            h('textarea', {
              className: 'dsp-textarea',
              rows: 6,
              value: data.default?.prompt ?? '',
              onChange: (e) => setDefault('prompt', e.target.value),
            })),

          // ── QQ 会话人格 ──
          h('div', { className: 'dsp-group' }, 'QQ 会话人格'),
          h('div', { className: 'dsp-hint' }, '每个 QQ 聊天（私聊/群）各有一套模式，当前生效的那个会拼进 agent 的提示词。'),
          h('div', { className: 'dsp-tabs' },
            chatKeys.map((key) => h('button', {
              key,
              type: 'button',
              className: 'dsp-tab' + (key === tab ? ' dsp-tab-on' : ''),
              onClick: () => { setTab(key); setErr(''); setMsg('') },
              title: key,
            }, chatLabel(key), h('span', { className: 'dsp-tab-sub' }, chats[key]?.active ?? ''))),
            h('button', {
              type: 'button',
              className: 'dsp-tab dsp-tab-add',
              onClick: () => setShowAddChat((value) => !value),
            }, '+ 新会话')),
          showAddChat
            ? h('div', { className: 'dsp-addrow' },
                h('input', {
                  className: 'dsp-input',
                  placeholder: '会话键，例如 private:123456789',
                  value: newChatKey,
                  onChange: (e) => setNewChatKey(e.target.value),
                }),
                h('button', { type: 'button', className: 'dsp-btn', onClick: addChat }, '添加'),
                h('button', {
                  type: 'button',
                  className: 'dsp-btn dsp-btn2',
                  onClick: () => { setShowAddChat(false); setNewChatKey('') },
                }, '取消'))
            : null,

          !block
            ? h('div', { className: 'dsp-hint', style: { padding: '10px 0' } }, '（还没有任何会话人格，点「+ 新会话」加一个）')
            : h('div', null,
                h('div', { className: 'dsp-rows' },
                  h('div', { className: 'dsp-row' },
                    h('div', null,
                      h('div', { className: 'dsp-label' }, '当前生效模式'),
                      h('div', { className: 'dsp-hint' }, '会话键 ' + tab)),
                    h('select', {
                      className: 'dsp-select',
                      value: block.active ?? '',
                      onChange: (e) => setActive(e.target.value),
                    }, modeNames.map((name) => h('option', { key: name, value: name }, name))))),

                h('div', { className: 'dsp-modes' },
                  modeNames.map((name) => h('div', {
                    key: name,
                    className: 'dsp-mode' + (name === modeName ? ' dsp-mode-on' : ''),
                  },
                    h('button', {
                      type: 'button',
                      className: 'dsp-modebtn',
                      onClick: () => { setModeName(name); setErr(''); setMsg('') },
                    },
                      name === block.active ? h('span', { className: 'dsp-active' }, '▶ ') : h('span', { className: 'dsp-idle' }, '· '),
                      h('span', null, name),
                      isStructured(modes[name]) ? h('span', { className: 'dsp-tag' }, '三段式') : null,
                      h('span', { className: 'dsp-count' }, modeChars(modes[name]) + ' 字'),
                      isStructured(modes[name])
                        ? h('span', { className: 'dsp-count' + (partChars(modes[name], 'identity') + partChars(modes[name], 'behavior') + partChars(modes[name], 'replyStyle') === 0 ? ' dsp-partzero' : '') }, partBrief(modes[name]))
                        : null),
                    name === block.active
                      ? h('span', { className: 'dsp-badge dsp-badge-on' }, '当前生效')
                      : h('button', {
                          type: 'button',
                          className: 'dsp-mini',
                          onClick: () => setActive(name),
                        }, '设为当前'))),
                  h('button', {
                    type: 'button',
                    className: 'dsp-btn dsp-btn2 dsp-addmode',
                    onClick: addMode,
                  }, '+ 新增模式')),

                h('div', { className: 'dsp-editor' },
                  h('div', { className: 'dsp-row' },
                    h('div', { className: 'dsp-label' }, '模式名'),
                    h('div', { className: 'dsp-inline' },
                      h('input', {
                        className: 'dsp-input',
                        value: nameDraft,
                        onChange: (e) => setNameDraft(e.target.value),
                        onBlur: commitModeName,
                        onKeyDown: (e) => { if (e.key === 'Enter') e.currentTarget.blur() },
                      }),
                      h('button', {
                        type: 'button',
                        className: 'dsp-btn dsp-btn2',
                        onClick: () => deleteMode(modeName),
                      }, '删除模式'))),
                  h('div', { className: 'dsp-block' },
                    h('div', { className: 'dsp-label' }, '人格正文',
                      structuredMode ? h('span', { className: 'dsp-tag' }, '三段式') : null,
                      h('span', { className: 'dsp-badge' }, modeChars(modeValue) + ' 字')),
                    structuredMode
                      // ① 三段式：是谁 / 什么时候开口 / 怎么说话
                      ? h('div', null,
                          h('div', { className: 'dsp-parts' },
                            MODE_PARTS.map((part) => h('div', { className: 'dsp-part', key: part.key },
                              h('div', { className: 'dsp-part-head' },
                                h('div', { className: 'dsp-label' }, part.title,
                                  h('span', { className: 'dsp-badge' }, partChars(modeValue, part.key) + ' 字')),
                                partChars(modeValue, part.key) === 0
                                  ? h('span', { className: 'dsp-warn' }, '这格空着')
                                  : null),
                              h('div', { className: 'dsp-part-hint' }, part.hint),
                              h('textarea', {
                                className: 'dsp-textarea',
                                rows: part.rows,
                                value: partText(modeValue, part.key),
                                placeholder: part.label,
                                onChange: (e) => setModePart(part.key, e.target.value),
                              })))),

                          h('div', { className: 'dsp-block' },
                            h('div', { className: 'dsp-label' }, '备用风格',
                              h('span', { className: 'dsp-badge' }, variantList(modeValue).length + '/8 条')),
                            h('div', { className: 'dsp-part-hint' },
                              '一行一句。掷中时临时换这一次的语气（「用一两个字回」「带点讽刺」这种），跟上面的主风格不冲突。'),
                            variantList(modeValue).length === 0
                              ? h('div', { className: 'dsp-hint' }, '（还没有，点下面加一条）')
                              : variantList(modeValue).map((item, index) => h('div', { className: 'dsp-inline-wrap', key: index },
                                  h('input', {
                                    className: 'dsp-input',
                                    style: { flex: '1 1 320px' },
                                    value: item,
                                    placeholder: '一句备用说话风格',
                                    onChange: (e) => setVariantAt(index, e.target.value),
                                  }),
                                  h('button', {
                                    type: 'button',
                                    className: 'dsp-mini dsp-mini-danger',
                                    onClick: () => removeVariant(index),
                                  }, '删除'))),
                            h('button', {
                              type: 'button',
                              className: 'dsp-btn dsp-btn2 dsp-addmode',
                              onClick: addVariant,
                              disabled: variantList(modeValue).length >= 8,
                            }, '+ 加一条备用风格')),

                          h('div', { className: 'dsp-inline-wrap' },
                            h('div', { className: 'dsp-label' }, '换风格概率'),
                            h('input', {
                              type: 'range',
                              className: 'dsp-slider',
                              min: 0,
                              max: 100,
                              step: 5,
                              value: Math.round(variantChance(modeValue) * 100),
                              onChange: (e) => setModeChance(Number(e.target.value) / 100),
                            }),
                            h('span', { className: 'dsp-badge' }, pct(variantChance(modeValue))),
                            h('span', { className: 'dsp-hint' },
                              variantChance(modeValue) > 0
                                ? '每条约 ' + pct(variantChance(modeValue)) + ' 的概率临时换一条'
                                : '0 = 从不换')),
                          h('div', { className: 'dsp-addrow' },
                            h('button', { type: 'button', className: 'dsp-btn dsp-btn2', onClick: modeToPlainText, disabled: !!busy },
                              '改回一整段文字')))
                      // ② 老格式：一整段文字 + 拆成三段
                      : h('div', null,
                          h('textarea', {
                            className: 'dsp-textarea dsp-textarea-lg',
                            value: typeof modeValue === 'string' ? modeValue : '',
                            placeholder: '这个人格怎么说话、什么底线、不许做什么……',
                            onChange: (e) => setModePrompt(e.target.value),
                          }),
                          h('div', { className: 'dsp-hint' }, '这是一整段的老格式，照样能用。想拆成「是谁 / 什么时候开口 / 怎么说话」三格，点下面。'),
                          h('div', { className: 'dsp-addrow' },
                            h('button', { type: 'button', className: 'dsp-btn dsp-btn2', onClick: splitMode, disabled: !!busy },
                              busy === 'split' ? '拆分中…（要调模型）' : '拆成三段'),
                            h('span', { className: 'dsp-hint' }, '只拆原文，不编新东西；拆完先给你看，点保存才生效。')))),
                  h('div', { className: 'dsp-hint' }, '改完点最下面的「保存」。模式名改完要点一下别处（失焦）才生效。'))),

          // ── 规则 ──
          h('div', { className: 'dsp-group' }, '规则（rules）'),
          h('div', { className: 'dsp-hint' }, '键值对短规则，例如「骂人就用撒娇接」。所有人格共用，会真的拼进每个会话的提示词（跟模式正文重复的不重复加）。'),
          h('div', { className: 'dsp-rows' },
            ruleNames.length === 0
              ? h('div', { className: 'dsp-hint', style: { padding: '8px 0' } }, '（还没有规则）')
              : ruleNames.map((name) => h(RuleRow, {
                  key: name,
                  name,
                  text: rules[name] ?? '',
                  onRename: (next) => renameRule(name, next),
                  onChange: (value) => setRuleText(name, value),
                  onDelete: () => deleteRule(name),
                })),
            h('div', { className: 'dsp-addrow' },
              h('input', {
                className: 'dsp-input',
                placeholder: '新规则名，例如 骚了哄',
                value: newRuleName,
                onChange: (e) => setNewRuleName(e.target.value),
              }),
              h('button', { type: 'button', className: 'dsp-btn dsp-btn2', onClick: addRule }, '+ 添加规则'))),

          // ── 保存栏 ──
          h('div', { className: 'dsp-actions' },
            h('button', { type: 'button', className: 'dsp-btn', onClick: save, disabled: !!busy },
              busy === 'save' ? '保存中…' : '保存'),
            h('button', { type: 'button', className: 'dsp-btn dsp-btn2', onClick: reload, disabled: !!busy }, '重新读取'),
            dirty ? h('span', { className: 'dsp-dirty' }, '● 有改动还没保存（改了不点保存 = 没生效）') : null),
          msg ? h('div', { className: 'dsp-ok' }, msg) : null,
          err ? h('div', { className: 'dsp-err' }, err) : null,
          h('div', { className: 'dsp-hint', style: { marginTop: '10px' } },
            '保存前会把旧文件备份成 ',
            h('code', null, 'personas.json.bak-时间'),
            '（只留最近 20 份）。'),
        ]))
    }

    function apply(ctx) {
      ctx.effect(
        () =>
          ctx.slots.inject('settings.section', () =>
            ctx.slots.register(
              { name: 'settings.section', id: 'persona', order: 5, label: () => '身份与人设' },
              PersonaSection,
            ),
            'dsh-persona: settings section',
          ),
        'dsh-persona: settings section',
      )
    }

    return { inject: ['slots'], apply }
  },
})
