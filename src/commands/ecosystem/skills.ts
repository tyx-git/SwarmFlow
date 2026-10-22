/** /skills 技能可用性管理、技能斜杠命令注册与重载同步。 */

import { join } from "node:path";

import { resolveSkillContent, type SkillMeta } from "../../skills/loader.js";

import { createUiText, getUiLanguage, type UiText } from "../../ui/text.js";

import { CommandRegistry } from "../registry.js";
import { persistSettingsPatch } from "../settings-patch.js";
import {
  type CommandCategory,
  type CommandContext,
  type CommandOption,
  type CommandOptionsContext,
} from "../types.js";

function skillText(ctx: CommandContext): UiText {
  return createUiText(getUiLanguage(ctx.swarmflowHomeDir));
}

export function skillsOptions(ctx: CommandOptionsContext): CommandOption[] {
  const session = ctx.session;
  if (!session?.getAllSkillNames) return [];
  const t = createUiText(getUiLanguage(ctx.swarmflowHomeDir));
  return session
    .getAllSkillNames()
    .sort((a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name))
    .map((skill: { name: string; description: string; enabled: boolean }) => ({
      // The picker renders `label` as the flexible left/middle column and
      // `detail` as the fixed right status column. Description truncation is
      // therefore based on the actual terminal width, rather than a fixed
      // character limit.
      label: skill.description.trim(),
      labelPrefix: skill.name,
      value: skill.name,
      detail: skill.enabled
        ? t.get(["Commands", "/skills", "enabled"])
        : t.get(["Commands", "/skills", "disabled"]),
      detailColor: skill.enabled ? "success" : "error",
    }));
}

function persistSkillAvailability(ctx: CommandContext, name: string, enabled: boolean): void {
  const session = ctx.session;
  // 只更新选择并持久化。skills 属于 tools/system 前缀的一部分，
  // 立即重扫会让当前会话的缓存前缀失效；显式 /reload 才应用变更。
  session.setSkillEnabled(name, enabled);
  const allSkills = session.getAllSkillNames?.() ?? [];
  const disabledSkills = allSkills
    .filter((skill: { enabled: boolean }) => !skill.enabled)
    .map((skill: { name: string }) => skill.name);
  persistSettingsPatch(
    { disabled_skills: disabledSkills.length > 0 ? disabledSkills : undefined },
    ctx.swarmflowHomeDir,
  );
}

export async function cmdSkills(ctx: CommandContext, args: string): Promise<void> {
  const session = ctx.session;
  const t = skillText(ctx);
  if (!session?.getAllSkillNames) {
    ctx.showMessage(t.get(["Commands", "/skills", "unavailable"]));
    return;
  }
  const name = args.trim();
  if (name) {
    const skill = session.getAllSkillNames().find((item: { name: string }) => item.name === name);
    if (!skill) {
      ctx.showMessage(t.get(["Commands", "/skills", "unknown"], { name }));
      return;
    }
    persistSkillAvailability(ctx, name, !skill.enabled);
    (ctx.showHint ?? ctx.showMessage)(
      `${name}: ${skill.enabled ? t.get(["Commands", "/skills", "disabled"]) : t.get(["Commands", "/skills", "enabled"])}. Run /reload to apply.`,
    );
    return;
  }

  const availableSkills = session.getAllSkillNames();
  if (availableSkills.length === 0) {
    ctx.showMessage(t.get(["Commands", "/skills", "empty"]));
    return;
  }

  if (ctx.promptCommandPicker) {
    for (;;) {
      const picked = await ctx.promptCommandPicker(
        skillsOptions({ session, store: ctx.store, swarmflowHomeDir: ctx.swarmflowHomeDir }),
        {
          title: t.get(["Commands", "/skills", "title"]),
          inputArea: true,
          mode: "toggle",
        },
      );
      if (!picked) return;
      const selected = session.getAllSkillNames().find((item: { name: string }) => item.name === picked.value);
      if (!selected) return;
      persistSkillAvailability(ctx, selected.name, !selected.enabled);
    }
  }

  const allSkills = session.getAllSkillNames();
  ctx.showMessage(allSkills.map((skill: { name: string; description: string; enabled: boolean }) =>
    `${skill.name} ${skill.description.trim()} ${skill.enabled
      ? t.get(["Commands", "/skills", "enabled"])
      : t.get(["Commands", "/skills", "disabled"])}`,
  ).join("\n"));
}

