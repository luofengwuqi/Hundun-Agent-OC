<script setup>
/**
 * 馄饨Agent-OC 的前端。
 *
 * 视觉体系来自 /home/wuqi/code/hundunAgent（D025）：奶油白 + 朱红、左侧窄图标栏、
 * AI 回复不用气泡（像日记不像聊天工具）。**只复用视觉，不复用它的数据通路**——
 * 那个项目直连模型 API，这里连的是本地 Gateway。
 *
 * 对话走主进程的 `chat:send`：渲染层不该知道 token 和端口，也不该自己去连 HTTP。
 */
import { ref, computed, onMounted, onBeforeUnmount, nextTick } from 'vue'

// logo 的唯一源是 public/logo.svg，构建时原样拷进 dist/renderer/。
// 走变量而不是字面量：窗口用 file:// 加载，相对路径按当前文档解析才对。
const LOGO = './logo.svg'

const state = ref({
  status: 'booting',
  port: null,
  pid: null,
  adopted: false,
  notice: null,
  memoryDir: null,
  dataDir: null,
  model: { ref: null, keyPresent: false },
  failure: null
})
const logs = ref([])
const view = ref('chat')
const restarting = ref(false)
const toast = ref('')
const scroller = ref(null)

/**
 * 对话历史。**这份就是发给模型的全部上下文**——不额外维护一份「主进程版」，
 * 免得界面显示的和实际发出去的悄悄分叉。
 */
const turns = ref([])
const draft = ref('')
const sending = ref(false)
const chatError = ref('')

/** 能不能说话：引擎就绪 + 有模型 + 有密钥。缺哪一样要说清是哪一样。 */
const canSend = computed(
  () => state.value.status === 'ready' && Boolean(state.value.model?.ref) && Boolean(state.value.model?.keyPresent)
)

const blockedReason = computed(() => {
  if (state.value.status !== 'ready') return '引擎还没起来。'
  if (!state.value.model?.ref) return '还没配模型。设置页填一个 API Key 就会自动配好。'
  if (!state.value.model?.keyPresent) return '还缺 API Key，设置页里填一下。'
  return ''
})

const STATUS_LABEL = {
  booting: '正在准备',
  starting: '正在启动引擎',
  ready: '已经在这里了',
  failed: '没能起来',
  stopped: '已停止'
}

const statusLabel = computed(() => STATUS_LABEL[state.value.status] || state.value.status)

const engineMeta = computed(() => {
  const bits = []
  if (state.value.port) bits.push(`端口 ${state.value.port}`)
  if (state.value.pid) bits.push(`进程 ${state.value.pid}`)
  if (state.value.adopted) bits.push('接管了上次的实例')
  return bits.join(' · ')
})

/** 开场那句话随真实状态变。不写死，否则引擎挂了界面上还在说「已经起来了」。 */
const opening = computed(() => {
  const s = state.value
  if (s.status === 'booting' || s.status === 'starting') {
    return { lead: '正在把它叫起来。', lines: ['引擎启动要十几秒，第一次会久一点。'] }
  }
  if (s.status === 'failed') {
    return {
      lead: '它没能起来。',
      lines: [
        s.failure?.userMessage || '引擎启动失败。',
        ...(s.failure?.detail ? [s.failure.detail] : []),
        '设置页里能看到完整日志。'
      ]
    }
  }
  if (s.status === 'stopped') {
    return { lead: '它停下了。', lines: ['可以在这里重新叫它起来。'] }
  }
  if (blockedReason.value) {
    return {
      lead: '我已经在这儿了。',
      lines: [blockedReason.value, '引擎跑在端口 ' + (s.port ?? '—') + '。']
    }
  }
  return {
    lead: '我已经在这儿了。',
    lines: ['说点什么吧。想说什么都行，没什么可说的也可以只发一个标点。']
  }
})

let timer = null

