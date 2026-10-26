/**
 * 提示词声明的工具必须与角色实际装配的工具一致。
 *
 * 角色工具 = 模板 tools/tool_tier + 运行期 comm/task/skill 能力工具；
 * Queen 的 send 只有在存在持久子代理时才追加，按动态工具放行。
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { Config } from "../../src/config/loader.js";
import { loadTemplate } from "../../src/prompts/templates.js";
import {
  CHILD_SESSION_CAPABILITIES,
  ROOT_SESSION_CAPABILITIES,
} from "../../src/session/capabilities.js";
import { SEND_TOOL } from "../../src/tools/comm.js";
import { ensureCommTools, ensureSkillTool, ensureTaskTools } from "../../src/tools/runtime.js";

const TEMPLATE_ROOT = join(process.cwd(), "prompts", "templates");
const ROOT_ROLES = new Set(["queen"]);

function makeConfig(): Config {
  const config = new Config({});
  config.upsertModelRaw("test-model", {
    provider: "openai",
    model: "gpt-test",
    api_key: "test-key",
  });
  return config;
}

/** 工具清单以 ### 标题和 `tool(...)` 签名为准，避免把普通参数名当成工具。 */
function documentedTools(text: string): string[] {
  const names = new Set<string>();
  for (const match of text.matchAll(/^###\s+`([a-z][a-z0-9_]*)`\s*$/gm)) {
    names.add(match[1]!);
  }
  for (const match of text.matchAll(/`([a-z][a-z0-9_]*)\(/g)) {
    names.add(match[1]!);
  }
  return [...names].sort();
}

const roles = readdirSync(TEMPLATE_ROOT)
  .filter((role) => {
    try {
      return statSync(join(TEMPLATE_ROOT, role, "agent.yaml")).isFile();
    } catch {
      return false;
    }
  })
  .sort();

describe("prompt tool registry consistency", () => {
  it.each(roles)("%s only documents tools granted to its role", (role) => {
    const templateDir = join(TEMPLATE_ROOT, role);
    const agent = loadTemplate(
      templateDir,
      makeConfig(),
      undefined,
      undefined,
      undefined,
      "test-model",
    );
    const capabilities = ROOT_ROLES.has(role)
      ? ROOT_SESSION_CAPABILITIES
      : CHILD_SESSION_CAPABILITIES;
    const tools = [...agent.tools];
    ensureCommTools(tools, capabilities);
    ensureTaskTools(tools, capabilities);
    const effectiveTools = ensureSkillTool(tools, capabilities);
    if (ROOT_ROLES.has(role)) effectiveTools.push(SEND_TOOL);

    const available = new Set(effectiveTools.map((tool) => tool.name));
    const documented = documentedTools(
      readFileSync(join(templateDir, "tools.md"), "utf-8"),
    );
    expect(documented.length).toBeGreaterThan(0);
    expect(documented.filter((name) => !available.has(name))).toEqual([]);
  });
});
