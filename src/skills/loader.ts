/**
 * Skill 发现和加载。
 *
 * Skills 是可重用的提示扩展，定义为带有 YAML frontmatter + markdown
 * 说明的 SKILL.md 文件。与 Agent Skills 开放标准
 *（https://agentskills.io）对齐。
 *
 * 目录布局：
 *
 *   skills/
 *   +-- explain-code/
 *   |   +-- SKILL.md          # 必需
 *   |   +-- scripts/          # 可选辅助脚本
 *   |   +-- references/       # 可选文档
 *   +-- deploy/
 *       +-- SKILL.md
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as yaml from "js-yaml";

// ------------------------------------------------------------------
// 类型
// ------------------------------------------------------------------

export interface SkillMeta {
  /** Skill 标识符 — 也是 /斜杠命令名称。*/
  name: string;
  /** 描述何时使用此 skill。*/
  description: string;
  /** 如果为 true，仅用户可通过 /name 调用（agent 不能调用 skill 工具）。*/
  disableModelInvocation: boolean;
  /** 如果为 false，skill 从 / 菜单隐藏（仅 agent 可调用）。*/
  userInvocable: boolean;
  /** Skill 目录的绝对路径。*/
  dir: string;
  /** frontmatter 之后的 SKILL.md 正文（原始 markdown）。*/
  contentRaw: string;
}

/**
 * 内置 `/skills-creater` 工作流使用的 Skill 定义。
 *
 * 首次启动时复制到用户的全局 skill 目录，使该工作流保持可查看，
 * 并与其他 Agent Skills 客户端兼容。仅在文件缺失时创建，不覆盖用户的修改。
 */
export const BUILTIN_SKILL_DEFINITIONS: ReadonlyArray<{ name: string; content: string }> = [
  {
    name: "skills-creater",
    content: `---
name: skills-creater
description: Guide the user through designing and creating a compatible Agent Skill.
disable-model-invocation: true
user-invocable: false
---

# Skill creator workflow

Clarify the user's goal, triggers, inputs, outputs, examples, and constraints before writing anything. Present a concise SKILL.md draft and wait for explicit confirmation. After confirmation, create the skill under \`~/.swarmflow/skills/<skill-name>/SKILL.md\` with lowercase hyphenated naming and frontmatter compatible with Codex and Claude Code. Do not write the file before confirmation and do not overwrite an existing skill without permission.
`,
  },
];