async function refresh() {
  try {
    const s = await window.shellApi.getState()
    applyState(s)
    if (Array.isArray(s.logs)) logs.value = s.logs
  } catch {
    // IPC 断了也不至于让界面停在旧状态：状态点退回「没能起来」
    state.value = { ...state.value, status: 'failed' }
  }
}

function applyState(s) {
  if (!s) return
  const { logs: _ignored, ...rest } = s
  state.value = { ...state.value, ...rest }
}

function flash(message) {
  toast.value = message
  window.clearTimeout(flash._t)
  flash._t = window.setTimeout(() => (toast.value = ''), 2200)
}

async function restart() {
  if (restarting.value) return
  restarting.value = true
  try {
    applyState(await window.shellApi.restartEngine())
    flash('已重新叫起来')
  } catch (error) {
    flash('重启失败：' + (error?.message || error))
  } finally {
    restarting.value = false
  }
}

async function openMemory() {
  const p = await window.shellApi.openMemoryDir()
  flash('已打开 ' + p)
}

async function openWorkspace() {
  await window.shellApi.openWorkspace()
  flash('已打开人格目录')
}

async function openData() {
  await window.shellApi.openDataDir()
  flash('已打开应用数据目录')
}

/** 开发者选项：重置记忆（D029）。确认在主进程系统弹窗里，取消就是 canceled。 */
const resettingMemory = ref(false)
async function devResetMemory() {
  if (resettingMemory.value) return
  resettingMemory.value = true
  try {
    const r = await window.shellApi.devResetMemory()
    if (r.canceled) return
    if (!r.ok) {
      flash('重置失败：' + (r.error || '未知错误'))
      return
    }
    // 记忆没了、会话 key 换了：界面这边也清空，回到第一次见面的样子。
    turns.value = []
    draft.value = ''
    chatError.value = ''
    view.value = 'chat'
    flash('记忆已清空，下次见面会重新认识你；备份在 ' + (r.backupDir || '应用数据目录'))
  } catch (error) {
    flash('重置失败：' + (error?.message || error))
  } finally {
    resettingMemory.value = false
  }
}

const minimize = () => window.shellApi.winMinimize()
const closeWin = () => window.shellApi.winClose()

function scrollToEnd() {
  nextTick(() => {
    if (scroller.value) scroller.value.scrollTop = scroller.value.scrollHeight
  })
}

/**
 * 发一句话。
 *
 * 历史一起发上去（不靠引擎侧记住上下文）：这样「清空对话」只是清这里，
 * 不会出现界面空了、模型还记着上一段的情况。
 * 记忆的连续性由会话 key 保证——那是另一层，见 main.ts 的 SESSION_KEY。
 */
async function send() {
  const text = draft.value.trim()
  if (text.length === 0 || sending.value) return
  if (!canSend.value) {
    flash(blockedReason.value || '还不能说话')
    return
  }

  chatError.value = ''
  draft.value = ''
  turns.value.push({ role: 'user', content: text })
  // 先占一个空的助手位，流式片段往它身上追加，用户能立刻看到字在往外冒
  turns.value.push({ role: 'assistant', content: '' })
  sending.value = true
  scrollToEnd()

  try {
    const result = await window.shellApi.sendChat(
      turns.value.map((t) => ({ role: t.role, content: t.content })).slice(0, -1)
    )
    if (result.ok) {
      // 用最终结果对齐一次：流式拼接可能因为丢块而不完整
      turns.value[turns.value.length - 1].content = result.text
    } else {
      turns.value.pop() // 丢掉空的助手位
      chatError.value = result.message
      if (result.kind === 'auth') {
        chatError.value += '（设置页填 API Key）'
      }
    }
  } catch (error) {
    turns.value.pop()
    chatError.value = String(error?.message || error)
  } finally {
    sending.value = false
    scrollToEnd()
  }
}

function onKeydown(event) {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault()
    void send()
  }
}

function stop() {
  window.shellApi.abortChat()
}

/* ── 模型配置（D028）──
 * 一份 opencode 式 JSON 是唯一源：导入/手写 → 预览 → 应用。
 * 卡片从上到下就是尝试顺序，排第一的先用。
 */
