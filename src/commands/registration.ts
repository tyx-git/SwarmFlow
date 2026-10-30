/** 内置命令注册表装配（buildDefaultRegistry）。 */

import { cmdHooks, hooksOptions } from "./ecosystem/hooks.js";
import { cmdMcp, mcpOptions } from "./ecosystem/mcp.js";
import { cmdSkills, cmdSkillsCreater, skillsOptions } from "./ecosystem/skills.js";
import { modelOptions } from "./model/picker-options.js";
import { cmdAgents, subagentRoleOptions } from "./model/subagents.js";
import { cmdModel } from "./model/switch.js";
import { providerOptions } from "./provider/options.js";
import { cmdProvider } from "./provider/switch.js";
import { CommandRegistry, registerBuiltin } from "./registry.js";
import {
  cmdClear,
  cmdHelp,
  cmdMemory,
  cmdStatus,
  cmdUsage,
} from "./session/help.js";
import {
  cmdCompact,
  cmdFork,
  cmdHistory,
  cmdNew,
  cmdReload,
  cmdRename,
  cmdShells,
} from "./session/lifecycle.js";
import { cmdRewind, rewindOptions } from "./session/rewind.js";
import { cmdLanguage, languageOptions } from "./ui/language.js";
import { cmdPermission, permissionOptions } from "./ui/permission.js";
import { cmdTheme, themeModeOptions } from "./ui/theme.js";
import { cmdDiff } from "./workflow/diff.js";
import {
  cmdAsk,
  cmdFix,
  cmdGoal,
  cmdInit,
  cmdPlan,
} from "./workflow/goal.js";
import { cmdReviewer, reviewOptions } from "./workflow/review.js";

/**
 * Build the default command registry with all built-in commands.
 */
export function buildDefaultRegistry(): CommandRegistry {
  const registry = new CommandRegistry();
  registerBuiltin(registry, { name: "/help", handler: cmdHelp, executionMode: "whenBusy", category: "Session" });
  registerBuiltin(registry, { name: "/usage", handler: cmdUsage, executionMode: "always", category: "Session" });
  registerBuiltin(registry, { name: "/new", handler: cmdNew, executionMode: "always", category: "Session" });
  registerBuiltin(registry, { name: "/rename", handler: cmdRename, executionMode: "whenBusy", category: "Session" });
  registerBuiltin(registry, { name: "/status", handler: cmdStatus, executionMode: "always", category: "Session" });
  registerBuiltin(registry, { name: "/history", handler: cmdHistory, executionMode: "always", category: "Session" });

  registerBuiltin(registry, { name: "/compact", handler: cmdCompact, executionMode: "queued", category: "Context" });
  registerBuiltin(registry, { name: "/clear", handler: cmdClear, executionMode: "always", category: "Context" });
  registerBuiltin(registry, { name: "/fork", handler: cmdFork, category: "Context" });
  registerBuiltin(registry, { name: "/ps", handler: cmdShells, executionMode: "always", category: "Context" });
  registerBuiltin(registry, { name: "/ask", handler: cmdAsk, category: "Context" });

  registerBuiltin(registry, { name: "/init", handler: cmdInit, category: "Workflow" });
  registerBuiltin(registry, { name: "/plan", handler: cmdPlan, executionMode: "queued", category: "Workflow" });
  registerBuiltin(registry, { name: "/goal", handler: cmdGoal, category: "Workflow" });
  registerBuiltin(registry, { name: "/fix", handler: cmdFix, category: "Workflow" });
  registerBuiltin(registry, { name: "/reviewer", handler: cmdReviewer, options: reviewOptions, picker: { title: "Reviewer", inputArea: true }, category: "Workflow" });
  registerBuiltin(registry, { name: "/diff", handler: cmdDiff, executionMode: "whenBusy", category: "Workflow" });

  registerBuiltin(registry, { name: "/provider", handler: cmdProvider, options: providerOptions, picker: { title: "Providers", inputArea: true }, category: "Provider and Model" });
  registerBuiltin(registry, { name: "/model", handler: cmdModel, options: modelOptions, picker: { inputArea: true, mode: "single" }, category: "Provider and Model" });
  registerBuiltin(registry, { name: "/agents", handler: cmdAgents, options: subagentRoleOptions, picker: { inputArea: true, mode: "single" }, pickerFlow: "handler", category: "Provider and Model" });
  registerBuiltin(registry, { name: "/permission", handler: cmdPermission, options: permissionOptions, picker: { inputArea: true }, category: "Provider and Model" });

  registerBuiltin(registry, { name: "/skills", handler: cmdSkills, options: skillsOptions, picker: { title: "Skills", inputArea: true, mode: "toggle" }, pickerFlow: "handler", category: "Ecosystem" });
  registerBuiltin(registry, { name: "/skills-creater", handler: cmdSkillsCreater, category: "Ecosystem" });
  registerBuiltin(registry, { name: "/mcp", handler: cmdMcp, options: mcpOptions, picker: { title: "MCP Servers", inputArea: true }, category: "Ecosystem" });
  registerBuiltin(registry, { name: "/hooks", handler: cmdHooks, options: hooksOptions, picker: { title: "Hooks", inputArea: true }, category: "Ecosystem" });
  registerBuiltin(registry, { name: "/memory", handler: cmdMemory, executionMode: "always", category: "Ecosystem" });
  registerBuiltin(registry, { name: "/reload", handler: cmdReload, executionMode: "queued", category: "Project Configuration" });
  registerBuiltin(registry, { name: "/theme", handler: cmdTheme, options: themeModeOptions, picker: { inputArea: true }, executionMode: "whenBusy", category: "UI" });
  registerBuiltin(registry, { name: "/language", handler: cmdLanguage, options: languageOptions, picker: { inputArea: true }, executionMode: "whenBusy", category: "UI" });
  registerBuiltin(registry, { name: "/rewind", handler: cmdRewind, options: rewindOptions, picker: { title: "Rewind", inputArea: true }, category: "Context" });
  return registry;
}

// ------------------------------------------------------------------
// Fork
// ------------------------------------------------------------------
