/**
 * 资源与扩展目录的四层路径解析（workspace > project > global > bundled）。
 */

import { existsSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getSwarmflowHomeDir } from "./home-dir.js";
import { projectSlug } from "./storage-layout.js";

/**
 * 四层扩展发现路径（优先级从高到低）：
 *
 *   workspace  → {cwd}/.swarmflow/         （检入仓库，团队共享）
 *   project    → ~/.swarmflow/projects/<hash>/.swarmflow/  （每项目独立，不在仓库中）
 *   global     → ~/.swarmflow/             （用户级默认值）
 *   bundled    → package assets        （随 swarmflow 一起发布）
 */
/** 解析后的路径配置——包含所有扩展发现根目录 */
export interface ResolvedPaths {
  /** 模板目录路径 */
  templatesPath: string | null;
  /** 提示词目录路径 */
  promptsPath: string | null;
  /** SwarmFlow 主目录（~/.swarmflow） */
  homeDir: string;

  // 四层扩展发现根目录（目录不存在时为 null）
  extensions: {
    /** {cwd}/.swarmflow/ — workspace 层（最高优先级） */
    workspace: string | null;
    /** ~/.swarmflow/projects/<hash>/.swarmflow/ — project 层 */
    project: string | null;
    /** ~/.swarmflow/ — global 层 */
    global: string;
    /** 内置资源目录 — bundled 层（最低优先级） */
    bundled: string | null;
  };

  // 便捷字段：展平的扩展类型路径
  /** 技能根目录列表，按优先级排序：[bundled, global, project, workspace] */
  skillRoots: string[];
  /** 钩子根目录列表，按优先级排序：[global, project, workspace] */
  hookRoots: { dir: string; scope: "global" | "project" | "workspace" }[];
  /** 模板根目录列表：[bundled, global, project, workspace] — 用于 loadTemplates 分层加载 */
  templateRoots: string[];
  /** 项目 .mcp.json 路径（workspace 层） */
  projectMcpConfigPath: string | null;

  // 旧版兼容（cli.ts 模板加载使用）
  projectTemplatesPath: string | null;
  projectSkillsPath: string | null;
}

/**
 * 跨四层发现扩展路径。
 *
 * 层级优先级（从高到低）：
 *   workspace  → {cwd}/.swarmflow/
 *   project    → ~/.swarmflow/projects/<hash>/.swarmflow/
 *   global     → ~/.swarmflow/
 *   bundled    → package assets（通过 getBundledAssetsDir 单独解析）
 */
