/**
 * RPC 线路协议版本与能力声明。
 *
 * 当事件负载或方法契约发生不兼容变化时递增版本；新增能力追加能力字符串，
 * 让客户端无需版本计算即可探测。
 */

/**
 * 线路协议版本，在 `ready` 元数据中公布。当事件负载或方法契约发生不兼容变化时递增。
 * 能力字符串让客户端无需版本计算即可检测新增能力。
 */
export const PROTOCOL_VERSION = 1;
export const PROTOCOL_CAPABILITIES = [
  /** session.getProjectedLog / session.getProjectedChildLog */
  "projectedLog",
  /** ask.pending / ask.resolved 由真实运行时订阅驱动（包括子 ask） */
  "askEvents",
  /** turn.started / turn.ended 由运行时为所有回合发出（包括自动恢复） */
  "turnLifecycle",
  /** turn.ended 可能携带 status "waiting"（回合停驻在待处理 ask 上） */
  "waitingStatus",
  /** server.crashed 在致命进程错误时发出 */
  "crashEvent",
] as const;
