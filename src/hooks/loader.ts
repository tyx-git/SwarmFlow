/**
 * 钩子发现与加载。
 *
 * 钩子定义为钩子目录内的 hook.json 文件。
 * 发现顺序：项目（.swarmflow/hooks/）> 全局（~/.swarmflow/hooks/）。
 * 项目作用域中同名钩子会覆盖全局钩子。
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { HookEvent, HookManifest } from "./types.js";
import { FAIL_CLOSED_EVENTS } from "./types.js";

const VALID_EVENTS = new Set<string>([
  "SessionStart", "SessionEnd", "UserPromptSubmit",
  "PreToolUse", "PostToolUse", "PostToolUseFailure",
  "SubagentStart", "SubagentStop", "Stop",
]);

/**
 * 从钩子目录加载所有钩子清单。
 * 每个包含 hook.json 的子目录都被视为一个钩子。
 */
export function loadHooksFromDir(
  hooksDir: string,
  scope: "project" | "global",
): HookManifest[] {
  if (!existsSync(hooksDir) || !statSync(hooksDir).isDirectory()) {
    return [];
  }

  const hooks: HookManifest[] = [];
  for (const entry of readdirSync(hooksDir).sort()) {
    const dirPath = join(hooksDir, entry);
    if (!statSync(dirPath).isDirectory()) continue;

    const manifestPath = join(dirPath, "hook.json");
    if (!existsSync(manifestPath)) continue;

    try {
      const raw = JSON.parse(readFileSync(manifestPath, "utf-8")) as Record<string, unknown>;
      const manifest = parseManifest(raw, entry, manifestPath, scope);
      if (manifest) hooks.push(manifest);
    } catch (e) {
      console.warn(`Hook "${entry}": failed to parse hook.json: ${e instanceof Error ? e.message : e}`);
    }
  }

  return hooks;
}

/**
 * 按优先级顺序从多个目录加载钩子。
 * 后面的条目按钩子名称覆盖前面的条目。
 */
export function loadHooksMulti(
  roots: Array<{ dir: string; scope: "global" | "project" | "workspace" }>,
): HookManifest[] {
  const byName = new Map<string, HookManifest>();
  for (const { dir, scope } of roots) {
    for (const hook of loadHooksFromDir(dir, scope as "project" | "global")) {
      byName.set(hook.name, hook);
    }
  }
  return [...byName.values()];
}

function parseManifest(
  raw: Record<string, unknown>,
  dirName: string,
  sourcePath: string,
  scope: "project" | "global",
): HookManifest | null {
  const event = raw["event"] as string;
  if (!event || !VALID_EVENTS.has(event)) {
    console.warn(`Hook "${dirName}": invalid or missing event "${event}". Skipping.`);
    return null;
  }

  const type = raw["type"] as string;
  if (type !== "command") {
    console.warn(`Hook "${dirName}": only type "command" is supported (got "${type}"). Skipping.`);
    return null;
  }

  const command = raw["command"] as string;
  if (!command) {
    console.warn(`Hook "${dirName}": missing "command" field. Skipping.`);
    return null;
  }

  const name = typeof raw["name"] === "string" ? raw["name"] : dirName;

  const failClosed = raw["failClosed"] === true;
  if (failClosed && !FAIL_CLOSED_EVENTS.has(event as HookEvent)) {
    console.warn(`Hook "${name}": failClosed only allowed for ${[...FAIL_CLOSED_EVENTS].join(", ")}. Ignoring failClosed.`);
  }

  return {
    name,
    event: event as HookEvent,
    type: "command",
    command,
    args: Array.isArray(raw["args"]) ? (raw["args"] as unknown[]).map(String) : undefined,
    env: raw["env"] && typeof raw["env"] === "object" ? raw["env"] as Record<string, string> : undefined,
    matcher: parseMatcher(raw["matcher"]),
    timeoutMs: typeof raw["timeoutMs"] === "number" ? raw["timeoutMs"] : undefined,
    failClosed: failClosed && FAIL_CLOSED_EVENTS.has(event as HookEvent) ? true : undefined,
    disabled: raw["disabled"] === true ? true : undefined,
    _sourcePath: sourcePath,
    _scope: scope,
  };
}

function parseMatcher(raw: unknown): HookManifest["matcher"] {
  if (!raw || typeof raw !== "object") return undefined;
  const obj = raw as Record<string, unknown>;
  const matcher: HookManifest["matcher"] = {};

  if (Array.isArray(obj["toolNames"])) {
    matcher.toolNames = (obj["toolNames"] as unknown[]).map(String);
  }
  if (Array.isArray(obj["agentIds"])) {
    matcher.agentIds = (obj["agentIds"] as unknown[]).map(String);
  }

  return Object.keys(matcher).length > 0 ? matcher : undefined;
}