export function resolveAssetPaths(opts?: {
  templatesFlag?: string;
  projectPath?: string;
  homeDir?: string;
}): ResolvedPaths {
  const home = opts?.homeDir ?? getSwarmflowHomeDir();
  const projectPath = resolve(opts?.projectPath ?? process.cwd());

  // 计算项目哈希目录：~/.swarmflow/projects/<name>_<hash>/
  const slug = projectSlug(projectPath);
  const projectStoreDir = join(home, "projects", slug);

  // 四个扩展层根目录
  const workspaceRoot = join(projectPath, ".swarmflow");
  const projectRoot = join(projectStoreDir, ".swarmflow");
  const globalRoot = home;

  const extensions = {
    workspace: isDir(workspaceRoot) ? workspaceRoot : null,
    project: isDir(projectRoot) ? projectRoot : null,
    global: globalRoot,
    bundled: null as string | null, // set by caller from getBundledAssetsDir()
  };

  // --- 模板（旧版：CLI 标志 > global > cwd）---
  let templatesPath: string | null = null;
  if (opts?.templatesFlag) {
    templatesPath = isDir(opts.templatesFlag) ? opts.templatesFlag : null;
  } else {
    const homeTemplates = join(home, "prompts", "templates");
    const cwdTemplates = join(projectPath, "prompts", "templates");
    if (isDir(homeTemplates)) {
      templatesPath = homeTemplates;
    } else if (isDir(cwdTemplates)) {
      templatesPath = cwdTemplates;
    }
  }

  // --- 提示词 ---
  let promptsPath: string | null = null;
  if (templatesPath) {
    const siblingPrompts = join(dirname(templatesPath), "prompts");
    if (isDir(siblingPrompts)) promptsPath = siblingPrompts;
  }
  if (!promptsPath) {
    const homePrompts = join(home, "prompts");
    const cwdPrompts = join(projectPath, "prompts");
    if (isDir(homePrompts)) promptsPath = homePrompts;
    else if (isDir(cwdPrompts)) promptsPath = cwdPrompts;
  }

  // --- 技能根目录（bundled > global > project > workspace）---
  const skillRoots: string[] = [];
  // bundled 由调用者添加
  const globalSkills = join(globalRoot, "skills");
  if (isDir(globalSkills)) skillRoots.push(globalSkills);
  const projectSkills = join(projectStoreDir, ".swarmflow", "skills");
  if (isDir(projectSkills)) skillRoots.push(projectSkills);
  const workspaceSkills = join(workspaceRoot, "skills");
  if (isDir(workspaceSkills)) skillRoots.push(workspaceSkills);

  // --- 钩子根目录（global > project > workspace）---
  const hookRoots: { dir: string; scope: "global" | "project" | "workspace" }[] = [];
  const globalHooks = join(globalRoot, "hooks");
  if (isDir(globalHooks)) hookRoots.push({ dir: globalHooks, scope: "global" });
  const projectHooks = join(projectStoreDir, ".swarmflow", "hooks");
  if (isDir(projectHooks)) hookRoots.push({ dir: projectHooks, scope: "project" });
  const workspaceHooks = join(workspaceRoot, "hooks");
  if (isDir(workspaceHooks)) hookRoots.push({ dir: workspaceHooks, scope: "workspace" });

  // --- 模板根目录（用于 loadTemplates 分层加载）---
  const templateRoots: string[] = [];
  // bundled 由调用者添加
  if (templatesPath) templateRoots.push(templatesPath);
  const projectTemplates = join(projectStoreDir, ".swarmflow", "prompts", "templates");
  if (isDir(projectTemplates)) templateRoots.push(projectTemplates);
  const workspaceTemplates = join(workspaceRoot, "prompts", "templates");
  if (isDir(workspaceTemplates)) templateRoots.push(workspaceTemplates);

  // --- 项目 MCP 配置 ---
  const mcpPath = join(projectPath, ".mcp.json");
  const projectMcpConfigPath = existsSync(mcpPath) ? mcpPath : null;

  // 旧版兼容字段
  const projectTemplatesPath = isDir(workspaceTemplates) ? workspaceTemplates : null;
  const projectSkillsPath = isDir(workspaceSkills) ? workspaceSkills : null;

  return {
    templatesPath,
    promptsPath,
    homeDir: home,
    extensions,
    skillRoots,
    hookRoots,
    templateRoots,
    projectMcpConfigPath,
    projectTemplatesPath,
    projectSkillsPath,
  };
}

/** 检查路径是否存在且为目录 */
function isDir(p: string): boolean {
  try {
    return existsSync(p) && statSync(p).isDirectory();
  } catch {
    return false;
  }
}

// ------------------------------------------------------------------
// 内置资源路径
// ------------------------------------------------------------------

/**
 * 返回内置资源根目录（dist/ 的父目录）。
 *
 * 源码布局：<repo>/src/config/asset-paths.ts → <repo>
 * dist 布局：<dist>/src/config/asset-paths.js → <dist>
 * SEA 布局：<runtime>/dist/src/config/asset-paths.js → <runtime>/dist
 *
 * `moduleUrl` 仅用于测试时模拟不同布局。
 */
export function getBundledAssetsDir(moduleUrl: string = import.meta.url): string {
  const moduleDir = dirname(fileURLToPath(moduleUrl));
  return join(moduleDir, "..", "..");
}
