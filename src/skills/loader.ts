/**
 * Skill discovery and loading.
 *
 * Skills are reusable prompt expansions defined as SKILL.md files
 * with YAML frontmatter + markdown instructions. Aligned with the
 * Agent Skills open standard (https://agentskills.io).
 *
 * Directory layout:
 *
 *   skills/
 *   +-- explain-code/
 *   |   +-- SKILL.md          # required
 *   |   +-- scripts/          # optional helper scripts
 *   |   +-- references/       # optional docs
 *   +-- deploy/
 *       +-- SKILL.md
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import * as yaml from "js-yaml";

// ------------------------------------------------------------------
// Types
// ------------------------------------------------------------------

export interface SkillMeta {
  /** Skill identifier 鈥?also becomes the /slash-command name. */
  name: string;
  /** Description of when to use this skill. */
  description: string;
  /** If true, only the user can invoke via /name (agent cannot call skill tool). */
  disableModelInvocation: boolean;
  /** If false, skill is hidden from the / menu (only agent can invoke). */
  userInvocable: boolean;
  /** Absolute path to the skill directory. */
  dir: string;
  /** SKILL.md body after frontmatter (raw markdown). */
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
 * Split a SKILL.md file into YAML frontmatter and markdown body.
 * Returns null if no valid frontmatter is found.
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
// Skill loading
// ------------------------------------------------------------------

/**
 * Discover and load all skills from a skills root directory.
 *
 * Each subdirectory containing a SKILL.md file is treated as a skill.
 * Parse errors are warned and skipped.
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
        // No frontmatter 鈥?use directory name and full content
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
