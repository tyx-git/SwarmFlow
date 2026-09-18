/**
 * MCP 服务器配置加载器。
 *
 * 从以下位置加载 MCP 服务器定义：
 *   1. ~/.swarmflow/mcp.json       （全局）
 *   2. {project}/.mcp.json           （项目——按服务器名覆盖全局）
 *
 * 项目服务器需要通过 settings 审批（mcp_approved_project_servers）。
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { MCPServerConfig } from "../config/config.js";

/** 解析 ${ENV_VAR} 形式的环境变量占位符。 */
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
 * 从给定目录的 mcp.json 加载 MCP 服务器配置。
 * 文件不存在时返回空数组。
 */
export function loadMcpServers(homeDir: string): MCPServerConfig[] {
  const mcpPath = join(homeDir, "mcp.json");
  return parseMcpFile(mcpPath);
}

/**
 * 从全局 + 项目配置加载 MCP 服务器。
 * 项目服务器按名称覆盖全局服务器，并标记 _projectServer=true 以便审批门禁。
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

/** 解析 mcp.json 文件（支持 flat 和嵌套 mcpServers 两种格式）。 */
function parseMcpFile(filePath: string): MCPServerConfig[] {
  if (!existsSync(filePath)) return [];

  let raw: Record<string, Record<string, unknown>>;
  try {
    const content = readFileSync(filePath, "utf-8");
    raw = JSON.parse(content) as Record<string, Record<string, unknown>>;
  } catch {
    return [];
  }

  // 支持 { "mcpServers": { ... } } 嵌套格式
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
