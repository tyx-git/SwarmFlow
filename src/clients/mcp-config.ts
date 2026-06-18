/**
 * MCP server configuration loader.
 *
 * Loads MCP server definitions from:
 *   1. ~/.swarmflow/mcp.json       (global)
 *   2. {project}/.mcp.json     (project 鈥?overrides global by server name)
 *
 * Project servers require approval via settings (mcp_approved_project_servers).
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { MCPServerConfig } from "./config/config.js";

function resolveEnv(value: string): string {
  if (typeof value === "string" && value.startsWith("${") && value.endsWith("}")) {
    const envName = value.slice(2, -1);
    const resolved = process.env[envName];
    if (resolved === undefined) {
      throw new Error(`Environment variable '${envName}' is not set`);
    }
    return resolved;
  }
  return value;
}

/**
 * Load MCP server configurations from mcp.json in the given directory.
 * Returns empty array if the file doesn't exist.
 */
export function loadMcpServers(homeDir: string): MCPServerConfig[] {
  const mcpPath = join(homeDir, "mcp.json");
  return parseMcpFile(mcpPath);
}

/**
 * Load MCP servers from global + project configs.
 * Project servers override global by name.
 * Project servers are marked with `_projectServer = true` for approval gating.
 */
export function loadMcpServersWithProject(
  homeDir: string,
  projectMcpPath: string | null,
): MCPServerConfig[] {
  const global = parseMcpFile(join(homeDir, "mcp.json"));
  const byName = new Map<string, MCPServerConfig>();
  for (const s of global) byName.set(s.name, s);

  if (projectMcpPath) {
    const project = parseMcpFile(projectMcpPath);
    for (const s of project) {
      (s as any)._projectServer = true;
      byName.set(s.name, s);
    }
  }

  return [...byName.values()];
}

function parseMcpFile(filePath: string): MCPServerConfig[] {
  if (!existsSync(filePath)) return [];

  let raw: Record<string, Record<string, unknown>>;
  try {
    const content = readFileSync(filePath, "utf-8");
    raw = JSON.parse(content) as Record<string, Record<string, unknown>>;
  } catch {
    return [];
  }

  // Handle both flat format { "server": { ... } } and nested { "mcpServers": { ... } }
  if (raw["mcpServers"] && typeof raw["mcpServers"] === "object") {
    raw = raw["mcpServers"] as Record<string, Record<string, unknown>>;
  }

  const servers: MCPServerConfig[] = [];
  for (const [name, cfg] of Object.entries(raw)) {
    if (!cfg || typeof cfg !== "object") continue;
    const env: Record<string, string> = {};
    const rawEnv = cfg["env"] as Record<string, string> | undefined;
    if (rawEnv) {
      for (const [k, v] of Object.entries(rawEnv)) {
        try {
          env[k] = resolveEnv(String(v));
        } catch (e) {
          console.warn(`MCP server "${name}": env var resolution failed for ${k}: ${e instanceof Error ? e.message : e}`);
        }
      }
    }
    servers.push({
      name,
      transport: (cfg["transport"] as "stdio" | "sse") ?? "stdio",
      command: (cfg["command"] as string) ?? "",
      args: (cfg["args"] as string[]) ?? [],
      url: (cfg["url"] as string) ?? "",
      env,
      envAllowlist: Array.isArray(cfg["env_allowlist"])
        ? (cfg["env_allowlist"] as unknown[]).map((v) => String(v))
        : undefined,
      sensitiveTools: Array.isArray(cfg["sensitive_tools"])
        ? (cfg["sensitive_tools"] as unknown[]).map((v) => String(v))
        : undefined,
    });
  }
  return servers;
}
