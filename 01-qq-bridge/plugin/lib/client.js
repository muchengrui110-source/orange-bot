/**
 * dsh-qq-bridge —— 客户端半边：「设置 → QQ 桥接」页
 *
 * 数据流：设置页 ⇄ 同源 fetch(`/dsh-qq-bridge/api/*`) ⇄ 宿主半边 ⇄
 *         `<DSH_HOME>\qq-bridge\settings-ui.json`（覆盖层）+ 运行中的桥接实例。
 * 保存 = 写覆盖层 + 立即热应用（改端口/模式等传输字段会自动重开 WS）。
 * 页面不改桥接的会话配置：会话映射的清除走接口（下一条消息才新建会话）。
 */
window.__ModuleLoader__.load({
  id: 'dsh-qq-bridge',
  factory(require) {
    const React = require('react')
    const { createElement: h, useCallback, useEffect, useState } = React
    const API = '/dsh-qq-bridge/api'

    const CSS = [
      '.qb{max-width:860px;color:var(--dsw-alias-label-primary);display:flex;flex-direction:column;font-size:13px;line-height:20px}',
      '.qb-title{margin:0;font-size:16px;font-weight:500;line-height:24px}',
      '.qb-intro{color:var(--dsw-alias-label-secondary);margin:4px 0 10px;font-size:13px}',
      '.qb-code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11.5px;background:color-mix(in srgb,var(--dsw-alias-label-secondary) 14%,transparent);padding:1px 5px;border-radius:4px}',
      '.qb-chips{display:flex;gap:6px;flex-wrap:wrap;margin:2px 0 6px}',
      '.qb-chip{font-size:11.5px;line-height:18px;padding:1px 9px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary)}',
      '.qb-chip-on{border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 55%,transparent);color:var(--dsw-alias-brand-primary);background:color-mix(in srgb,var(--dsw-alias-brand-primary) 12%,transparent)}',
      '.qb-chip-off{border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 45%,transparent);color:var(--dsw-alias-state-error-primary)}',
      '.qb-group{margin-top:18px;font-size:13px;font-weight:600;line-height:20px;padding-bottom:6px;border-bottom:.5px solid var(--dsw-alias-border-l1)}',
      '.qb-hint{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;margin:4px 0}',
      '.qb-rows{display:flex;flex-direction:column}',
      '.qb-row{display:flex;justify-content:space-between;align-items:flex-start;gap:10px 20px;padding:8px 0;border-bottom:.5px solid var(--dsw-alias-border-l1);flex-wrap:wrap}',
      '.qb-row:last-child{border-bottom:none}',
      '.qb-row>div:first-child{flex:1;min-width:210px}',
      '.qb-label{font-size:13px;display:flex;align-items:center;gap:8px}',
      '.qb-sub{color:var(--dsw-alias-label-secondary);font-size:11.5px;line-height:17px;margin-top:2px}',
      '.qb-input,.qb-select{background:transparent;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;color:var(--dsw-alias-label-primary);font-size:12.5px;height:30px;padding:0 9px;min-width:220px;outline:none;font-family:inherit}',
      '.qb-input:focus-visible,.qb-select:focus-visible{border-color:var(--dsw-alias-brand-primary)}',
      '.qb-input-num{min-width:130px;max-width:170px}',
      '.qb-input-wide{min-width:340px;flex:1}',
      '.qb-switch{display:flex;align-items:center;gap:8px;font-size:12.5px;color:var(--dsw-alias-label-secondary);cursor:pointer}',
      '.qb-actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:14px;padding-top:12px;border-top:.5px solid var(--dsw-alias-border-l2)}',
      '.qb-btn{background:var(--dsw-alias-brand-primary);color:#fff;border:none;border-radius:6px;font-size:12.5px;height:30px;padding:0 14px;cursor:pointer;font-family:inherit}',
      '.qb-btn:disabled{opacity:.5;cursor:default}',
      '.qb-btn2{background:transparent;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary)}',
      '.qb-mini{background:transparent;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary);border-radius:6px;font-size:11.5px;height:24px;padding:0 9px;cursor:pointer;font-family:inherit}',
      '.qb-mini-danger{color:var(--dsw-alias-state-error-primary)}',
      '.qb-dirty{color:var(--dsw-alias-state-warn-primary);font-size:12px;margin-left:2px}',
      '.qb-ok{color:var(--dsw-alias-state-success-primary);font-size:12px;line-height:18px;margin-top:8px;white-space:pre-wrap}',
      '.qb-err{color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px;margin-top:8px;white-space:pre-wrap}',
      '.qb-table{display:flex;flex-direction:column;border:.5px solid var(--dsw-alias-border-l1);border-radius:8px;overflow:hidden}',
      '.qb-tr{display:flex;gap:10px;align-items:center;padding:7px 10px;border-bottom:.5px solid var(--dsw-alias-border-l1);flex-wrap:wrap}',
      '.qb-tr:last-child{border-bottom:none}',
      '.qb-td{font-size:12px;min-width:0}',
      '.qb-td-key{font-weight:500;min-width:180px}',
      '.qb-td-mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;color:var(--dsw-alias-label-secondary);word-break:break-all;flex:1}',
      '.qb-addrow{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:8px}',
      '.qb-ws{display:flex;flex-direction:column;gap:6px;margin-top:8px}',
      '.qb-wsrow{display:flex;gap:8px;align-items:center;flex-wrap:wrap}',
      '.qb-wsrow .qb-input{min-width:230px}',
      '.qb-wsrow .qb-input-wide{min-width:360px}',
    ].join('')

    /** 会话键 → 给人看的名字。 */
    function chatLabel(key) {
      const text = String(key || '')
      const priv = /^private:(\d+)$/.exec(text)
      if (priv) {
        const qq = priv[1]
        return '私聊 ' + qq
      }
      const group = /^group:(\d+)(?::(\d+))?$/.exec(text)
      if (group) return group[2] ? '群聊 ' + group[1] + ' · QQ ' + group[2] : '群聊 ' + group[1]
      return text || '未命名会话'
    }

    const MANAGED = [
      'mode', 'host', 'port', 'path', 'url', 'accessToken', 'reconnectMs',
      'maxReplyChars', 'turnTimeoutMs', 'contextRotatePercent', 'ackEnabled', 'ackMessage',
      'privateEnabled', 'groupEnabled', 'allowlist',
      'groupRequireAt', 'groupAtReplyLimit', 'groupSharedMemory',
      'imageEnabled', 'voiceEnabled', 'imageEditEnabled', 'mediaRetentionDays',
      'stickerEnabled', 'stickerChance', 'stickerDir', 'stickerMaxPerChat',
      'wakeEnabled', 'wakeIntervalMinutes', 'wakeChance', 'wakeTargets',
      'agentPreset', 'permissionPreset', 'provider', 'model',
      'resumeOnStart', 'personaEnabled', 'personaFile', 'sessionFile',
      'workspaceRoot', 'featureFile', 'imageToolkit', 'ffmpegPath',
      'workspaceMap',
    ]

    /** 表单字段：唯一真相，加字段只改这个数组。 */
    const FIELDS = [
      { group: '传输（改这几项会自动重开 WS）', key: 'mode', label: '连接模式', kind: 'select', options: [['server', 'server（NapCat 连过来，默认）'], ['client', 'client（桥接主动连机器人）']] },
      { group: '传输（改这几项会自动重开 WS）', key: 'host', label: '监听地址', kind: 'text', hint: '只给本机用就 127.0.0.1；要让局域网里的机器人连进来填 0.0.0.0' },
      { group: '传输（改这几项会自动重开 WS）', key: 'port', label: '监听端口', kind: 'number', hint: 'NapCat 反向 WS 要填 ws://127.0.0.1:这个端口/' },
      { group: '传输（改这几项会自动重开 WS）', key: 'path', label: '允许的路径前缀', kind: 'text', hint: '“/” = 任意路径都收' },
      { group: '传输（改这几项会自动重开 WS）', key: 'url', label: 'client 模式目标地址', kind: 'text', hint: '如 ws://127.0.0.1:3001；server 模式下忽略' },
      { group: '传输（改这几项会自动重开 WS）', key: 'accessToken', label: 'access token', kind: 'text', hint: '留空 = 不改；填了就校验 Authorization: Bearer' },
      { group: '传输（改这几项会自动重开 WS）', key: 'reconnectMs', label: '断线重连间隔（毫秒）', kind: 'number', hint: '只对 client 模式有效' },

      { group: '回复', key: 'maxReplyChars', label: '单条回复字数上限', kind: 'number', hint: '超过就分段发；按句号断句优先' },
      { group: '回复', key: 'turnTimeoutMs', label: '单轮超时（毫秒）', kind: 'number', hint: '超时就把已有的部分回复发出去' },
      { group: '回复', key: 'contextRotatePercent', label: '上下文用到多少 % 后换新会话', kind: 'number', hint: '默认 40；下一条消息才换，不打断当前回复。0 = 关闭' },
      { group: '回复', key: 'ackEnabled', label: '先回一条「收到」', kind: 'switch' },
      { group: '回复', key: 'ackMessage', label: '「收到」文案', kind: 'text', hint: 'ackEnabled 打开时才发' },

      { group: '范围', key: 'privateEnabled', label: '处理私聊', kind: 'switch' },
      { group: '范围', key: 'groupEnabled', label: '处理群聊', kind: 'switch' },
      { group: '范围', key: 'allowlist', label: '只允许这些 QQ 号', kind: 'list', hint: '只填纯 QQ 号（逗号/空格分隔）；留空 = 不限制。私聊和群聊都比对发言人的 QQ 号，不是群号' },

      { group: '群聊', key: 'groupRequireAt', label: '必须 @ 机器人才回复', kind: 'switch', hint: '关掉 = 群里所有消息都处理，下面的「@ 后回复次数」也不生效' },
      { group: '群聊', key: 'groupAtReplyLimit', label: '@ 后 60 秒内最多回复条数', kind: 'number', hint: '默认 3；被 @ 的那一条也算 1 次，用完要再 @ 一次才能继续。0 = 不限制条数' },
      { group: '群聊', key: 'groupSharedMemory', label: '群记忆共享', kind: 'switch', hint: '同一群所有成员的会话共用工作区里的 群记忆.md，每条消息前自动带上' },

      { group: '媒体', key: 'imageEnabled', label: '接收图片', kind: 'switch', hint: '下载到会话工作区，agent 自己看' },
      { group: '媒体', key: 'voiceEnabled', label: '接收语音', kind: 'switch', hint: '借 NapCat 转码后交给语音识别' },
      { group: '媒体', key: 'imageEditEnabled', label: '默认开启修图', kind: 'switch', hint: '关掉 = 会话里发「修图开」才启用' },
      { group: '媒体', key: 'mediaRetentionDays', label: '媒体保留天数', kind: 'number', hint: '超期自动清 attachments/edited；0 = 不清理' },

      { group: '表情包', key: 'stickerEnabled', label: '回复附带表情包', kind: 'switch', hint: '每条真实回复按概率补一张；对方发来的表情包会自动收进库' },
      { group: '表情包', key: 'stickerChance', label: '附带概率（0~1）', kind: 'number', hint: '默认 0.4，即大约四成回复带一张；0 = 不发' },
      { group: '表情包', key: 'stickerDir', label: '表情包库目录', kind: 'text', hint: '按聊天分文件夹存；每个聊天只用自己的图，不跨聊天借' },
      { group: '表情包', key: 'stickerMaxPerChat', label: '每个聊天最多保留张数', kind: 'number', hint: '默认 200；超了自动删最旧的' },

      { group: '主动消息（定时醒来）', key: 'wakeEnabled', label: '定时醒来主动发消息', kind: 'switch', hint: '到间隔就掷一次骰子，掷中了用原来的会话生成一句话发过去；NapCat 不在线时跳过' },
      { group: '主动消息（定时醒来）', key: 'wakeIntervalMinutes', label: '间隔（分钟）', kind: 'number', hint: '默认 60；必须大于 0' },
      { group: '主动消息（定时醒来）', key: 'wakeChance', label: '醒来概率（0~1）', kind: 'number', hint: '默认 0.6；每次间隔掷一次' },
      { group: '主动消息（定时醒来）', key: 'wakeTargets', label: '发给这些 QQ 号', kind: 'list', hint: '只填纯 QQ 号，逗号分隔；留空 = 所有聊过天的私聊。一次醒来只随机挑一个人发一条（群聊永远不发）' },

      { group: 'Agent', key: 'agentPreset', label: 'Agent 预设', kind: 'text', hint: 'standard（完整工具）/ minimal（纯对话）' },
      { group: 'Agent', key: 'permissionPreset', label: '权限预设', kind: 'select', options: [['danger-full-access', 'danger-full-access（默认）'], ['workspace-write', 'workspace-write'], ['read-only', 'read-only']] },
      { group: 'Agent', key: 'provider', label: '模型提供方', kind: 'text', hint: '留空 = 跟随当前应用选择' },
      { group: 'Agent', key: 'model', label: '模型', kind: 'text', hint: '留空 = 跟随当前应用选择' },

      { group: '记忆与文件', key: 'resumeOnStart', label: '重载后接回旧会话', kind: 'switch', hint: '关掉 = 每次重载都新建会话（旧日志还在归档里）' },
      { group: '记忆与文件', key: 'personaEnabled', label: '启用多人格', kind: 'switch' },
      { group: '记忆与文件', key: 'personaFile', label: '人格文件', kind: 'text' },
      { group: '记忆与文件', key: 'sessionFile', label: '会话映射文件', kind: 'text', hint: '重启后靠它找回 QQ 会话' },
      { group: '记忆与文件', key: 'workspaceRoot', label: '默认工作区根目录', kind: 'text', hint: '没在工作区映射里列的聊天落在 <根目录>/<聊天键>' },
      { group: '记忆与文件', key: 'featureFile', label: '功能开关文件', kind: 'text' },
      { group: '记忆与文件', key: 'imageToolkit', label: '修图工具箱脚本', kind: 'text' },
      { group: '记忆与文件', key: 'ffmpegPath', label: 'ffmpeg 路径', kind: 'text', hint: '语音转码用；PATH 里有就写 ffmpeg' },
    ]

    const GROUPS = []
    for (const field of FIELDS) {
      if (!GROUPS.includes(field.group)) GROUPS.push(field.group)
    }

    const clone = (value) => JSON.parse(JSON.stringify(value ?? {}))
    const fmtTime = (ms) => {
      if (!ms) return '—'
      try { return new Date(ms).toLocaleString('zh-CN', { hour12: false }) } catch { return String(ms) }
    }
    const fmtClock = (ms) => {
      if (!ms) return '—'
      try { return new Date(ms).toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit' }) } catch { return String(ms) }
    }

    function confirmAsk(text) {
      if (typeof window === 'undefined' || typeof window.confirm !== 'function') return true
      return window.confirm(text)
    }

    /** 把状态里的配置抽成本页管理的草稿（accessToken 不回显，留空=不改）。 */
    function pickDraft(config) {
      const draft = {}
      for (const key of MANAGED) {
        if (!(key in config)) continue
        if (key === 'accessToken') { draft[key] = ''; continue }
        draft[key] = clone(config[key])
      }
      if (!draft.workspaceMap || typeof draft.workspaceMap !== 'object' || Array.isArray(draft.workspaceMap)) {
        draft.workspaceMap = {}
      }
      return draft
    }

    function Field({ field, draft, setField }) {
      const value = draft[field.key]
      const set = (next) => setField(field.key, next)
      let control
      if (field.kind === 'switch') {
        control = h('label', { className: 'qb-switch' },
          h('input', { type: 'checkbox', checked: !!value, onChange: (e) => set(e.target.checked) }),
          value ? '开' : '关')
      } else if (field.kind === 'select') {
        control = h('select', { className: 'qb-select', value: String(value ?? ''), onChange: (e) => set(e.target.value) },
          (field.options || []).map(([v, label]) => h('option', { key: v, value: v }, label)))
      } else if (field.kind === 'number') {
        control = h('input', {
          className: 'qb-input qb-input-num',
          type: 'number',
          value: value === undefined || value === null ? '' : String(value),
          onChange: (e) => set(e.target.value === '' ? '' : Number(e.target.value)),
        })
      } else if (field.kind === 'list') {
        const text = Array.isArray(value) ? value.join(', ') : String(value ?? '')
        control = h('input', {
          className: 'qb-input qb-input-wide',
          value: text,
          placeholder: '例如 10001, 10002',
          onChange: (e) => set(e.target.value.split(/[,，\s]+/).map((s) => s.trim()).filter(Boolean)),
        })
      } else {
        control = h('input', {
          className: 'qb-input qb-input-wide',
          value: String(value ?? ''),
          onChange: (e) => set(e.target.value),
        })
      }
      return h('div', { className: 'qb-row' },
        h('div', null,
          h('div', { className: 'qb-label' }, field.label),
          field.hint ? h('div', { className: 'qb-sub' }, field.hint) : null),
        control)
    }

    /** 工作区映射编辑器：聊天键 → 已建工作区的绝对目录。 */
    function WorkspaceMapEditor({ map, setMap, workspaces }) {
      const rows = Object.entries(map || {})
      const setOne = (key, path) => {
        const next = { ...(map || {}) }
        if (path.trim()) next[key] = path
        else delete next[key]
        setMap(next)
      }
      const renameKey = (oldKey, newKey) => {
        const clean = newKey.trim()
        if (!clean || clean === oldKey) return
        const next = {}
        for (const [k, v] of Object.entries(map || {})) next[k === oldKey ? clean : k] = v
        setMap(next)
      }
      return h('div', { className: 'qb-ws' },
        rows.length === 0
          ? h('div', { className: 'qb-hint' }, '（还没有映射；不映射的聊天落在「默认工作区根目录/<聊天键>」）')
          : rows.map(([key, path]) => h(KeyRow, {
              key,
              chatKey: key,
              path,
              workspaces,
              onRename: (nextKey) => renameKey(key, nextKey),
              onPath: (nextPath) => setOne(key, nextPath),
              onDelete: () => {
                if (!confirmAsk(`删掉「${key}」的工作区映射？只影响之后新建的会话。`)) return
                setOne(key, '')
              },
            })),
        h('div', { className: 'qb-addrow' },
          h('button', {
            type: 'button',
            className: 'qb-btn qb-btn2',
            onClick: () => setMap({ ...(map || {}), [`private:${Date.now()}`]: '' }),
          }, '+ 加一条映射')))
    }

    /** 一条映射：键 + 路径（路径可以从已登记工作区里选）。 */
    function KeyRow({ chatKey, path, workspaces, onRename, onPath, onDelete }) {
      const [keyDraft, setKeyDraft] = useState(chatKey)
      useEffect(() => { setKeyDraft(chatKey) }, [chatKey])
      return h('div', { className: 'qb-wsrow' },
        h('input', {
          className: 'qb-input',
          style: { minWidth: '200px' },
          value: keyDraft,
          placeholder: '聊天键，例如 private:10001',
          onChange: (e) => setKeyDraft(e.target.value),
          onBlur: () => {
            const next = keyDraft.trim()
            if (next && next !== chatKey) onRename(next)
            else setKeyDraft(chatKey)
          },
          onKeyDown: (e) => { if (e.key === 'Enter') e.currentTarget.blur() },
        }),
        h('select', {
          className: 'qb-select',
          style: { minWidth: '180px' },
          value: '',
          onChange: (e) => { if (e.target.value) onPath(e.target.value) },
        },
          h('option', { value: '' }, '（选一个已登记工作区）'),
          (workspaces || []).map((ws) => h('option', { key: ws.id, value: ws.path }, ws.title + ' — ' + ws.path))),
        h('input', {
          className: 'qb-input qb-input-wide',
          value: path || '',
          placeholder: '工作区绝对路径',
          onChange: (e) => onPath(e.target.value),
        }),
        h('button', { type: 'button', className: 'qb-mini qb-mini-danger', onClick: onDelete }, '删除'))
    }

    function QqBridgeSection() {
      const [state, setState] = useState(null)
      const [draft, setDraft] = useState(null)
      const [savedJson, setSavedJson] = useState('')
      const [mtimeMs, setMtimeMs] = useState(0)
      const [err, setErr] = useState('')
      const [msg, setMsg] = useState('')
      const [busy, setBusy] = useState('')
      const [napcat, setNapcat] = useState(null)

      const load = useCallback(async () => {
        setErr('')
        setMsg('')
        try {
          const r = await fetch(API + '/state', { headers: { accept: 'application/json' } })
          const j = await r.json().catch(() => ({}))
          if (!r.ok || j.ok === false) throw new Error(j.error || 'HTTP ' + r.status)
          const d = pickDraft(j.config ?? {})
          setState(j)
          setDraft(d)
          setSavedJson(JSON.stringify(d))
          setMtimeMs(j.settingsMtimeMs ?? 0)
        } catch (e) {
          setErr('读取失败：' + e.message)
        }
      }, [])

      useEffect(() => { load() }, [load])

      const dirty = !!draft && savedJson !== '' && JSON.stringify(draft) !== savedJson

      const setField = useCallback((key, value) => {
        setDraft((current) => (current ? { ...current, [key]: value } : current))
      }, [])

      const post = async (path, body) => {
        const r = await fetch(API + path, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: body ? JSON.stringify(body) : '{}',
        })
        const j = await r.json().catch(() => ({}))
        if (!r.ok || j.ok === false) throw new Error((j.error || 'HTTP ' + r.status) + (r.status === 409 ? '（先点「重新读取」再改）' : ''))
        return j
      }

      const save = async () => {
        if (!draft) return
        setBusy('save')
        setErr('')
        setMsg('')
        const payload = {}
        for (const key of MANAGED) {
          if (!(key in draft)) continue
          if (key === 'accessToken' && !String(draft[key] ?? '').trim()) continue // 留空 = 不改
          payload[key] = draft[key]
        }
        try {
          const j = await post('/settings', { config: payload, baseMtimeMs: mtimeMs })
          setState((current) => (current ? { ...current, config: j.config, settingsMtimeMs: j.settingsMtimeMs } : current))
          const nextDraft = pickDraft(j.config ?? {})
          setDraft(nextDraft)
          setSavedJson(JSON.stringify(nextDraft))
          setMtimeMs(j.settingsMtimeMs ?? 0)
          setMsg('✓ 已保存并生效' + (j.transportChanged ? '（传输已按新配置重开）' : '') + (j.backup ? '（旧文件已备份）' : ''))
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

      const transport = async (action, label) => {
        setBusy(action)
        setErr('')
        setMsg('')
        try {
          await post('/transport/' + action)
          setMsg('✓ ' + label)
          await load()
        } catch (e) {
          setErr(label + '失败：' + e.message)
        } finally {
          setBusy('')
        }
      }

      const queryNapcat = async () => {
        setBusy('napcat')
        setNapcat(null)
        try {
          const r = await fetch(API + '/napcat', { headers: { accept: 'application/json' } })
          const j = await r.json().catch(() => ({}))
          setNapcat(j)
        } catch (e) {
          setNapcat({ ok: false, error: e.message })
        } finally {
          setBusy('')
        }
      }

      const clearSession = async (chatKey) => {
        if (!confirmAsk(`清掉「${chatLabel(chatKey)}」的会话映射？\n下一条 QQ 消息会在当前映射的工作区里新建会话；旧会话日志还在 DSH 归档里。`)) return
        setBusy('clear:' + chatKey)
        setErr('')
        setMsg('')
        try {
          await post('/sessions/clear', { chatKey })
          setMsg(`✓ 已清除「${chatLabel(chatKey)}」的会话映射，下一条消息会新建会话`)
          await load()
        } catch (e) {
          setErr('清除失败：' + e.message)
        } finally {
          setBusy('')
        }
      }

      const head = (children) => [h('style', null, CSS), h('h3', { className: 'qb-title' }, 'QQ 桥接'), ...children]

      if (!state || !draft) {
        return h('div', { className: 'qb' }, ...head([err ? h('div', { className: 'qb-err' }, err) : h('div', { className: 'qb-hint' }, '读取中…')]))
      }

      const runtime = state.runtime || {}
      const sessions = runtime.sessions || {}
      const chatRows = []
      const seen = new Set()
      for (const item of runtime.chats || []) {
        seen.add(item.chatKey)
        chatRows.push({ chatKey: item.chatKey, sessionId: item.sessionId, workspace: item.workspace, live: true })
      }
      for (const [chatKey, record] of Object.entries(sessions)) {
        if (seen.has(chatKey)) continue
        chatRows.push({ chatKey, sessionId: record?.sessionId ?? '', workspace: '', live: false })
      }

      return h('div', { className: 'qb' },
        ...head([
          h('p', { className: 'qb-intro' },
            'QQ 私聊/群聊交给 agent 自动回。设置存在 ',
            h('code', { className: 'qb-code' }, state.settingsFile || 'settings-ui.json'),
            '，保存后立即生效；改传输字段会自动重开 WS，不用重启 DSH。'),
          h('div', { className: 'qb-chips' },
            h('span', { className: 'qb-chip ' + (runtime.paused ? 'qb-chip-off' : (runtime.listening ? 'qb-chip-on' : '')) },
              runtime.paused ? '已暂停' : (runtime.listening ? '运行中' : (runtime.transport === 'client' ? 'client 模式' : '未监听'))),
            h('span', { className: 'qb-chip' }, 'OneBot 连接 ' + (runtime.sockets ?? 0)),
            h('span', { className: 'qb-chip' }, runtime.transport === 'server'
              ? `server ${state.config?.host ?? ''}:${state.config?.port ?? ''}`
              : ('client ' + (state.config?.url || '（未填 url）'))),
            h('span', { className: 'qb-chip' }, '启动于 ' + fmtTime(Date.parse(runtime.startedAt || ''))),
            h('span', { className: 'qb-chip' }, '语音识别 ' + (runtime.speechToText ? '✓' : '✗')),
            h('span', { className: 'qb-chip' }, '表情包 ' + ((runtime.stickers && runtime.stickers.total) || 0) + ' 张'),
            runtime.wake && runtime.wake.enabled
              ? h('span', { className: 'qb-chip' }, '主动消息 ' + (runtime.wake.nextCheckAt ? '下次 ' + fmtClock(runtime.wake.nextCheckAt) : '未排期'))
              : null,
            runtime.settingsError ? h('span', { className: 'qb-chip qb-chip-off' }, runtime.settingsError) : null),

          h('div', { className: 'qb-actions' },
            h('button', { type: 'button', className: 'qb-btn', onClick: () => transport(runtime.paused ? 'resume' : 'pause', runtime.paused ? '已恢复桥接' : '已暂停桥接'), disabled: !!busy },
              busy === 'pause' || busy === 'resume' ? '处理中…' : (runtime.paused ? '恢复桥接' : '暂停桥接')),
            h('button', { type: 'button', className: 'qb-btn qb-btn2', onClick: () => transport('restart', '已重开 WS'), disabled: !!busy }, busy === 'restart' ? '重开中…' : '重启 WS'),
            h('button', { type: 'button', className: 'qb-btn qb-btn2', onClick: queryNapcat, disabled: !!busy }, busy === 'napcat' ? '查询中…' : '查询 NapCat 账号'),
            napcat ? h('span', { className: napcat.ok ? 'qb-ok' : 'qb-err' },
              napcat.ok ? `✓ ${napcat.nickname}（${napcat.userId}）` : ('✗ ' + napcat.error)) : null),

          // ── 会话 ──
          h('div', { className: 'qb-group' }, 'QQ 会话（会话 id ↔ 工作区）'),
          h('div', { className: 'qb-hint' }, '会话的 cwd 是创建时写死的：要换工作区，先改下面的「工作区映射」，再点这一行的「清除映射」，下一条消息才会在新目录新建会话（旧日志留在归档里）。'),
          h('div', { className: 'qb-table' },
            chatRows.length === 0
              ? h('div', { className: 'qb-tr' }, h('div', { className: 'qb-td qb-hint' }, '（还没有会话；有 QQ 消息进来才会建）'))
              : chatRows.map((row) => h('div', { className: 'qb-tr', key: row.chatKey },
                  h('div', { className: 'qb-td qb-td-key' }, chatLabel(row.chatKey)),
                  h('div', { className: 'qb-td qb-td-mono' },
                    (row.sessionId || '（无）') + (row.workspace ? '  ·  ' + row.workspace : '') + (row.live ? '  ·  已加载' : '')),
                  h('button', { type: 'button', className: 'qb-mini qb-mini-danger', onClick: () => clearSession(row.chatKey), disabled: !!busy }, '清除映射')))),

          // ── 工作区映射 ──
          h('div', { className: 'qb-group' }, '工作区映射（某个聊天直接落进已建好的工作区）'),
          h('div', { className: 'qb-hint' }, '没列在这里的聊天，落在「默认工作区根目录/<聊天键>」。'),
          h(WorkspaceMapEditor, {
            map: draft.workspaceMap || {},
            workspaces: runtime.workspaces || [],
            setMap: (next) => setField('workspaceMap', next),
          }),

          // ── 配置字段 ──
          ...GROUPS.map((group) => h('div', null,
            h('div', { className: 'qb-group' }, group),
            h('div', { className: 'qb-rows' },
              FIELDS.filter((f) => f.group === group).map((field) => h(Field, {
                key: field.key, field, draft, setField,
              }))))),

          // ── 保存栏 ──
          h('div', { className: 'qb-actions' },
            h('button', { type: 'button', className: 'qb-btn', onClick: save, disabled: !!busy }, busy === 'save' ? '保存中…' : '保存'),
            h('button', { type: 'button', className: 'qb-btn qb-btn2', onClick: reload, disabled: !!busy }, '重新读取'),
            dirty ? h('span', { className: 'qb-dirty' }, '● 有改动还没保存') : null),
          msg ? h('div', { className: 'qb-ok' }, msg) : null,
          err ? h('div', { className: 'qb-err' }, err) : null,
          h('div', { className: 'qb-hint', style: { marginTop: '10px' } },
            '想彻底关掉这个插件：侧栏「插件」里关掉 qq-bridge 这一行；这里的「暂停桥接」只是断开 WS，会话和配置都保留。'),
        ]))
    }

    function apply(ctx) {
      ctx.effect(
        () => ctx.slots.inject('settings.section', () => ctx.slots.register(
          { name: 'settings.section', id: 'qq-bridge', order: 7, label: () => 'QQ 桥接' },
          QqBridgeSection,
        ), 'dsh-qq-bridge: settings section'),
        'dsh-qq-bridge: settings section',
      )
    }

    return { inject: ['slots'], apply, QqBridgeSection }
  },
})
