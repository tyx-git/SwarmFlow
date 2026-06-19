/**
 * MessageBus — swarm 内的 agent-to-agent 通信。
 *
 * 提供发布/订阅、直接消息传递和请求/响应模式。
 * 所有消息都有时间戳和 TTL 用于自动过期。
 *
 * @packageDocumentation
 */

import { MessageType } from "./types.js";
import type { SwarmMessage } from "./types.js";

/** 传入消息的处理程序。 */
export type MessageHandler = (message: SwarmMessage) => void;

/** 订阅句柄 — 调用以取消订阅。 */
export interface Subscription {
  /** 唯一订阅 ID。 */
  id: string;
  /** 订阅的主题或 agent ID。 */
  target: string;
  /** 这是主题订阅还是直接订阅。 */
  type: "topic" | "direct";
  /** 取消订阅。 */
  unsubscribe: () => void;
}

/** Message bus 配置。 */
export interface MessageBusConfig {
  /** 保留的最大历史消息数量。 */
  historySize: number;
  /** 消息的默认 TTL（毫秒）。 */
  defaultTTL: number;
}

const DEFAULT_CONFIG: MessageBusConfig = {
  historySize: 1000,
  defaultTTL: 300_000, // 5 minutes
};

/**
 * MessageBus — swarm agents 的中央通信中心。
 *
 * 功能：
 * - 基于主题的发布/订阅
 * - 直接的 agent-to-agent 消息传递
 * - 请求/响应模式（带超时）
 * - 消息历史（有限）
 * - 过期消息的自动清除
 * - 投递统计
 */
