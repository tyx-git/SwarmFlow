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

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import * as yaml from "js-yaml";

// ------------------------------------------------------------------
// Types
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

// ------------------------------------------------------------------
// Frontmatter parsing
// ------------------------------------------------------------------

interface ParsedSkillMd {
  frontmatter: Record<string, unknown>;
  body: string;
}

/**
 * 将 SKILL.md 文件拆分为 YAML frontmatter 和 markdown 正文。
 * 如果未找到有效的 frontmatter，则返回 null。
 */
function parseSkillMd(raw: string): ParsedSkillMd | null {
  const trimmed = raw.trimStart();
  if (!trimmed.startsWith("---")) return null;

  // Find closing ---
  const endIdx = trimmed.indexOf("\n---", 3);
  if (endIdx === -1) return null;

  const yamlStr = trimmed.slice(3, endIdx).trim();
  const body = trimmed.slice(endIdx + 4).trim(); // skip past \n---

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

  for (const entry of readdirSync(skillsRoot)) {
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
        name = typeof fm["name"] === "string" ? fm["name"] : entry;
        description = typeof fm["description"] === "string"
          ? fm["description"]
          : extractFirstParagraph(parsed.body);
        disableModelInvocation = fm["disable-model-invocation"] === true;
        userInvocable = fm["user-invocable"] !== false;
        body = parsed.body;
      } else {
        // No frontmatter —use directory name and full content
        name = entry;
        description = extractFirstParagraph(raw);
        body = raw;
      }

      // Validate name: lowercase letters, numbers, hyphens only
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
// Argument substitution
// ------------------------------------------------------------------

/**
 * Resolve a skill's content by substituting `$ARGUMENTS`, `$ARGUMENTS[N]`,
 * and `$N` placeholders with the provided arguments string.
 */
export function resolveSkillContent(skill: SkillMeta, args: string): string {
  const parts = args.trim() ? args.trim().split(/\s+/) : [];
  let content = skill.contentRaw;

  // Replace positional: $ARGUMENTS[N] and $N (longest match first)
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

  // Replace $ARGUMENTS (full string)
  content = content.replace(/\$ARGUMENTS/g, args.trim());

  return content;
}

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------

/**
 * Load skills from multiple root directories (e.g. bundled + user).
 * Later roots override earlier ones by skill name.
 */
export function loadSkillsMulti(roots: string[]): Map<string, SkillMeta> {
  const merged = new Map<string, SkillMeta>();
  for (const root of roots) {
    if (!existsSync(root) || !statSync(root).isDirectory()) continue;
    const found = loadSkills(root);
    for (const [name, skill] of found) {
      merged.set(name, skill); // later roots override earlier (user > bundled)
    }
  }
  return merged;
}

/** Extract the first non-empty paragraph from markdown text. */
function extractFirstParagraph(text: string): string {
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith("#")) {
      return trimmed.length > 120 ? trimmed.slice(0, 117) + "..." : trimmed;
    }
  }
  return "(no description)";
}