const modelText = ref('')
const modelPreview = ref(null) // { ok, errors, warnings, providers, selected, chain }
const showJson = ref(false)
const applying = ref(false)
const applyMsg = ref('')
const applyKind = ref('')

function runPreview() {
  if (!modelText.value.trim()) {
    modelPreview.value = null
    return
  }
  window.shellApi.previewModel(modelText.value).then((r) => {
    modelPreview.value = r
    // claude 式配置：主进程已经转好了中间格式。提示一句，
    // 并且自动把编辑器换成转换结果——否则卡片链操作（排序/增删）无从下手。
    if (r.format === 'claude' && r.converted) {
      const next = JSON.stringify(r.converted, null, 2)
      if (modelText.value !== next) {
        modelText.value = next
        applyMsg.value = '识别为 Claude Code 配置，已转成可排序的中间格式'
        applyKind.value = 'ok'
      }
    }
  })
}

const chain = computed(() => modelPreview.value?.chain || [])
const candidates = computed(() => {
  const used = new Set(chain.value.map((m) => m.providerId + '/' + m.modelId))
  const out = []
  for (const p of modelPreview.value?.providers || []) {
    const rest = p.models.filter((m) => !used.has(p.id + '/' + m.id))
    if (rest.length) out.push({ id: p.id, name: p.name, models: rest })
  }
  return out
})
const refOf = (m) => m.providerId + '/' + m.modelId
const fmtCtx = (n) => (n >= 1000 ? Math.round(n / 1000) + 'k' : String(n))

async function editChain(op, ref, extra = {}) {
  let obj
  try {
    obj = JSON.parse(modelText.value)
  } catch {
    applyMsg.value = 'JSON 有语法错误，先把「手写 JSON」里的改对'
    applyKind.value = 'bad'
    return
  }
  const r = await window.shellApi.editModel({ config: obj, op, ref, ...extra })
  if (!r.ok) {
    applyMsg.value = r.error || '改不动'
    applyKind.value = 'bad'
    return
  }
  modelText.value = JSON.stringify(r.config, null, 2)
  runPreview()
  if (modelPreview.value?.ok) await applyModel(true)
}

const setHead = (m) => editChain('move', refOf(m), { to: 0 })
const moveUp = (m, i) => editChain('move', refOf(m), { to: i - 1 })
const moveDown = (m, i) => editChain('move', refOf(m), { to: i + 1 })
const drop = (m) => editChain('remove', refOf(m))
const addOne = (p, m) => editChain('add', p.id + '/' + m.id)

async function importFile() {
  const r = await window.shellApi.pickModelFile()
  if (!r || r.canceled) return
  if (!r.ok) {
    applyMsg.value = r.error || '读不了'
    applyKind.value = 'bad'
    return
  }
  modelText.value = r.text
  showJson.value = true
  applyMsg.value = ''
  applyKind.value = ''
  runPreview()
}

/**
 * 去该地址拉真实模型列表。claude 式配置不带列表（列表在服务端），
 * 拉到就整份换掉 provider 的 models——顺序规则见 setProviderModels。
 */
const probing = ref(false)
async function probeList() {
  if (!modelText.value.trim() || probing.value) return
  probing.value = true
  applyMsg.value = '正在拉取模型列表…'
  applyKind.value = ''
  try {
    let obj
    try {
      obj = JSON.parse(modelText.value)
    } catch {
      applyMsg.value = 'JSON 有语法错误，先改对再拉'
      applyKind.value = 'bad'
      return
    }
    const pid = modelPreview.value?.providers?.[0]?.id
    const r = await window.shellApi.probeModel({ config: obj, providerId: pid })
    if (!r.ok) {
      applyMsg.value = r.error || '拉取失败'
      applyKind.value = 'bad'
      return
    }
    const e = await window.shellApi.editModel({ config: obj, op: 'setModels', ref: r.providerId, models: r.models })
    if (!e.ok) {
      applyMsg.value = e.error || '写回配置失败'
      applyKind.value = 'bad'
      return
    }
    modelText.value = JSON.stringify(e.config, null, 2)
    runPreview()
    applyMsg.value = `拉到 ${r.models.length} 个模型`
    applyKind.value = 'ok'
  } finally {
    probing.value = false
  }
}

