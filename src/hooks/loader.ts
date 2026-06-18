/**
 * Hook discovery and loading.
 *
 * Hooks are defined as hook.json files inside hook directories.
 * Discovery order: project (.swarmflow/hooks/) > global (~/.swarmflow/hooks/).
 * Same-name hooks in project scope override global.
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
 * Load all hook manifests from a hooks directory.
 * Each subdirectory containing a hook.json is treated as a hook.
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
 * Load hooks from multiple directories in priority order.
 * Later entries override earlier ones by hook name.
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
