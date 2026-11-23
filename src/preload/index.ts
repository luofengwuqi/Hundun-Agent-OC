/**
 * 渲染进程只能通过这里拿到能力。
 * 刻意不暴露：token、文件系统、任意 ipcRenderer。
 */
import { contextBridge, ipcRenderer } from "electron";

export interface ShellStateDto {
  status: "booting" | "starting" | "ready" | "failed" | "stopped";
  port: number | null;
  pid: number | null;
  adopted: boolean;
  notice: string | null;
  /** 记忆根（文档目录下），卸载不会删（D024）。 */
  memoryDir: string | null;
  /** 应用自己的数据（缓存、运行时记录），卸载可删。 */
  dataDir: string | null;
  /**
   * 模型状态。分开报「有没有模型路由」和「有没有密钥」，
   * 因为这两种缺失的修法完全不同，含糊成一句「不可用」等于什么都没说。
   */
  model: {
    ref: string | null;
    keyPresent: boolean;
  };
  failure: {
    kind: string;
    retryable: boolean;
    userMessage: string;
    detail?: string;
  } | null;
}

export interface ChatTurnDto {
  role: "user" | "assistant" | "system";
  content: string;
}

/** 引擎转写里的一条消息：比本地多一个时间戳，界面可以据此显示先后。 */
export interface RemoteTurnDto {
  role: "user" | "assistant";
  content: string;
  ts: number;
}

export type ChatResult =
  | { ok: true; text: string }
  | {
      ok: false;
      /** invalid：历史被壳侧校验拒了（角色/长度/来源不对），不是引擎的问题。 */
      kind: "auth" | "endpoint" | "engine" | "network" | "overload" | "aborted" | "invalid";
      message: string;
    };

/** 对话历史落盘的结果。失败不打断对话，只带回原因供诊断。 */
export type ChatHistorySaveResult = { ok: boolean; error?: string };

/** 更正一条 assistant 回复。turns 是写回后的完整历史（以主进程落盘那份为准）。 */
export type CorrectChatResult =
  | { ok: true; turns: ChatTurnDto[]; oldContent: string }
  | { ok: false; error: string };

/** 结构化称呼：pending 是模型提议、尚未被用户确认的值。 */
export interface UserProfileDto {
  name: string | null;
  confirmedAt: string | null;
  source: "user-confirmed" | "migrated-from-USER.md" | null;
  pending: { name: string; observedAt: string; source: "model-write" } | null;
}

export type ConfirmNameResult =
  | { ok: true; profile: UserProfileDto }
  | { ok: false; error: string };

export interface ModelPreviewDto {
  ok: boolean;
  errors: string[];
  warnings: string[];
  providers: Array<{
    id: string;
    name: string;
    baseUrl: string;
    hasKey: boolean;
    /** 引擎 api 方言（claude 式转出来的是 anthropic-messages）。反向加载/预览都带。 */
    api?: string;
    /** 反向加载时的 ${ENV} 插值名（preview 没有这个字段）。 */
    envName?: string | null;
    models: Array<{ id: string; name: string; context: number; output: number }>;
  }>;
  selected: {
    providerId: string;
    providerName: string;
    modelId: string;
    modelName: string;
    baseUrl: string;
    contextWindow: number;
  } | null;
  chain: Array<{
    providerId: string;
    providerName: string;
    modelId: string;
    modelName: string;
    baseUrl: string;
    contextWindow: number;
  }>;
  /** 输入的配置格式：claude 式会在主进程转换，converted 是转好的中间格式。 */
  format?: "opencode" | "claude";
  converted?: unknown;
}

