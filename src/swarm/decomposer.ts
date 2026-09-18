/**
 * TaskDecomposer — 将用户请求分解为可执行的 TaskDAG。
 *
 * 使用 LLM agent（或基于规则的启发式方法）分析用户请求，
 * 并将其分解为结构化的任务 DAG，每个任务分配给适当的 agent 角色。
 *
 * @packageDocumentation
 */

import type { TaskNode, TaskDAG } from "./types.js";
import { AgentRole } from "./types.js";
import { createDAG, validateDAG } from "./task-dag.js";

// ------------------------------------------------------------------
// 分解策略
// ------------------------------------------------------------------

/** 任务分解策略。 */
export enum DecompositionStrategy {
  /** 预先进行完整分析 — 最适合理解充分的任务。 */
  TopDown = "top-down",
  /** 生成多个假设并并行探索。 */
  Speculative = "speculative",
  /** 从最小化开始，根据结果扩展。 */
  Incremental = "incremental",
}

/** 分解选项。 */
export interface DecomposerOptions {
  /** 分解策略。 */
  strategy?: DecompositionStrategy;
  /** 最大 DAG 深度（层级数）。 */
  maxDepth?: number;
  /** DAG 中的最大任务数。 */
  maxTasks?: number;
  /** 项目上下文（文件、语言、框架）。 */
  projectContext?: ProjectContext;
}

/** 项目上下文信息。 */
export interface ProjectContext {
  /** 根目录。 */
  rootDir?: string;
  /** 检测到的语言。 */
  languages?: string[];
  /** 检测到的框架。 */
  frameworks?: string[];
  /** 关键文件路径。 */
  keyFiles?: string[];
  /** 简要项目描述。 */
  description?: string;
}

/** 默认选项。 */
const DEFAULT_OPTIONS: Required<DecomposerOptions> = {
  strategy: DecompositionStrategy.TopDown,
  maxDepth: 3,
  maxTasks: 10,
  projectContext: {},
};

// ------------------------------------------------------------------
// 内置分解规则
// ------------------------------------------------------------------

/**
 * 模式：请求提到添加功能
 * → Scout（分析）→ Worker（实现）→ Reviewer（审查）
 */
function detectFeatureRequest(request: string): boolean {
  const patterns = [
    /add\s+(a\s+)?(new\s+)?(feature|endpoint|route|api|page|component|module)/i,
    /implement\s+(a\s+)?(new\s+)?(feature|endpoint|route|api|page)/i,
    /create\s+(a\s+)?(new\s+)?(feature|endpoint|route|api|page|component|module)/i,
  ];
  return patterns.some((p) => p.test(request));
}

/**
 * 模式：请求提到修复 bug
 * → Scout（调查）→ Worker（修复）→ Reviewer（验证）
 */
function detectBugFix(request: string): boolean {
  const patterns = [
    /fix\s+(a\s+)?(bug|issue|problem|error|crash)/i,
    /bug\s+fix/i,
    /doesn'?t\s+work/i,
    /broken/i,
  ];
  return patterns.some((p) => p.test(request));
}

/**
 * 模式：请求提到重构
 * → Scout（分析）→ Worker × N（重构分区）→ Reviewer（审查）→ Guard（检查）
 */
function detectRefactor(request: string): boolean {
  const patterns = [
    /refactor/i,
    /restructure/i,
    /rewrite/i,
    /reorganize/i,
    /clean\s+up/i,
  ];
  return patterns.some((p) => p.test(request));
}

/**
 * 模式：请求是探索性/学习性的
 * → Scout × N（探索不同区域）→ Merger（综合）
 */
function detectExploration(request: string): boolean {
  const patterns = [
    /explain/i,
    /understand/i,
    /how\s+(does|is|are)/i,
    /what\s+(is|are|does)/i,
    /analyze/i,
    /investigate/i,
    /explore/i,
  ];
  return patterns.some((p) => p.test(request));
}

/**
 * 模式：请求提到安全性
 * → Guard（审计）→ Worker（修复）→ Guard（验证）
 */
function detectSecurity(request: string): boolean {
  const patterns = [
    /security/i,
    /vulnerability/i,
    /CVE/i,
    /audit/i,
    /permission/i,
    /auth/i,
    /encrypt/i,
  ];
  return patterns.some((p) => p.test(request));
}

// ------------------------------------------------------------------
// 基于模板的 DAG 构建器
// ------------------------------------------------------------------

function buildFeatureDag(request: string): TaskNode[] {
  return [
    {
      id: "scout-analyze",
      role: AgentRole.Scout,
      description: `分析代码库，了解如何以及在何处实现：${request}`,
      dependencies: [],
      priority: 1,
    },
    {
      id: "worker-implement",
      role: AgentRole.Worker,
      description: `实现：${request}`,
      dependencies: ["scout-analyze"],
      priority: 1,
    },
    {
      id: "reviewer-review",
      role: AgentRole.Reviewer,
      description: `审查实现：${request}`,
      dependencies: ["worker-implement"],
      priority: 2,
    },
  ];
}

function buildBugFixDag(request: string): TaskNode[] {
  return [
    {
      id: "scout-investigate",
      role: AgentRole.Scout,
      description: `调查根本原因：${request}`,
      dependencies: [],
      priority: 1,
    },
    {
      id: "worker-fix",
      role: AgentRole.Worker,
      description: `修复 bug：${request}`,
      dependencies: ["scout-investigate"],
      priority: 1,
    },
    {
      id: "reviewer-verify",
      role: AgentRole.Reviewer,
      description: `验证修复：${request}`,
      dependencies: ["worker-fix"],
      priority: 2,
    },
  ];
}