/** 确保内置的 skill 创建器工作流存在于全局 skill 目录中。 */
export function ensureBuiltinSkills(globalSkillsRoot: string): void {
  try {
    mkdirSync(globalSkillsRoot, { recursive: true });
    for (const definition of BUILTIN_SKILL_DEFINITIONS) {
      const dir = join(globalSkillsRoot, definition.name);
      const skillMd = join(dir, "SKILL.md");
      if (existsSync(skillMd)) continue;
      mkdirSync(dir, { recursive: true });
      writeFileSync(skillMd, definition.content, "utf-8");
    }
  } catch (error) {
    // 家目录只读不应阻止运行时启动；即使 skill 文件没能落盘，
    // 受保护的命令仍然可用。
    console.warn(
      `Unable to initialize built-in skills: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

// ------------------------------------------------------------------
// frontmatter 解析
// ------------------------------------------------------------------

interface ParsedSkillMd {
  frontmatter: Record<string, unknown>;
  body: string;
}

/** Windows 记事本等编辑器可能在字段前保留 BOM；名称/描述进入命令与 UI 前移除。 */
function stripBom(value: string): string {
  return value.replace(/\uFEFF/g, "");
}

/**
 * 将 SKILL.md 文件拆分为 YAML frontmatter 和 markdown 正文。
 * 如果未找到有效的 frontmatter，则返回 null。
 */
function parseSkillMd(raw: string): ParsedSkillMd | null {
  const trimmed = raw.trimStart();
  if (!trimmed.startsWith("---")) return null;

  // 查找结束的 ---
  const endIdx = trimmed.indexOf("\n---", 3);
  if (endIdx === -1) return null;

  const yamlStr = trimmed.slice(3, endIdx).trim();
  const body = trimmed.slice(endIdx + 4).trim(); // 跳过 \n---

  let frontmatter: Record<string, unknown>;
  try {
    const parsed = yaml.load(yamlStr);
    if (typeof parsed !== "object" || parsed === null) return null;
    frontmatter = parsed as Record<string, unknown>;
  } catch {
    return null;
  }

  return { frontmatter, body };
}

// ------------------------------------------------------------------
// Skill 加载
// ------------------------------------------------------------------

/**
 * 从 skills 根目录发现并加载所有 skills。
 *
 * 每个包含 SKILL.md 文件的子目录被视为一个 skill。
 * 解析错误会发出警告并跳过。
 */
export function loadSkills(skillsRoot: string): Map<string, SkillMeta> {
  const skills = new Map<string, SkillMeta>();

  if (!existsSync(skillsRoot) || !statSync(skillsRoot).isDirectory()) {
    return skills;
  }

  // 排序后再扫描：目录枚举顺序依赖文件系统，直接使用会让 tools/system
  // 的 skills 列表在重启后出现字节差异，破坏提示缓存。
  for (const entry of [...readdirSync(skillsRoot)].sort()) {
    if (entry === ".staging") continue;
    const dirPath = join(skillsRoot, entry);
    if (!statSync(dirPath).isDirectory()) continue;

    const skillMdPath = join(dirPath, "SKILL.md");
    if (!existsSync(skillMdPath)) continue;

    try {
      const raw = readFileSync(skillMdPath, "utf-8");
      const parsed = parseSkillMd(raw);

      let name: string;
      let description: string;
      let disableModelInvocation = false;
      let userInvocable = true;
      let body: string;

      if (parsed) {
        const fm = parsed.frontmatter;
        name = stripBom(typeof fm["name"] === "string" ? fm["name"] : entry).trim();
        description = stripBom(
          typeof fm["description"] === "string"
            ? fm["description"]
            : extractFirstParagraph(parsed.body),
        ).trim();
        disableModelInvocation = fm["disable-model-invocation"] === true;
        userInvocable = fm["user-invocable"] !== false;
        body = parsed.body;
      } else {
        // 没有 frontmatter——用目录名和完整内容
        name = stripBom(entry).trim();
        description = stripBom(extractFirstParagraph(raw)).trim();
        body = raw;
      }

      // 校验名称：仅允许小写字母、数字和连字符
      if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) {
        console.warn(
          `Skill "${entry}": invalid name "${name}" (must be lowercase alphanumeric + hyphens). Skipping.`,
        );
        continue;
      }

      if (skills.has(name)) {
        console.warn(
          `Skill "${entry}": duplicate name "${name}". Skipping.`,
        );
        continue;
      }

      skills.set(name, {
        name,
        description,
        disableModelInvocation,
        userInvocable,
        dir: dirPath,
        contentRaw: body,
      });
    } catch (e) {
      console.warn(
        `Skill "${entry}": failed to load SKILL.md: ${e instanceof Error ? e.message : e}`,
      );
    }
  }

  return skills;
}

// ------------------------------------------------------------------
// 参数替换
// ------------------------------------------------------------------

/**
 * 用传入的参数串替换 `$ARGUMENTS`、`$ARGUMENTS[N]` 和 `$N` 占位符，
 * 得到 skill 的最终内容。
 */
export function resolveSkillContent(skill: SkillMeta, args: string): string {
  const parts = args.trim() ? args.trim().split(/\s+/) : [];
  let content = skill.contentRaw;

  // 替换位置参数：$ARGUMENTS[N] 和 $N（优先匹配最长的）
  for (let i = parts.length - 1; i >= 0; i--) {
    content = content.replace(
      new RegExp(`\\$ARGUMENTS\\[${i}\\]`, "g"),
      parts[i],
    );
    content = content.replace(
      new RegExp(`\\$${i}(?![0-9])`, "g"),
      parts[i],
    );
  }

  // 替换 $ARGUMENTS（完整字符串）
  content = content.replace(/\$ARGUMENTS/g, args.trim());

  return content;
}

// ------------------------------------------------------------------
// 辅助函数
// ------------------------------------------------------------------

/**
 * 从多个根目录加载 skills（例如内置目录 + 用户目录）。
 * 同名 skill 由后面的根目录覆盖前面的。
 */
export function loadSkillsMulti(roots: string[]): Map<string, SkillMeta> {
  const merged = new Map<string, SkillMeta>();
  for (const root of roots) {
    if (!existsSync(root) || !statSync(root).isDirectory()) continue;
    const found = loadSkills(root);
    for (const [name, skill] of found) {
      merged.set(name, skill); // 后面的根目录覆盖前面的（用户 > 内置）
    }
  }
  return merged;
}

/** 提取 Markdown 文本中第一个非空段落。 */
function extractFirstParagraph(text: string): string {
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith("#")) {
      return trimmed.length > 120 ? trimmed.slice(0, 117) + "..." : trimmed;
    }
  }
  return "(no description)";
}