export interface ShellApi {
  getState(): Promise<ShellStateDto & { logs: string[] }>;
  restartEngine(): Promise<ShellStateDto & { logs: string[] }>;
  /** 发一句话。流式片段通过 onChunk 推回来，这里只等最终结果。 */
  sendChat(history: ChatTurnDto[]): Promise<ChatResult>;
  abortChat(): void;
  /** 回读上次的对话；session key 对不上（重置过记忆）时返回空。 */
  loadChat(): Promise<ChatTurnDto[]>;
  /**
   * 另一端的对话（手机 QQ）。只用于显示：本窗口的 chat-history.json 只记自己发出去的话，
   * 而两端共用一段会话，引擎的转写里才有全部。读不到就返回空。
   */
  loadRemoteChat(): Promise<RemoteTurnDto[]>;
  /** 落盘当前对话。加载/保存失败都不该阻断聊天，故只回 ok 与原因。 */
  saveChat(history: ChatTurnDto[]): Promise<ChatHistorySaveResult>;
  /** 更正一条它说过的话：只传序号与新正文，索引/旧原文由主进程按落盘历史核对。 */
  correctChat(index: number, content: string): Promise<CorrectChatResult>;
  /** 读当前确认过的称呼，以及模型提出但未确认的称呼。 */
  getProfile(): Promise<UserProfileDto | null>;
  /** 用户确认称呼。主进程会回读对话历史，要求这个名字确实出现在用户说过的话里。 */
  confirmName(name: string): Promise<ConfirmNameResult>;
  /** 否掉模型的提议，不动已确认的称呼。 */
  dismissName(): Promise<{ ok: boolean; profile?: UserProfileDto }>;
  onChunk(cb: (delta: string) => void): void;
  /** 模型配置：解析（不落盘）、应用（写引擎配置+secrets+重启）、导入文件、排序。 */
  previewModel(text: string): Promise<ModelPreviewDto>;
  applyModel(text: string): Promise<{ ok: boolean; errors: string[]; warnings: string[]; primaryRef: string | null; cfg: ShellStateDto }>;
  pickModelFile(): Promise<{ ok: boolean; canceled?: boolean; path?: string; name?: string; text?: string; error?: string }>;
  editModel(payload: { config: unknown; op: string; ref: string; to?: number; models?: Array<{ id: string; name?: string }> }): Promise<{ ok: boolean; config?: unknown; error?: string; errors?: string[]; warnings?: string[] }>;
  /** 去该地址拉真实模型列表（GET /v1/models）。claude 式配置不带列表，靠它补全。 */
  probeModel(payload: { config: unknown; providerId?: string }): Promise<{ ok: boolean; providerId?: string; models: Array<{ id: string; name: string }>; error?: string }>;
  /** 反向加载引擎里已保存的 provider 集 + 首选模型，供设置页重启后渲染卡片链。 */
  currentModel(): Promise<{ ok: boolean; providers: ModelPreviewDto["providers"]; primaryRef: string | null }>;
  /** 记忆根（文档目录下）。用户备份的就是这个文件夹。 */
  openMemoryDir(): Promise<string>;
  /** 人格与记忆所在的 workspace。 */
  openWorkspace(): Promise<string>;
  /** 应用自己的数据目录（诊断用）。 */
  openDataDir(): Promise<string>;
  /** 开发者选项：重置记忆。确认弹窗在主进程，取消时 canceled:true。 */
  devResetMemory(): Promise<{ ok: boolean; canceled?: boolean; error?: string; backupDir?: string; removed: string[]; bootstrapRestored?: boolean }>;
  probe(): Promise<boolean>;
  /** 无边框窗口的自绘按钮用（frame: false）。 */
  winMinimize(): void;
  winClose(): void;
  /**
   * 开发期专用：走一遍「托盘退出」的收尾路径（forceQuit + app.quit）。
   * 主进程只在非打包时注册这个 IPC，所以生产包里调用它没有任何效果。
   */
  devQuit(): void;
  onState(cb: (state: ShellStateDto) => void): void;
  onLog(cb: (line: string) => void): void;
}

const api: ShellApi = {
  getState: () => ipcRenderer.invoke("shell:get-state"),
  restartEngine: () => ipcRenderer.invoke("shell:restart-engine"),
  sendChat: (history) => ipcRenderer.invoke("chat:send", history),
  abortChat: () => ipcRenderer.send("chat:abort"),
  loadChat: () => ipcRenderer.invoke("chat:load"),
  loadRemoteChat: () => ipcRenderer.invoke("chat:remote"),
  saveChat: (history) => ipcRenderer.invoke("chat:save", history),
  correctChat: (index, content) => ipcRenderer.invoke("chat:correct", { index, content }),
  getProfile: () => ipcRenderer.invoke("profile:get"),
  confirmName: (name) => ipcRenderer.invoke("profile:confirm", name),
  dismissName: () => ipcRenderer.invoke("profile:dismiss"),
  onChunk: (cb) => {
    ipcRenderer.on("chat:chunk", (_event, delta: string) => cb(delta));
  },
  previewModel: (text) => ipcRenderer.invoke("model:preview", text),
  applyModel: (text) => ipcRenderer.invoke("model:apply", text),
  pickModelFile: () => ipcRenderer.invoke("model:pick-file"),
  editModel: (payload) => ipcRenderer.invoke("model:edit", payload),
  probeModel: (payload) => ipcRenderer.invoke("model:probe", payload),
  currentModel: () => ipcRenderer.invoke("model:current"),
  openMemoryDir: () => ipcRenderer.invoke("shell:open-memory-dir"),
  openWorkspace: () => ipcRenderer.invoke("shell:open-workspace"),
  devResetMemory: () => ipcRenderer.invoke("dev:reset-memory"),
  openDataDir: () => ipcRenderer.invoke("shell:open-data-dir"),
  probe: () => ipcRenderer.invoke("shell:probe"),
  // 这两个走 send 而不是 invoke：窗口已经在消失，没有返回值可等
  winMinimize: () => ipcRenderer.send("shell:win-minimize"),
  winClose: () => ipcRenderer.send("shell:win-close"),
  devQuit: () => ipcRenderer.send("shell:dev-quit"),
  onState: (cb) => {
    ipcRenderer.on("shell:state", (_event, state: ShellStateDto) => cb(state));
  },
  onLog: (cb) => {
    ipcRenderer.on("shell:log", (_event, line: string) => cb(line));
  },
};

contextBridge.exposeInMainWorld("shellApi", api);
