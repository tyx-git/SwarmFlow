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
 * 构建包含全部内置命令的默认命令注册表。
 */
export function buildDefaultRegistry(): CommandRegistry {
  const registry = new CommandRegistry();
  registerBuiltin(registry, { name: "/help", handler: cmdHelp, executionMode: "whenBusy", category: "Session" });
  registerBuiltin(registry, { name: "/usage", handler: cmdUsage, executionMode: "always", category: "Session" });
  registerBuiltin(registry, { name: "/new", handler: cmdNew, executionMode: "always", category: "Session" });
  registerBuiltin(registry, { name: "/rename", handler: cmdRename, executionMode: "whenBusy", selfEcho: true, category: "Session" });
  registerBuiltin(registry, { name: "/status", handler: cmdStatus, executionMode: "always", category: "Session" });
  registerBuiltin(registry, { name: "/history", handler: cmdHistory, executionMode: "always", category: "Session" });

  registerBuiltin(registry, { name: "/compact", handler: cmdCompact, executionMode: "queued", selfEcho: true, category: "Context" });
  registerBuiltin(registry, { name: "/clear", handler: cmdClear, executionMode: "always", category: "Context" });
  registerBuiltin(registry, { name: "/fork", handler: cmdFork, executionMode: "whenBusy", category: "Context" });
  registerBuiltin(registry, { name: "/ps", handler: cmdShells, executionMode: "always", category: "Context" });
  registerBuiltin(registry, { name: "/ask", handler: cmdAsk, selfEcho: true, category: "Context" });

  // 注入回合类命令：displayText 会作为 user_message 落进日志，就是用户看到的那一行。
  registerBuiltin(registry, { name: "/init", handler: cmdInit, selfEcho: true, category: "Workflow" });
  registerBuiltin(registry, { name: "/plan", handler: cmdPlan, executionMode: "queued", selfEcho: true, category: "Workflow" });
  registerBuiltin(registry, { name: "/goal", handler: cmdGoal, selfEcho: true, category: "Workflow" });
  registerBuiltin(registry, { name: "/fix", handler: cmdFix, selfEcho: true, category: "Workflow" });
  registerBuiltin(registry, { name: "/reviewer", handler: cmdReviewer, options: reviewOptions, picker: { title: "Reviewer", inputArea: true }, selfEcho: true, category: "Workflow" });
  registerBuiltin(registry, { name: "/diff", handler: cmdDiff, executionMode: "whenBusy", category: "Workflow" });

  // 切换类命令按副作用分档：只影响后续回合的配置（/agents、/permission、
  // /hooks）与自带回合守卫的 /fork 可在执行中直达；会把选择器交给命令自身
  // 处理且需要回合边界的（/provider、/skills、/mcp）排到回合结束后执行。
  // /model 无参数时依赖 UI 选择器入口，排队路径直接调 handler 会失去选择器，
  // 因此保持阻塞，不做排队。
  registerBuiltin(registry, { name: "/provider", handler: cmdProvider, options: providerOptions, picker: { inputArea: true }, executionMode: "queued", selfEcho: true, category: "Provider and Model" });
  registerBuiltin(registry, { name: "/model", handler: cmdModel, options: modelOptions, picker: { inputArea: true, mode: "single" }, category: "Provider and Model" });
  registerBuiltin(registry, { name: "/agents", handler: cmdAgents, options: subagentRoleOptions, picker: { inputArea: true, mode: "single" }, pickerFlow: "handler", executionMode: "whenBusy", category: "Provider and Model" });
  registerBuiltin(registry, { name: "/permission", handler: cmdPermission, options: permissionOptions, picker: { inputArea: true }, executionMode: "whenBusy", selfEcho: true, category: "Provider and Model" });

  registerBuiltin(registry, { name: "/skills", handler: cmdSkills, options: skillsOptions, picker: { title: "Skills", inputArea: true, mode: "toggle" }, pickerFlow: "handler", executionMode: "queued", selfEcho: true, category: "Ecosystem" });
  registerBuiltin(registry, { name: "/skills-creater", handler: cmdSkillsCreater, selfEcho: true, category: "Ecosystem" });
  registerBuiltin(registry, { name: "/mcp", handler: cmdMcp, options: mcpOptions, picker: { title: "MCP Servers", inputArea: true }, executionMode: "queued", category: "Ecosystem" });
  registerBuiltin(registry, { name: "/hooks", handler: cmdHooks, options: hooksOptions, picker: { title: "Hooks", inputArea: true }, executionMode: "whenBusy", category: "Ecosystem" });
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
