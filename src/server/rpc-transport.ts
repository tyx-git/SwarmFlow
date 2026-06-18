/**
 * NDJSON JSON-RPC over stdio.
 *
 * Frame shapes:
 *   Request:  {"id": N, "method": "...", "params": ...}
 *   Response: {"id": N, "result": ...} or {"id": N, "error": {code, message}}
 *   Event:    {"method": "event.name", "params": ...}    // no id
 *
 * One frame per line. Used by `swarmflow --server` to talk to the GUI subprocess
 * supervisor (Electron main process).
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
  /** Register a request handler. */
  on(method: string, handler: RpcHandler): void;
  /** Emit an event to the peer (no response expected). */
  emit(method: string, params?: unknown): void;
  /** Stop reading and writing. */
  close(): void;
}

/**
 * Build an RPC server bound to the given streams. Reads NDJSON requests from
 * `input` and writes NDJSON responses/events to `output`. Each line is parsed
 * independently 鈥?partial lines are buffered.
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
      // ignore write errors 鈥?peer disconnected
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
      // Don't await 鈥?handle lines concurrently. Order is preserved per
      // request because each frame has its own `id`.
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
