import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { resolveTypedCommandEcho } from "../../src/commands/echo.js";
import { registerSkillCommands } from "../../src/commands/ecosystem/skills.js";
import { CommandRegistry } from "../../src/commands/registry.js";
import { buildDefaultRegistry } from "../../src/commands/registration.js";
import type { SkillMeta } from "../../src/skills/loader.js";

/**
 * 一条键入的斜杠命令在主界面只能留下一行用户可见条目。
 *
 * UI 在调用 handler 之前预回显，而注入回合会把 displayText 作为 user_message
 * 再写一次（session._runInjectedTurn），切换类命令也会在选择结果落定后自己回显
 * ——两种情况都得靠 selfEcho 关掉预回显，否则就是两个 /plan。
 */
const SELF_ECHO: Record<string, true | undefined> = {
  // 切换结果由流程自己回显，入口预回显会把中间参数当成最终结果。
  "/rename": true,
  "/compact": true,
  "/provider": true,
  "/permission": true,
  "/skills": true,
  // 注入回合的 displayText 就是那条用户行。
  "/init": true,
  "/plan": true,
  "/goal": true,
  "/fix": true,
  "/ask": true,
  "/reviewer": true,
  "/skills-creater": true,
  // 其余命令只有预回显这一行。
  "/status": undefined,
  "/model": undefined,
  "/theme": undefined,
};

function registryWithUserSkill(): CommandRegistry {
  const registry = new CommandRegistry();
  const skill = {
    name: "reverse-engineer-anything",
    description: "Reverse engineer binaries",
    disableModelInvocation: false,
    userInvocable: true,
    dir: "/tmp/skills/reverse-engineer-anything",
    contentRaw: "# body",
  } satisfies SkillMeta;
  registerSkillCommands(registry, new Map([[skill.name, skill]]));
  return registry;
}

describe("typed slash command echo", () => {
  it.each(Object.entries(SELF_ECHO))("%s declares selfEcho as its handler writes the user line", (name, expected) => {
    expect(buildDefaultRegistry().lookup(name)?.selfEcho).toBe(expected);
  });

  it("does not pre-echo the injected-turn commands that duplicate the user line", () => {
    const registry = buildDefaultRegistry();
    for (const name of ["/init", "/plan", "/goal", "/fix", "/ask", "/reviewer", "/skills-creater"]) {
      const input = name === "/plan" ? "/plan" : `${name} 目标`;
      expect(resolveTypedCommandEcho(registry.lookup(name), input, "zh")).toBeNull();
    }
  });

  it("does not pre-echo switch commands that echo after their result is known", () => {
    const registry = buildDefaultRegistry();
    expect(resolveTypedCommandEcho(registry.lookup("/provider"), "/provider niko", "zh")).toBeNull();
    expect(resolveTypedCommandEcho(registry.lookup("/permission"), "/permission yolo", "zh")).toBeNull();
    expect(resolveTypedCommandEcho(registry.lookup("/compact"), "/compact", "zh")).toBeNull();
    expect(resolveTypedCommandEcho(registry.lookup("/rename"), "/rename 冒烟", "zh")).toBeNull();
    expect(resolveTypedCommandEcho(registry.lookup("/skills"), "/skills mcp-builder", "zh")).toBeNull();
  });

  it("still echoes commands whose only trace is the typed line", () => {
    const registry = buildDefaultRegistry();
    expect(resolveTypedCommandEcho(registry.lookup("/status"), "/status", "zh")).toEqual({
      text: "/status",
      style: "injected",
    });
    expect(resolveTypedCommandEcho(registry.lookup("/model"), "/model gpt-5", "zh")).toEqual({
      text: "模型切换为 gpt-5",
      style: "switch",
    });
  });

  it("marks injected-turn skill commands as self-echoing too", () => {
    const registry = registryWithUserSkill();
    const command = registry.lookup("/reverse-engineer-anything");
    expect(command?.selfEcho).toBe(true);
    expect(resolveTypedCommandEcho(command, "/reverse-engineer-anything 这个 exe", "zh")).toBeNull();
  });

  it("routes both UI echo sites through the shared decision", () => {
    const source = readFileSync("external/opentui/app.tsx", "utf8");
    expect(source.includes("deferredEcho")).toBe(false);
    expect((source.match(/resolveTypedCommandEcho\(/g) ?? []).length).toBe(2);
  });
});
