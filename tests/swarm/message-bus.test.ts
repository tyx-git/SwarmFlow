/**
 * Tests for the MessageBus.
 */

import { describe, expect, it } from "vitest";
import { MessageBus } from "../../src/swarm/message-bus.js";
import { MessageType } from "../../src/swarm/types.js";

describe("MessageBus", () => {
  it("publishes and subscribes to topics", () => {
    const bus = new MessageBus();
    const received: string[] = [];

    bus.subscribe("test-topic", (msg) => {
      received.push(msg.payload as string);
    });

    bus.publish("test-topic", "hello");
    bus.publish("test-topic", "world");

    expect(received).toEqual(["hello", "world"]);
  });

  it("sends direct messages", () => {
    const bus = new MessageBus();
    const received: string[] = [];

    bus.subscribeDirect("agent-1", (msg) => {
      received.push(msg.payload as string);
    });

    bus.send("agent-1", MessageType.TaskAssign, "do-something");
    expect(received).toEqual(["do-something"]);
  });

  it("supports unsubscribe", () => {
    const bus = new MessageBus();
    let count = 0;

    const sub = bus.subscribe("test", () => { count++; });
    bus.publish("test", "msg1");
    expect(count).toBe(1);

    sub.unsubscribe();
    bus.publish("test", "msg2");
    expect(count).toBe(1); // Still 1
  });

  it("maintains message history", () => {
    const bus = new MessageBus({ historySize: 10 });
    bus.publish("t1", "a");
    bus.publish("t2", "b");

    expect(bus.historySize).toBe(2);
    const history = bus.getHistory();
    expect(history.length).toBe(2);
  });

  it("supports request/response", async () => {
    const bus = new MessageBus();

    // Set up responder
    bus.subscribeDirect("responder", (msg) => {
      if (msg.type === MessageType.Question) {
        bus.respond("asker", msg.id, "response-data");
      }
    });

    const response = await bus.request("responder", "hello", "asker", 1000);
    expect(response.type).toBe(MessageType.Answer);
  });

  it("rejects on timeout", async () => {
    const bus = new MessageBus();
    await expect(
      bus.request("nonexistent", "data", "asker", 100),
    ).rejects.toThrow("timed out");
  });

  it("resets correctly", () => {
    const bus = new MessageBus();
    bus.subscribe("t", () => {});
    bus.publish("t", "data");

    bus.reset();
    expect(bus.historySize).toBe(0);
  });
});
