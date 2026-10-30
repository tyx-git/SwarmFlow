/**
 * 技能集合的启停、重扫与 skill 工具执行。
 *
 * 只搬"哪些技能可用 / 何时重扫 / 如何执行 skill 工具"这层；技能内容解析仍由 skills/loader 负责。
 */

import type { Agent } from "../agents/agent.js";
import { ToolResult } from "../providers/response.js";
import { ensureSkillTool } from "../tools/runtime.js";
import { loadSkillsMulti, resolveSkillContent, type SkillMeta } from "../skills/loader.js";
import type { SessionCapabilities } from "./capabilities.js";

/** 技能管理所需的会话侧成员（B 策略下由 Session 公开）。 */
export interface SkillsHost {
  primaryAgent: Agent;
  _capabilities: SessionCapabilities;
  _skills: Map<string, SkillMeta>;
  _disabledSkills: Set<string>;
  _skillRoots: string[];
  _skillsDirty: boolean;
}

/** 已加载技能的只读视图（供命令注册使用）。 */
export function getSkills(host: SkillsHost): ReadonlyMap<string, SkillMeta> {
  return host._skills;
}

/** 已禁用技能名的只读视图。 */
export function getDisabledSkills(host: SkillsHost): ReadonlySet<string> {
  return host._disabledSkills;
}

/**
 * 返回磁盘上的全部技能（含启用与禁用），供 UI 展示。
 */
export function getAllSkillNames(host: SkillsHost): { name: string; description: string; enabled: boolean }[] {
  const allOnDisk = loadSkillsMulti(host._skillRoots);
  return [...allOnDisk.values()].map((s) => ({
    name: s.name,
    description: s.description,
    enabled: !host._disabledSkills.has(s.name),
  }));
}

/** 是否存在尚未通过 /reload 应用的 skill 变更。 */
export function skillsDirty(host: SkillsHost): boolean {
  return host._skillsDirty;
}

/** 按名称启用或禁用技能。调用 applySkillsFromCommand() 才会生效。 */
export function setSkillEnabled(host: SkillsHost, name: string, enabled: boolean): void {
  if (enabled) {
    host._disabledSkills.delete(name);
  } else {
    host._disabledSkills.add(name);
  }
  host._skillsDirty = true;
}

/**
 * 重扫技能目录，应用禁用过滤，并重建 skill 工具定义。
 * /skills 会立即调用；/reload 作为完整配置重载的一部分也会调用。
 * 返回变更报告，供需要的调用方使用。
 */
export function reloadSkills(host: SkillsHost): { added: string[]; removed: string[]; total: number } {
  const oldNames = new Set(host._skills.keys());
  refreshSkills(host, );
  const newNames = new Set(host._skills.keys());

  const added = [...newNames].filter((n) => !oldNames.has(n));
  const removed = [...oldNames].filter((n) => !newNames.has(n));

  return { added, removed, total: host._skills.size };
}

/**
 * 构建固定的 `skill` 工具定义。
 *
 * skills 列表位于 system prompt；工具的 description 不随 skills 集合变化，
 * 从而保持 tools 段字节稳定。
 */
export function ensureSkillToolForSession(host: SkillsHost): void {
  host.primaryAgent.tools = ensureSkillTool(
    host.primaryAgent.tools,
    host._capabilities,
  );
}

/**
 * 从磁盘刷新技能。prompt/tool 重载时调用，
 * 使新增、删除或修改的技能同步到动态的 skill 工具定义。
 */
export function refreshSkills(host: SkillsHost): void {
  if (host._skillRoots.length === 0) {
    host._skillsDirty = false;
    return;
  }
  const freshAll = loadSkillsMulti(host._skillRoots);
  const filtered = new Map<string, SkillMeta>();
  for (const [name, skill] of freshAll) {
    if (!host._disabledSkills.has(name)) {
      filtered.set(name, skill);
    }
  }
  host._skills = filtered;
  host._skillsDirty = false;
  ensureSkillToolForSession(host, );
}

/** 执行 `skill` 工具：加载并返回技能说明。 */
export function execSkill(host: SkillsHost, 
  args: Record<string, unknown>,
): ToolResult {
  const name = ((args["name"] as string) ?? "").replace(/\uFEFF/g, "").trim();
  if (!name) {
    return new ToolResult({ content: "Error: 'name' parameter is required." });
  }

  const skill = host._skills.get(name);
  if (!skill) {
    const available = [...host._skills.keys()].join(", ");
    return new ToolResult({
      content: `Error: Unknown skill "${name}". Available: ${available || "(none)"}`,
    });
  }

  if (skill.disableModelInvocation) {
    return new ToolResult({
      content: `Error: Skill "${name}" can only be invoked by the user via /${name}.`,
    });
  }

  const skillArgs = ((args["arguments"] as string) ?? "").trim();
  const content = resolveSkillContent(skill, skillArgs);

  return new ToolResult({
    content:
      `[SKILL: ${skill.name}]\n` +
      `Skill directory: ${skill.dir}\n\n` +
      content,
  });
}
