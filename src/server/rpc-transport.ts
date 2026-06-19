/**
 * 基于 stdio 的 NDJSON JSON-RPC。
 *
 * 帧形状：
 *   Request:  {"id": N, "method": "...", "params": ...}
 *   Response: {"id": N, "result": ...} 或 {"id": N, "error": {code, message}}
 *   Event:    {"method": "event.name", "params": ...}    // 无 id
 *
 * 每行一个帧。由 `swarmflow --server` 用于与 GUI 子进程监督者
 *（Electron 主进程）通信。
 */

export interface RpcRequest {
  readonly id: number;
  readonly method: string;
  readonly params?: unknown;
}

export interface RpcResponseOk {
  readonly id: number;
  readonly result: unknown;
}

export interface RpcResponseErr {
  readonly id: number;
  readonly error: { code: number; message: string; data?: unknown };
}

export interface RpcEvent {
  readonly method: string;
  readonly params?: unknown;
}

export const RPC_ERROR = {
  PARSE: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL: -32603,
  SESSION_ERROR: -32000,
} as const;

export type RpcHandler = (params: unknown) => unknown | Promise<unknown>;

export interface RpcServer {
  /** 注册请求处理器。 */
  on(method: string, handler: RpcHandler): void;
  /** 向对端发出事件（不期望响应）。 */
  emit(method: string, params?: unknown): void;
  /** 停止读写。 */
  close(): void;
}

/**
 * 构建绑定到给定流的 RPC 服务器。从 `input` 读取 NDJSON 请求，
 * 并将 NDJSON 响应/事件写入 `output`。每行独立解析 — 部分行会被缓冲。
 */
export function createRpcServer(
  input: NodeJS.ReadableStream,
  output: NodeJS.WritableStream,
): RpcServer {
  const handlers = new Map<string, RpcHandler>();
  let buffer = "";
  let closed = false;

  const writeFrame = (frame: unknown): void => {
    if (closed) return;
    try {
      output.write(JSON.stringify(frame) + "\n");
    } catch {
      // 忽略写入错误 — 对端已断开
    }
  };

  const handleLine = async (line: string): Promise<void> => {
    if (line.length === 0) return;
    let frame: RpcRequest;
    try {
      frame = JSON.parse(line) as RpcRequest;
    } catch {
      writeFrame({
        id: 0,
        error: { code: RPC_ERROR.PARSE, message: `parse error: ${line.slice(0, 200)}` },
      } satisfies RpcResponseErr);
      return;
    }
    if (typeof frame.id !== "number" || typeof frame.method !== "string") {
      writeFrame({
        id: typeof frame.id === "number" ? frame.id : 0,
        error: { code: RPC_ERROR.INVALID_REQUEST, message: "missing id or method" },
      } satisfies RpcResponseErr);
      return;
    }
    const handler = handlers.get(frame.method);
    if (!handler) {
      writeFrame({
        id: frame.id,
        error: { code: RPC_ERROR.METHOD_NOT_FOUND, message: `unknown method: ${frame.method}` },
      } satisfies RpcResponseErr);
      return;
    }
    try {
      const result = await handler(frame.params);
      writeFrame({ id: frame.id, result: result ?? null } satisfies RpcResponseOk);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      writeFrame({
        id: frame.id,
        error: { code: RPC_ERROR.INTERNAL, message },
      } satisfies RpcResponseErr);
    }
  };

  input.setEncoding?.("utf8");
  input.on("data", (chunk: string | Buffer) => {
    buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    let nl = buffer.indexOf("\n");
    while (nl >= 0) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      // 不 await — 并发处理行。每个请求的顺序仍保留，
      // 因为每个帧都有自己的 `id`。
      void handleLine(line.trim());
      nl = buffer.indexOf("\n");
    }
  });

  input.on("end", () => {
    closed = true;
  });

  return {
    on(method, handler) {
      handlers.set(method, handler);
    },
    emit(method, params) {
      writeFrame({ method, params } satisfies RpcEvent);
    },
    close() {
      closed = true;
    },
  };
}
