import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { buildDefaultRegistry, type CommandContext } from "../src/commands/commands.js";
import { registerMcpTools } from "../src/lib/tool-runtime.js";

function makeContext(
  registry: ReturnType<typeof buildDefaultRegistry>,
  session: Record<string, unknown>,
  overrides: Partial<CommandContext> = {},
): CommandContext {
  return {
    session,
    showMessage: vi.fn(),
    autoSave: vi.fn(),
    resetUiState: vi.fn(),
    commandRegistry: registry,
    ...overrides,
  };
}

describe("/mcp command", () => {
  it("connects MCP servers before rendering the status summary", async () => {
    const homeDir = mkdtempSync(join(tmpdir(), "swarmflow-mcp-command-"));
    const registry = buildDefaultRegistry();
    const cmd = registry.lookup("/mcp");
    expect(cmd).toBeTruthy();

    try {
      writeFileSync(
        join(homeDir, "settings.json"),
        JSON.stringify({
          mcp_servers: {
            sqlite: {
              transport: "stdio",
              command: "sqlite-mcp",
            },
          },
        }),
      );

      const ensureMcpReady = vi.fn(async () => {});
      const session = {
        ensureMcpReady,
        mcpManager: {
          getAllTools: () => [
            { name: "mcp__sqlite__query" },
            { name: "mcp__sqlite__schema" },
          ],
        },
      };

      const ctx = makeContext(
        registry,
        session,
        { swarmflowHomeDir: homeDir } as Partial<CommandContext>,
      );
      await cmd!.handler(ctx, "");

      expect(ensureMcpReady).toHaveBeenCalledTimes(1);
      const rendered = (ctx.showMessage as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as string;
      expect(rendered).toContain("MCP: 1 server(s), 1 enabled");
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });
});

describe("MCP runtime registration", () => {
  it("removes stale MCP tool schemas and executors after reload", async () => {
    const readTool = {
      name: "read_file",
      description: "Read",
      parameters: { type: "object", properties: {} },
    };
    const skillTool = {
      name: "skill",
      description: "Skill",
      parameters: { type: "object", properties: {} },
    };
    const docsTool = {
      name: "mcp__docs__search",
      description: "Search docs",
      parameters: { type: "object", properties: {} },
    };
    const dbTool = {
      name: "mcp__db__query",
      description: "Query db",
      parameters: { type: "object", properties: {} },
    };
    const dbToolReloaded = {
      name: "mcp__db__query",
      description: "Query db v2",
      parameters: {
        type: "object",
        properties: { sql: { type: "string" } },
        required: ["sql"],
      },
    };

    let currentTools = [docsTool, dbTool];
    const manager = {
      connectAll: vi.fn(async () => {}),
      getAllTools: () => currentTools,
      callTool: vi.fn(async (name: string) => ({ content: `called ${name}` })),
    };
    const executors: Record<string, any> = {};
    const agent = {
      tools: [readTool, skillTool],
      _mcpToolsSpec: "all",
    };

    await registerMcpTools(manager as any, executors, [agent as any]);

    expect(agent.tools.map((t) => t.name)).toEqual([
      "read_file",
      "mcp__docs__search",
      "mcp__db__query",
      "skill",
    ]);
    expect(executors["mcp__docs__search"]).toBeTruthy();
    expect(executors["mcp__db__query"]).toBeTruthy();

    currentTools = [dbToolReloaded];
    await registerMcpTools(manager as any, executors, [agent as any]);

    expect(agent.tools.map((t) => t.name)).toEqual([
      "read_file",
      "mcp__db__query",
      "skill",
    ]);
    expect(agent.tools.find((t) => t.name === "mcp__db__query")?.description).toBe("Query db v2");
    expect(executors["mcp__docs__search"]).toBeUndefined();
    expect(executors["mcp__db__query"]).toBeTruthy();
  });
});
