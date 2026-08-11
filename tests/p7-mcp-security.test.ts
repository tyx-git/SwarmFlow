import { chmodSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { Session } from "../src/session.js";
import {
  buildMcpServerEnv,
  ensureCredentialFilePermissions,
  validateMcpSseUrl,
} from "../src/clients/mcp-client.js";

function makeTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function makeSessionLike(projectRoot: string, mcpSensitiveTools?: string[]): any {
  const s = Object.create(Session.prototype) as any;
  s.primaryAgent = { name: "Primary", modelConfig: { supportsMultimodal: false } };
  s._progress = undefined;
  s._turnCount = 1;
  s._activeAsk = null;
  s._askHistory = [];
  s._pendingTurnState = null;
  s._projectRoot = projectRoot;
  s._createdAt = new Date().toISOString();
  s._compactCount = 0;
  s._usedContextIds = new Set<string>();
  s._thinkingLevel = "default";
  s._currentMasterPlan = undefined;
  s._currentPhasePlan = undefined;
  s._planAdvancePhasePlan = undefined;
  s._activeAgents = new Map();
  s.onSaveRequest = undefined;
  s._ensureMcp = async () => {};
  s.config = {
    mcpServerConfigs: [
      {
        name: "docs",
        transport: "stdio",
        command: "dummy",
        args: [],
        url: "",
        env: {},
        sensitiveTools: mcpSensitiveTools,
      },
    ],
  };
  return s;
}

describe("P7 MCP env whitelist and URL validation", () => {
  it("filters inherited env and keeps explicit cfg.env", () => {
    const env = buildMcpServerEnv(
      {
        name: "docs",
        transport: "stdio",
        command: "dummy",
        args: [],
        url: "",
        env: { API_TOKEN: "cfg-token" },
        envAllowlist: ["CUSTOM_ALLOWED"],
      },
      {
        PATH: "/usr/bin",
        HOME: "/tmp/home",
        CUSTOM_ALLOWED: "yes",
        SUPER_SECRET: "nope",
      },
    );

    expect(env["PATH"]).toBe("/usr/bin");
    expect(env["HOME"]).toBe("/tmp/home");
    expect(env["CUSTOM_ALLOWED"]).toBe("yes");
    expect(env["API_TOKEN"]).toBe("cfg-token");
    expect(env["SUPER_SECRET"]).toBeUndefined();
  });

  it("rejects SSE URLs with embedded credentials or non-http schemes", () => {
    expect(() => validateMcpSseUrl("docs", "https://user:pass@example.com/sse")).toThrow(
      /must not embed credentials/i,
    );
    expect(() => validateMcpSseUrl("docs", "file:///tmp/sse")).toThrow(
      /http\/https/i,
    );
    expect(validateMcpSseUrl("docs", "https://example.com/sse").protocol).toBe("https:");
  });
});

describe("P7 MCP credential file permissions", () => {
  it("tightens credential file permissions to 0o600 on POSIX", () => {
    const dir = makeTempDir("swarmflow-p7-mcp-creds-");
    try {
      const credFile = join(dir, "gcp-creds.json");
      writeFileSync(credFile, "{\"k\":\"v\"}\n", "utf-8");
      if (process.platform !== "win32") {
        chmodSync(credFile, 0o644);
      }

      ensureCredentialFilePermissions("docs", {
        GOOGLE_APPLICATION_CREDENTIALS: credFile,
      });

      if (process.platform !== "win32") {
        expect(statSync(credFile).mode & 0o777).toBe(0o600);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("P7 sensitive MCP tool approvals", () => {
  it("removes MCP permission-ask helpers from the session runtime", () => {
    expect((Session.prototype as any)._requestPermissionOrAsk).toBeUndefined();
    expect((Session.prototype as any)._isSensitiveMcpTool).toBeUndefined();
  });

  it("keeps config-level sensitive_tools metadata without runtime gating", () => {
    const root = makeTempDir("swarmflow-p7-mcp-pattern-");
    try {
      const s = makeSessionLike(root, ["publish_*"]);
      expect(Array.isArray(s.config.mcpServerConfigs[0].sensitiveTools)).toBe(true);
      expect(s.config.mcpServerConfigs[0].sensitiveTools).toContain("publish_*");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