function formatJson() {
  try {
    modelText.value = JSON.stringify(JSON.parse(modelText.value), null, 2)
  } catch (e) {
    applyMsg.value = 'JSON 语法错误：' + e.message
    applyKind.value = 'bad'
  }
}

async function applyModel(silent = false) {
  applying.value = true
  if (!silent) {
    applyMsg.value = ''
    applyKind.value = ''
  }
  const r = await window.shellApi.applyModel(modelText.value)
  applying.value = false
  if (!r.ok) {
    applyMsg.value = (r.errors || ['应用失败']).join('；')
    applyKind.value = 'bad'
    return
  }
  if (r.cfg) applyState(r.cfg)
  const n = (r.warnings || []).length
  if (!silent) {
    applyMsg.value = n ? `已应用，有 ${n} 条提醒` : '已应用'
    applyKind.value = n ? 'warn' : 'ok'
  }
}

/**
 * 反向加载：引擎里已经配好的模型，重启后编辑器是空的，卡片链会丢。
 * 这里把引擎的 models.providers 反推成一份等价的 opencode JSON 填回编辑器，
 * 卡片链就能正常显示。密钥用 ${env:OPENCLAW_<ID>_API_KEY} 占位符（不碰明文），
 * 反正 apply 时这两个来源是幂等的。
 */
async function loadSavedModel() {
  try {
    const r = await window.shellApi.currentModel()
    if (!r || !r.ok || !r.providers || !r.providers.length) return
    const provider = {}
    const order = []
    for (const p of r.providers) {
      const models = {}
      for (const m of p.models) {
        // context/output 都要随行还原：只还原 context 的话，输出上限会在
        // 「重启 → 反向加载 → 再 apply」这一趟里被悄悄洗成缺省值。
        const limit = {}
        if (m.context > 0) limit.context = m.context
        if (m.output > 0) limit.output = m.output
        models[m.id] = Object.keys(limit).length ? { name: m.name, limit } : { name: m.name }
      }
      const options = { baseURL: p.baseUrl }
      // 用保存时的真实插值名还原 {env:...}：猜出来的名字会让密钥引用指错环境变量。
      if (p.hasKey) options.apiKey = `{env:${p.envName || 'OPENCLAW_' + String(p.id).toUpperCase().replace(/[^A-Z0-9_]/g, '_') + '_API_KEY'}}`
      provider[p.id] = { name: p.name, api: p.api, options, models }
      order.push(p.id + '/' + (p.models[0]?.id || ''))
    }
    const obj = { provider, model: r.primaryRef || order[0] || '', 'x-hundun': { modelOrder: order } }
    modelText.value = JSON.stringify(obj, null, 2)
    runPreview()
  } catch {
    /* 反向加载失败不影响主流程：编辑器留空，用户可手动导入 */
  }
}

onMounted(async () => {
  window.shellApi.onState((s) => applyState(s))
  window.shellApi.onLog((line) => {
    logs.value.push(line)
    if (logs.value.length > 300) logs.value.shift()
  })
  // 流式片段：往最后一个助手位上追加。不重新赋值数组，避免整列重绘
  window.shellApi.onChunk((delta) => {
    const last = turns.value[turns.value.length - 1]
    if (!last || last.role !== 'assistant') return
    last.content += delta
    scrollToEnd()
  })
  await refresh()
  await loadSavedModel()
  // 兜底轮询：IPC 事件丢了也不至于界面永远停在旧状态
  timer = window.setInterval(refresh, 3000)
})

onBeforeUnmount(() => {
  if (timer) window.clearInterval(timer)
  window.clearTimeout(flash._t)
})
</script>