export async function cmdSkillsCreater(ctx: CommandContext, args: string): Promise<void> {
  const requirement = args.trim();
  const prompt = [
    "Act as the SwarmFlow skill creator.",
    "Follow a plan-like clarification workflow: first understand the user's intended skill behavior before editing files.",
    "Clarify purpose, trigger conditions, inputs, outputs, examples, tool constraints, compatibility with Codex and Claude Code, and the lowercase hyphenated skill name.",
    "Present a concise SKILL.md draft and explicitly wait for the user's confirmation.",
    "Only after explicit confirmation create ~/.swarmflow/skills/<skill-name>/SKILL.md. Do not overwrite an existing skill without permission.",
    "After writing, report the exact path and ask the runtime to reload skills if needed.",
    requirement ? `Initial user requirement: ${requirement}` : "The user has not supplied a requirement yet; ask for it.",
  ].join("\n");
  if (ctx.onInjectedTurnRequested) {
    ctx.onInjectedTurnRequested(requirement ? `/skills-creater ${requirement}` : "/skills-creater", prompt);
  } else if (ctx.onTurnRequested) {
    ctx.onTurnRequested(prompt);
  } else {
    ctx.showMessage(prompt);
  }
}

// ------------------------------------------------------------------
// 技能命令注册
// ------------------------------------------------------------------

/**
 * Register slash commands for user-invocable skills.
 *
 * Each skill with `userInvocable === true` gets a `/skill-name` command.
 * When invoked, the skill content is injected and a turn is triggered.
 */
export function registerSkillCommands(
  registry: CommandRegistry,
  skills: ReadonlyMap<string, SkillMeta>,
): void {
  const sortedSkills = [...skills.values()].sort((a, b) => a.name.localeCompare(b.name));
  for (const skill of sortedSkills) {
    if (!skill.userInvocable) continue;

    // 跳过与内置命令名称冲突的技能
    const cmdName = "/" + skill.name;
    if (registry.lookup(cmdName)) {
      console.warn(`Skill "${skill.name}" skipped: conflicts with built-in command ${cmdName}`);
      continue;
    }

    const captured = skill; // capture for closure
    registry.register({
      name: cmdName,
      description: captured.description,
      category: "User Custom" as CommandCategory,
      handler: async (ctx: CommandContext, args: string) => {
        const content = resolveSkillContent(captured, args);
        const tagged = `[SKILL: ${captured.name}]\n\n${content}`;
        const displayText = args.trim()
          ? `/${captured.name} ${args.trim()}`
          : `/${captured.name}`;
        if (ctx.onInjectedTurnRequested) {
          ctx.onInjectedTurnRequested(displayText, tagged);
        } else if (ctx.onTurnRequested) {
          ctx.onTurnRequested(tagged);
        }
      },
    });
  }
}

/**
 * Unregister old skill commands, then register new ones.
 * Used after reloadSkills() to keep slash commands in sync.
 */
export function reRegisterSkillCommands(
  registry: CommandRegistry,
  oldSkills: ReadonlyMap<string, SkillMeta>,
  newSkills: ReadonlyMap<string, SkillMeta>,
): void {
  for (const skill of oldSkills.values()) {
    if (!skill.userInvocable) continue;
    const commandName = "/" + skill.name;
    if (registry.lookup(commandName)?.category === "User Custom") {
      registry.unregister(commandName);
    }
  }
  registerSkillCommands(registry, newSkills);
}

// ------------------------------------------------------------------
// /permission -设置权限模式
// ------------------------------------------------------------------