function buildRefactorDag(request: string): TaskNode[] {
  return [
    {
      id: "scout-analyze",
      role: AgentRole.Scout,
      description: `分析代码库以规划重构：${request}`,
      dependencies: [],
      priority: 1,
    },
    {
      id: "worker-refactor-1",
      role: AgentRole.Worker,
      description: `重构（第 1/2 部分）：${request}`,
      dependencies: ["scout-analyze"],
      priority: 1,
    },
    {
      id: "worker-refactor-2",
      role: AgentRole.Worker,
      description: `重构（第 2/2 部分）：${request}`,
      dependencies: ["scout-analyze"],
      priority: 1,
    },
    {
      id: "reviewer-review",
      role: AgentRole.Reviewer,
      description: `审查重构：${request}`,
      dependencies: ["worker-refactor-1", "worker-refactor-2"],
      priority: 2,
    },
    {
      id: "guard-verify",
      role: AgentRole.Guard,
      description: `验证重构不会破坏现有功能：${request}`,
      dependencies: ["reviewer-review"],
      priority: 3,
    },
  ];
}

function buildExploratoryDag(request: string): TaskNode[] {
  return [
    {
      id: "scout-1",
      role: AgentRole.Scout,
      description: `探索区域 1/2：${request}`,
      dependencies: [],
      priority: 1,
    },
    {
      id: "scout-2",
      role: AgentRole.Scout,
      description: `探索区域 2/2：${request}`,
      dependencies: [],
      priority: 1,
    },
    {
      id: "merger-synthesize",
      role: AgentRole.Merger,
      description: `综合两个 scout 的发现：${request}`,
      dependencies: ["scout-1", "scout-2"],
      priority: 2,
    },
  ];
}

function buildSecurityDag(request: string): TaskNode[] {
  return [
    {
      id: "guard-audit",
      role: AgentRole.Guard,
      description: `安全审计：${request}`,
      dependencies: [],
      priority: 1,
    },
    {
      id: "worker-fix",
      role: AgentRole.Worker,
      description: `修复发现的安全问题：${request}`,
      dependencies: ["guard-audit"],
      priority: 1,
    },
    {
      id: "guard-verify",
      role: AgentRole.Guard,
      description: `验证安全修复：${request}`,
      dependencies: ["worker-fix"],
      priority: 2,
    },
  ];
}

// ------------------------------------------------------------------
// 主分解器
// ------------------------------------------------------------------

/**
 * TaskDecomposer — 任务分解的主入口点。
 *
 * 使用模式识别（基于规则）来分解请求。
 * 未来：将使用基于 LLM 的分解来处理复杂情况。
 */
export class TaskDecomposer {
  private _options: Required<DecomposerOptions>;
  /** 当分解生成 DAG 时触发。 */
  onDecomposition?: (dag: TaskDAG, strategy: DecompositionStrategy) => void;

  constructor(options?: DecomposerOptions) {
    this._options = { ...DEFAULT_OPTIONS, ...options };
  }

  /** 当前选项。 */
  get options(): Required<DecomposerOptions> {
    return { ...this._options };
  }

  /**
   * 将用户请求分解为 TaskDAG。
   *
   * @param request - 用户的自然语言请求
   * @param context - 可选的項目上下文
   * @returns 经过验证的 TaskDAG
   */
  async decompose(request: string, context?: ProjectContext): Promise<TaskDAG> {
    // The deterministic strategy does not consume project context yet.
    void context;
    const strat = this._options.strategy;
    let nodes: TaskNode[];

    // 模式匹配
    if (detectRefactor(request)) {
      nodes = buildRefactorDag(request);
    } else if (detectBugFix(request)) {
      nodes = buildBugFixDag(request);
    } else if (detectFeatureRequest(request)) {
      nodes = buildFeatureDag(request);
    } else if (detectExploration(request)) {
      nodes = buildExploratoryDag(request);
    } else if (detectSecurity(request)) {
      nodes = buildSecurityDag(request);
    } else {
      // 默认：scout → worker
      nodes = [
        {
          id: "scout-default",
          role: AgentRole.Scout,
          description: `分析代码库以处理：${request}`,
          dependencies: [],
          priority: 1,
        },
        {
          id: "worker-default",
          role: AgentRole.Worker,
          description: `执行：${request}`,
          dependencies: ["scout-default"],
          priority: 1,
        },
      ];
    }

    // 强制执行限制
    if (nodes.length > this._options.maxTasks) {
      nodes = nodes.slice(0, this._options.maxTasks);
    }

    const dag = createDAG(nodes);
    const validation = validateDAG(dag);

    if (!validation.valid) {
      throw new Error(`生成的 DAG 无效：${validation.errors.join("; ")}`);
    }

    this.onDecomposition?.(dag, strat);
    return dag;
  }

  /**
   * 使用特定策略进行分解。
   */
  async decomposeWithStrategy(
    request: string,
    strategy: DecompositionStrategy,
    context?: ProjectContext,
  ): Promise<TaskDAG> {
    const oldStrategy = this._options.strategy;
    this._options.strategy = strategy;
    try {
      return await this.decompose(request, context);
    } finally {
      this._options.strategy = oldStrategy;
    }
  }
}

/**
 * 一次性分解的便捷函数。
 */
export async function decomposeRequest(
  request: string,
  context?: ProjectContext,
): Promise<TaskDAG> {
  const decomposer = new TaskDecomposer();
  return decomposer.decompose(request, context);
}