<template>
  <div class="shell">
    <header class="titlebar">
      <div class="brand">
        <img class="mark" :src="LOGO" alt="" draggable="false" />
        <span>馄饨</span>
        <small>记得你说过什么</small>
      </div>
      <div class="spacer" />

      <button class="tbtn icon" title="打开记忆目录" @click="openMemory">
        <svg
          viewBox="0 0 24 24"
          width="15"
          height="15"
          fill="none"
          stroke="currentColor"
          stroke-width="1.7"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <path
            d="M3 7.6A1.6 1.6 0 0 1 4.6 6h3.9l1.9 2.1h7.9A1.6 1.6 0 0 1 20 9.7v7.7a1.6 1.6 0 0 1-1.7 1.6H4.6A1.6 1.6 0 0 1 3 17.4z"
          />
        </svg>
      </button>
      <button class="tbtn win" title="最小化" @click="minimize">—</button>
      <button class="tbtn win close" title="关闭" @click="closeWin">✕</button>
    </header>

    <div class="body">
      <nav class="rail">
        <button
          class="rail-item"
          :class="{ on: view === 'chat' }"
          title="对话"
          @click="view = 'chat'"
        >
          <svg
            viewBox="0 0 24 24"
            width="18"
            height="18"
            fill="none"
            stroke="currentColor"
            stroke-width="1.6"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <path
              d="M21 11.5a8.4 8.4 0 0 1-9 8.4 9.9 9.9 0 0 1-3.4-.6L4 21l1.4-4A8.2 8.2 0 0 1 3.6 11 8.4 8.4 0 0 1 12 3a8.4 8.4 0 0 1 9 8.5z"
            />
          </svg>
          <span>对话</span>
        </button>
        <button
          class="rail-item"
          :class="{ on: view === 'settings' }"
          title="设置"
          @click="view = 'settings'"
        >
          <svg
            viewBox="0 0 24 24"
            width="18"
            height="18"
            fill="none"
            stroke="currentColor"
            stroke-width="1.6"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <circle cx="12" cy="12" r="3.4" />
            <path d="M12 2.8v2.6M12 18.6v2.6M21.2 12h-2.6M5.4 12H2.8" />
            <path d="M18.5 5.5l-1.9 1.9M7.4 16.6l-1.9 1.9M18.5 18.5l-1.9-1.9M7.4 7.4L5.5 5.5" />
          </svg>
          <span>设置</span>
        </button>
        <button
          class="rail-item"
          :class="{ on: view === 'dev' }"
          title="开发者"
          @click="view = 'dev'"
        >
          <svg
            viewBox="0 0 24 24"
            width="18"
            height="18"
            fill="none"
            stroke="currentColor"
            stroke-width="1.6"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <path d="M8 9l-4 3 4 3M16 9l4 3-4 3M13.5 6l-3 12" />
          </svg>
          <span>开发者</span>
        </button>
      </nav>

      <section v-show="view === 'chat'" class="chat-col">
        <div ref="scroller" class="messages">
          <div class="hx-day">今天</div>

          <div v-if="turns.length === 0" class="msg">
            <div class="avatar">
              <img :src="LOGO" alt="馄饨" draggable="false" />
            </div>
            <div class="content hx-opening">
              <p class="hx-lead">{{ opening.lead }}</p>
              <p v-for="(line, i) in opening.lines" :key="i">{{ line }}</p>
              <p v-if="engineMeta" class="hx-meta">{{ engineMeta }}</p>
            </div>
          </div>

          <template v-for="(turn, i) in turns" :key="i">
            <!-- 用户说的话靠右，用气泡；它说的话不用气泡（像日记不像聊天工具） -->
            <div v-if="turn.role === 'user'" class="msg me">
              <div class="content">
                <div class="bubble">{{ turn.content }}</div>
              </div>
            </div>
            <div v-else class="msg">
              <div class="avatar">
                <img :src="LOGO" alt="馄饨" draggable="false" />
              </div>
              <div class="content hx-reply">
                <p v-if="turn.content.length === 0" class="hx-typing">…</p>
                <p v-else>{{ turn.content }}</p>
              </div>
            </div>
          </template>

          <div v-if="chatError" class="notice bad">{{ chatError }}</div>
          <div v-if="state.notice" class="notice">{{ state.notice }}</div>
        </div>

        <div class="composer">
          <div class="composer-inner">
            <textarea
              v-model="draft"
              rows="1"
              :disabled="!canSend || sending"
              :placeholder="canSend ? '说点什么…' : blockedReason"
              spellcheck="false"
              @keydown="onKeydown"
            />
            <button v-if="sending" class="send" title="停下" @click="stop">停</button>
            <button v-else class="send" :disabled="!canSend || draft.trim().length === 0" @click="send">
              说
            </button>
          </div>
          <div class="hint">
            <span>Enter 发送 · Shift+Enter 换行</span>
            <span class="hx-status" :class="state.status">
              <i class="hx-dot" />{{ statusLabel }}
            </span>
          </div>
        </div>
      </section>

      <section v-show="view === 'settings'" class="hx-set">
        <h2 class="hx-set-title">设置</h2>

        <div class="hx-block">
          <div class="hx-block-head">
            <span class="hx-block-title">陪伴引擎</span>
            <span class="hx-chip" :class="state.status">{{ statusLabel }}</span>
          </div>
          <div class="hx-kv">
            <span>端口</span><code>{{ state.port ?? '—' }}</code>
          </div>
          <div class="hx-kv">
            <span>进程</span><code>{{ state.pid ?? '—' }}</code>
          </div>
          <div class="hx-kv">
            <span>记忆目录</span><code class="hx-path">{{ state.memoryDir ?? '—' }}</code>
          </div>
          <div class="hx-row">
            <button class="hx-btn" :disabled="restarting" @click="restart">
              {{ restarting ? '正在重启…' : '重新叫起来' }}
            </button>
            <button class="hx-btn" @click="openMemory">打开记忆目录</button>
            <button class="hx-btn" @click="openWorkspace">打开人格目录</button>
          </div>
          <p class="hx-note">
            记忆、人格和配置都在记忆目录里。它不在安装目录下，所以卸载软件不会带走它——
            换机器时把整个文件夹拷过去就行。
          </p>
        </div>

        <div class="hx-block">
          <div class="hx-block-head">
            <span class="hx-block-title">模型</span>
            <span class="hx-chip" :class="canSend ? 'ready' : 'off'">
              {{ canSend ? '可以说话' : '还没配模型' }}
            </span>
          </div>

          <p class="hx-note">
            把一份配置贴进来或导进来，软件会自己认出有哪些模型、现在用哪个。
            支持 opencode 式 JSON（key 写成 <code>{'{env:名字}'}</code> 不存明文），
            也认 Claude Code 的 settings.json（env 里带 ANTHROPIC_* 的那种）。
          </p>

          <!-- 解析结果 -->
          <div v-if="modelPreview && (modelPreview.errors?.length || modelPreview.warnings?.length)" class="hx-parse">
            <div v-if="modelPreview.errors?.length" class="hx-parse-line bad">
              <span class="hx-pmark">×</span>
              <div><div v-for="(e, i) in modelPreview.errors" :key="'e' + i">{{ e }}</div></div>
            </div>
            <div v-if="modelPreview.warnings?.length" class="hx-parse-line warn">
              <span class="hx-pmark">!</span>
              <div><div v-for="(w, i) in modelPreview.warnings" :key="'w' + i">{{ w }}</div></div>
            </div>
          </div>

          <!-- 卡片链：排第一的先用 -->
          <div v-if="chain.length" class="hx-mchain">
            <div
              v-for="(m, i) in chain"
              :key="refOf(m)"
              class="hx-mcard"
              :class="{ head: i === 0 }"
            >
              <span class="hx-mrank">{{ i + 1 }}</span>
              <div class="hx-mmain">
                <div class="hx-mline">
                  <span class="hx-mname">{{ m.modelName }}</span>
                  <span v-if="i === 0" class="hx-mtag">先用这个</span>
                  <span v-else class="hx-mtag alt">备用</span>
                </div>
                <div class="hx-msub">
                  {{ m.providerName }}<span v-if="m.modelId !== m.modelName"> · {{ m.modelId }}</span
                  ><span v-if="m.contextWindow"> · {{ fmtCtx(m.contextWindow) }}</span>
                </div>
                <div class="hx-murl">{{ m.baseUrl }}</div>
              </div>
              <div class="hx-mops">
                <button v-if="i > 0" class="hx-mop" title="设为先用" @click="setHead(m)">先用</button>
                <button v-if="i > 0" class="hx-mop" title="上移" @click="moveUp(m, i)">↑</button>
                <button v-if="i < chain.length - 1" class="hx-mop" title="下移" @click="moveDown(m, i)">↓</button>
                <button v-if="chain.length > 1" class="hx-mop del" title="移出清单" @click="drop(m)">✕</button>
              </div>
            </div>
          </div>
          <p v-else-if="!modelPreview?.errors?.length" class="hx-note">
            还没有模型。从文件导入一份配置，或展开「手写 JSON」贴一份。
          </p>

          <!-- 配置里有、还没排进来的 -->
          <div v-if="candidates.length" class="hx-row">
            <button
              v-for="p in candidates"
              :key="p.id"
              class="hx-btn"
              @click="p.models[0] && addOne(p, p.models[0])"
            >
              + {{ p.name }}
            </button>
          </div>

          <div class="hx-row">
            <button class="hx-btn" @click="importFile">从文件导入</button>
            <button class="hx-btn" :disabled="probing || !modelPreview?.ok" @click="probeList">
              {{ probing ? '拉取中…' : '拉取模型列表' }}
            </button>
            <button class="hx-btn" @click="showJson = !showJson">{{ showJson ? '收起 JSON' : '手写 JSON' }}</button>
            <span v-if="applyMsg" class="hx-status" :class="applyKind">{{ applyMsg }}</span>
          </div>

          <div v-if="showJson" class="hx-json-box">
            <div class="hx-row">
              <button class="hx-btn" :disabled="!modelPreview || !modelPreview.ok" @click="formatJson">格式化</button>
              <button class="hx-btn" :disabled="applying" @click="applyModel()">
                {{ applying ? '应用中…' : '应用' }}
              </button>
            </div>
            <textarea v-model="modelText" class="hx-json-edit" spellcheck="false" autocomplete="off" @input="runPreview" />
          </div>
        </div>

        <div class="hx-block">
          <div class="hx-block-head">
            <span class="hx-block-title">引擎日志</span>
            <span class="hx-note-inline">{{ logs.length }} 行</span>
          </div>
          <pre class="hx-logs">{{ logs.length ? logs.join('\n') : '（等待引擎输出）' }}</pre>
          <div class="hx-row">
            <button class="hx-btn quiet" @click="openData">应用数据目录（诊断用）</button>
          </div>
        </div>
      </section>

      <!-- 开发者：测试用的东西放这里，没有日常该碰的开关 -->
      <section v-show="view === 'dev'" class="hx-set">
        <h2 class="hx-set-title">开发者</h2>

        <div class="hx-block">
          <div class="hx-block-head">
            <span class="hx-block-title">初始化</span>
          </div>
          <p class="hx-note">
            清空馄饨的记忆：记忆日志、梦日记，并换一个新会话——它不再记得你们聊过什么。
            人格文件、模型配置和密钥都保留。删之前会留一份备份在应用数据目录。
            点下去会先弹一次系统确认。
          </p>
          <div class="hx-row">
            <button class="hx-btn danger" :disabled="resettingMemory" @click="devResetMemory">
              {{ resettingMemory ? '清空中…' : '清空记忆并重置' }}
            </button>
          </div>
        </div>
      </section>
    </div>

    <div v-if="toast" class="hx-toast">{{ toast }}</div>
  </div>
</template>
