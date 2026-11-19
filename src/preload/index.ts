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

export type ChatResult =
  | { ok: true; text: string }
  | { ok: false; kind: "auth" | "endpoint" | "engine" | "network" | "overload" | "aborted"; message: string };

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
  devResetMemory(): Promise<{ ok: boolean; canceled?: boolean; error?: string; backupDir?: string; removed: string[] }>;
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