export class MessageBus {
  private _config: MessageBusConfig;
  private _topicHandlers = new Map<string, Set<MessageHandler>>();
  private _directHandlers = new Map<string, Set<MessageHandler>>();
  private _history: SwarmMessage[] = [];
  private _pendingRequests = new Map<string, { resolve: (msg: SwarmMessage) => void; reject: (err: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private _subscriptionCounter = 0;
  private _messageCounter = 0;

  /** Fired for every message (for monitoring). */
  onMessage?: (message: SwarmMessage) => void;

  constructor(config?: Partial<MessageBusConfig>) {
    this._config = { ...DEFAULT_CONFIG, ...config };
  }

  /** Current history size. */
  get historySize(): number {
    return this._history.length;
  }

  /** Total messages sent since bus creation. */
  get totalMessages(): number {
    return this._messageCounter;
  }

  // ------------------------------------------------------------------
  // 发布
  // ------------------------------------------------------------------

  /**
   * Publish a message to a topic.
   */
  publish(topic: string, payload: unknown, ttl?: number): SwarmMessage {
    const message = this._createMessage(
      this._nextId(),
      MessageType.Broadcast,
      "system",
      undefined,
      topic,
      payload,
      ttl,
    );
    this._dispatch(message);
    return message;
  }

  /**
   * Send a direct message to a specific agent.
   */
  send(to: string, type: MessageType, payload: unknown, from?: string, ttl?: number): SwarmMessage {
    const message = this._createMessage(
      this._nextId(),
      type,
      from ?? "system",
      to,
      undefined,
      payload,
      ttl,
    );
    this._dispatch(message);
    return message;
  }

  /**
   * Task assignment: send a task to an agent.
   */
  assignTask(agentId: string, taskId: string, description: string): SwarmMessage {
    return this.send(agentId, MessageType.TaskAssign, { taskId, description }, "coordinator");
  }

  /**
   * Task result: an agent reports back.
   */
  reportResult(from: string, taskId: string, result: unknown): SwarmMessage {
    return this.send("coordinator", MessageType.TaskResult, { taskId, result }, from);
  }

  /**
   * Request/response: send a request and wait for a response.
   * Returns a promise that resolves when the response arrives or rejects on timeout.
   */
  request(
    to: string,
    payload: unknown,
    from?: string,
    timeoutMs = 30_000,
  ): Promise<SwarmMessage> {
    return new Promise((resolve, reject) => {
      const messageId = this._nextId();
      const timer = setTimeout(() => {
        this._pendingRequests.delete(messageId);
        reject(new Error(`Request to "${to}" timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      this._pendingRequests.set(messageId, { resolve, reject, timer });

      const message = this._createMessage(
        messageId,
        MessageType.Question,
        from ?? "system",
        to,
        undefined,
        payload,
        timeoutMs,
      );
      this._dispatch(message);
    });
  }

  /**
   * Respond to a request.
   */
  respond(to: string, inReplyTo: string, payload: unknown): SwarmMessage {
    const message = this._createMessage(
      this._nextId(),
      MessageType.Answer,
      "system",
      to,
      undefined,
      { inReplyTo, ...(payload as object) },
    );
    this._dispatch(message);
    return message;
  }

  // ------------------------------------------------------------------
  // 订阅
  // ------------------------------------------------------------------

  /**
   * Subscribe to a topic.
   */
  subscribe(topic: string, handler: MessageHandler): Subscription {
    if (!this._topicHandlers.has(topic)) {
      this._topicHandlers.set(topic, new Set());
    }
    this._topicHandlers.get(topic)!.add(handler);

    const sub: Subscription = {
      id: `sub-${++this._subscriptionCounter}`,
      target: topic,
      type: "topic",
      unsubscribe: () => {
        this._topicHandlers.get(topic)?.delete(handler);
      },
    };

    return sub;
  }

  /**
   * Subscribe to direct messages from a specific agent (or all).
   */
  subscribeDirect(agentId: string | undefined, handler: MessageHandler): Subscription {
    const key = agentId ?? "*";
    if (!this._directHandlers.has(key)) {
      this._directHandlers.set(key, new Set());
    }
    this._directHandlers.get(key)!.add(handler);

    const sub: Subscription = {
      id: `sub-${++this._subscriptionCounter}`,
      target: key,
      type: "direct",
      unsubscribe: () => {
        this._directHandlers.get(key)?.delete(handler);
      },
    };

    return sub;
  }

  /**
   * Unsubscribe all handlers for a topic.
   */
  unsubscribeTopic(topic: string): void {
    this._topicHandlers.delete(topic);
  }

  /**
   * Unsubscribe all handlers for direct messages.
   */
  unsubscribeAllDirect(): void {
    this._directHandlers.clear();
  }

  /**
   * Remove all subscriptions and history.
   */
  reset(): void {
    this._topicHandlers.clear();
    this._directHandlers.clear();
    this._history = [];
    // Clean up pending requests
    for (const [, { reject, timer }] of this._pendingRequests) {
      clearTimeout(timer);
      reject(new Error("Bus reset"));
    }
    this._pendingRequests.clear();
  }

  // ------------------------------------------------------------------
  // 历史
  // ------------------------------------------------------------------

  /**
   * Get message history, optionally filtered by topic or agent.
   */
  getHistory(topic?: string, agentId?: string, limit = 50): SwarmMessage[] {
    let filtered = this._history;

    if (topic) {
      filtered = filtered.filter((m) => m.topic === topic);
    }
    if (agentId) {
      filtered = filtered.filter(
        (m) => m.sender === agentId || m.recipient === agentId,
      );
    }

    return filtered.slice(-limit);
  }

  /**
   * Get the last N messages.
   */
  getLastMessages(n = 10): SwarmMessage[] {
    return this._history.slice(-n);
  }

  // ------------------------------------------------------------------
  // 私有
  // ------------------------------------------------------------------

  private _nextId(): string {
    return `msg-${++this._messageCounter}-${Date.now()}`;
  }

  private _createMessage(
    id: string,
    type: MessageType,
    sender: string,
    recipient: string | undefined,
    topic: string | undefined,
    payload: unknown,
    ttl?: number,
  ): SwarmMessage {
    return {
      id,
      type,
      sender,
      recipient,
      topic,
      payload,
      timestamp: Date.now(),
      ttl: ttl ?? this._config.defaultTTL,
    };
  }

  private _dispatch(message: SwarmMessage): void {
    // Store in history
    this._history.push(message);
    if (this._history.length > this._config.historySize) {
      this._history.shift();
    }

    // Global listener
    this.onMessage?.(message);

    // Topic handlers
    if (message.topic) {
      const handlers = this._topicHandlers.get(message.topic);
      if (handlers) {
        for (const handler of handlers) {
          try { handler(message); } catch { /* handler error */ }
        }
      }
    }

    // Direct handlers
    if (message.recipient) {
      const handlers = this._directHandlers.get(message.recipient);
      if (handlers) {
        for (const handler of handlers) {
          try { handler(message); } catch { /* handler error */ }
        }
      }
      // Also notify wildcard listeners
      const wildcardHandlers = this._directHandlers.get("*");
      if (wildcardHandlers) {
        for (const handler of wildcardHandlers) {
          try { handler(message); } catch { /* handler error */ }
        }
      }
    }

    // 检查 for pending requests
    if (message.type === MessageType.Answer) {
      const payload = message.payload as { inReplyTo?: string };
      if (payload?.inReplyTo) {
        const pending = this._pendingRequests.get(payload.inReplyTo);
        if (pending) {
          clearTimeout(pending.timer);
          this._pendingRequests.delete(payload.inReplyTo);
          pending.resolve(message);
        }
      }
    }
  }
}
