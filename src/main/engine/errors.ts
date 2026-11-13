/**
 * 把「引擎怎么死的」翻译成「用户能看懂、壳能据此决策」的东西。
 *
 * 依据 docs/cli/gateway/running.md：
 *   - 退出码 78 专用于「配置无效」，上游用它**阻断 systemd 重启循环**。
 *   - 退出码 1 表示可恢复的失败（配置读取失败、state 争用等），值得重试。
 * 这条区别是壳里最容易做错的地方：把 78 喂给自动重试，等于把上游特意设的
 * 断路器废掉，表现是「风扇狂转但永远起不来」。
 */

export type EngineFailureKind =
  | "config-invalid" // 78：别重试，让用户修配置
  | "retryable" // 1：可退避重试
  | "startup-timeout" // 迟迟不 ready
  | "assets-missing" // 安装包缺文件
  | "state-locked" // 状态目录被另一个实例占着
  | "unknown";

export interface EngineFailure {
  readonly kind: EngineFailureKind;
  /** true 表示壳可以自动重试；false 表示必须停下来找人。 */
  readonly retryable: boolean;
  /** 给用户看的短句，不带堆栈。 */
  readonly userMessage: string;
  /** 给「诊断」页 / 日志用的技术细节，可以长。 */
  readonly detail?: string;
}

const EXIT_CONFIG = 78;
const EXIT_RETRYABLE = 1;

export function classifyExit(code: number | null, signal: NodeJS.Signals | null): EngineFailure {
  if (signal) {
    return {
      kind: "unknown",
      retryable: false,
      userMessage: "陪伴引擎被系统信号中断了。",
      detail: `signal=${signal}`,
    };
  }
  if (code === EXIT_CONFIG) {
    return {
      kind: "config-invalid",
      retryable: false, // ← 关键：78 绝不重试
      userMessage: "配置有问题，引擎拒绝启动。",
      detail: "exit=78 (EX_CONFIG)：上游以此值阻断重启循环，壳不得自动重试。",
    };
  }
  if (code === EXIT_RETRYABLE) {
    return {
      kind: "retryable",
      retryable: true,
      userMessage: "引擎启动时遇到可恢复的问题，正在重试。",
      detail: "exit=1",
    };
  }
  return {
    kind: "unknown",
    retryable: false,
    userMessage: "陪伴引擎意外退出了。",
    detail: `exit=${code ?? "null"}`,
  };
}

/** 从引擎 stderr 里认出「已经有实例在跑」——上游的 file lock 报错（docs/gateway/gateway-lock.md）。 */
export function looksLikeStateLocked(text: string): boolean {
  const t = text.toLowerCase();
  return (
    (t.includes("lock") && (t.includes("owner") || t.includes("held") || t.includes("acquire"))) ||
    t.includes("already running") ||
    t.includes("another openclaw")
  );
}

export function classifyStartupFailure(exited: EngineFailure, stderrTail: string): EngineFailure {
  if (looksLikeStateLocked(stderrTail)) {
    return {
      kind: "state-locked",
      retryable: false,
      userMessage: "已经有一个陪伴引擎在运行了。",
      detail: stderrTail.slice(-2000),
    };
  }
  return { ...exited, detail: [exited.detail, stderrTail.slice(-2000)].filter(Boolean).join("\n\n") };
}
