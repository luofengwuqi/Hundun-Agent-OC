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

const keyInput = ref('')
const savingKey = ref(false)

async function saveKey() {
  if (savingKey.value) return
  const key = keyInput.value.trim()
  if (key.length === 0) {
    flash('先填一个 Key')
    return
  }
  savingKey.value = true
  try {
    applyState(await window.shellApi.setModelKey(key))
    keyInput.value = ''
    flash('已保存，引擎正在用新钥匙重启')
  } catch (error) {
    flash('保存失败：' + (error?.message || error))
  } finally {
    savingKey.value = false
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
              {{ canSend ? '可以说话' : '还不能说话' }}
            </span>
          </div>
          <div class="hx-kv">
            <span>模型</span><code>{{ state.model?.ref ?? '未配置' }}</code>
          </div>
          <div class="hx-kv">
            <span>API Key</span><code>{{ state.model?.keyPresent ? '已保存' : '未填写' }}</code>
          </div>
          <div class="hx-row">
            <input
              v-model="keyInput"
              class="hx-input"
              type="password"
              placeholder="粘贴 API Key，例如 sk-…"
              spellcheck="false"
              @keydown.enter.prevent="saveKey"
            />
            <button class="hx-btn" :disabled="savingKey || keyInput.trim().length === 0" @click="saveKey">
              {{ savingKey ? '保存中…' : '保存并重启' }}
            </button>
          </div>
          <p class="hx-note">
            Key 存在应用数据目录（权限 0600），<strong>不在记忆目录里</strong>——记忆目录会被导出成 zip、也可能被云同步，
            钥匙不该跟着走。保存后引擎会重启一次，因为凭据是在启动那一刻注入进程环境的。
          </p>
          <p class="hx-note">
            模型走 OpenAI 兼容接口（<code>POST /v1/chat/completions</code>）。这个端点在引擎里<strong>默认关闭</strong>，
            首次启动时已由我们写进配置打开。
          </p>
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
    </div>

    <div v-if="toast" class="hx-toast">{{ toast }}</div>
  </div>
</template>
