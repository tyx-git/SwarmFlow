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

/** Strategy for 任务分解. */
export enum DecompositionStrategy {
  /** Full analysis upfront — best for well-understood tasks. */
  TopDown = "top-down",
  /** Generate multiple hypotheses and explore in parallel. */
  Speculative = "speculative",
  /** Start minimal, expand based on results. */
  Incremental = "incremental",
}

/** Options for decomposition. */
export interface DecomposerOptions {
  /** Decomposition strategy. */
  strategy?: DecompositionStrategy;
  /** Maximum DAG depth (levels). */
  maxDepth?: number;
  /** Maximum number of tasks in the DAG. */
  maxTasks?: number;
  /** Context about the project (files, language, framework). */
  projectContext?: ProjectContext;
}

/** Information about the project context. */
export interface ProjectContext {
  /** Root directory. */
  rootDir?: string;
  /** Detected language(s). */
  languages?: string[];
  /** Detected framework(s). */
  frameworks?: string[];
  /** Key file paths. */
  keyFiles?: string[];
  /** Brief project description. */
  description?: string;
}

/** Default options. */
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

function buildFeatureDag(request: string, options: Required<DecomposerOptions>): TaskNode[] {
  return [
    {
      id: "scout-analyze",
      role: AgentRole.Scout,
      description: `Analyze the codebase to understand where and how to implement: ${request}`,
      dependencies: [],
      priority: 1,
    },
    {
      id: "worker-implement",
      role: AgentRole.Worker,
      description: `Implement: ${request}`,
      dependencies: ["scout-analyze"],
      priority: 1,
    },
    {
      id: "reviewer-review",
      role: AgentRole.Reviewer,
      description: `Review the implementation of: ${request}`,
      dependencies: ["worker-implement"],
      priority: 2,
    },
  ];
}

function buildBugFixDag(request: string, options: Required<DecomposerOptions>): TaskNode[] {
  return [
    {
      id: "scout-investigate",
      role: AgentRole.Scout,
      description: `Investigate the root cause of: ${request}`,
      dependencies: [],
      priority: 1,
    },
    {
      id: "worker-fix",
      role: AgentRole.Worker,
      description: `Fix the bug: ${request}`,
      dependencies: ["scout-investigate"],
      priority: 1,
    },
    {
      id: "reviewer-verify",
      role: AgentRole.Reviewer,
      description: `Verify the fix for: ${request}`,
      dependencies: ["worker-fix"],
      priority: 2,
    },
  ];
}

function buildRefactorDag(request: string, options: Required<DecomposerOptions>): TaskNode[] {
  return [
    {
      id: "scout-analyze",
      role: AgentRole.Scout,
      description: `Analyze the codebase to plan refactoring: ${request}`,
      dependencies: [],
      priority: 1,
    },
    {
      id: "worker-refactor-1",
      role: AgentRole.Worker,
      description: `Refactor (part 1/2): ${request}`,
      dependencies: ["scout-analyze"],
      priority: 1,
    },
    {
      id: "worker-refactor-2",
      role: AgentRole.Worker,
      description: `Refactor (part 2/2): ${request}`,
      dependencies: ["scout-analyze"],
      priority: 1,
    },
    {
      id: "reviewer-review",
      role: AgentRole.Reviewer,
      description: `Review the refactoring: ${request}`,
      dependencies: ["worker-refactor-1", "worker-refactor-2"],
      priority: 2,
    },
    {
      id: "guard-verify",
      role: AgentRole.Guard,
      description: `Verify refactoring doesn't break existing functionality: ${request}`,
      dependencies: ["reviewer-review"],
      priority: 3,
    },
  ];
}

function buildExploratoryDag(request: string, options: Required<DecomposerOptions>): TaskNode[] {
  return [
    {
      id: "scout-1",
      role: AgentRole.Scout,
      description: `Explore area 1/2: ${request}`,
      dependencies: [],
      priority: 1,
    },
    {
      id: "scout-2",
      role: AgentRole.Scout,
      description: `Explore area 2/2: ${request}`,
      dependencies: [],
      priority: 1,
    },
    {
      id: "merger-synthesize",
      role: AgentRole.Merger,
      description: `Synthesize findings from both scouts: ${request}`,
      dependencies: ["scout-1", "scout-2"],
      priority: 2,
    },
  ];
}

function buildSecurityDag(request: string, options: Required<DecomposerOptions>): TaskNode[] {
  return [
    {
      id: "guard-audit",
      role: AgentRole.Guard,
      description: `Security audit for: ${request}`,
      dependencies: [],
      priority: 1,
    },
    {
      id: "worker-fix",
      role: AgentRole.Worker,
      description: `Fix security issues found: ${request}`,
      dependencies: ["guard-audit"],
      priority: 1,
    },
    {
      id: "guard-verify",
      role: AgentRole.Guard,
      description: `Verify security fixes: ${request}`,
      dependencies: ["worker-fix"],
      priority: 2,
    },
  ];
}

// ------------------------------------------------------------------
// 主分解器
// ------------------------------------------------------------------

/**
 * TaskDecomposer — the main 入口点 for 任务分解.
 *
 * Uses pattern recognition (rule-based) to decompose requests.
 * Future: will use LLM-based decomposition for complex cases.
 */
export class TaskDecomposer {
  private _options: Required<DecomposerOptions>;
  /** Fired when decomposition produces a DAG. */
  onDecomposition?: (dag: TaskDAG, strategy: DecompositionStrategy) => void;

  constructor(options?: DecomposerOptions) {
    this._options = { ...DEFAULT_OPTIONS, ...options };
  }

  /** Current options. */
  get options(): Required<DecomposerOptions> {
    return { ...this._options };
  }

  /**
   * Decompose a user request into a TaskDAG.
   *
   * @param request - The user's natural language request
   * @param context - Optional project context
   * @returns A validated TaskDAG
   */
  async decompose(request: string, context?: ProjectContext): Promise<TaskDAG> {
    const mergedContext = { ...this._options.projectContext, ...context };
    const strat = this._options.strategy;
    let nodes: TaskNode[];

    // Pattern matching
    if (detectSecurity(request)) {
      nodes = buildSecurityDag(request, this._options);
    } else if (detectBugFix(request)) {
      nodes = buildBugFixDag(request, this._options);
    } else if (detectRefactor(request)) {
      nodes = buildRefactorDag(request, this._options);
    } else if (detectFeatureRequest(request)) {
      nodes = buildFeatureDag(request, this._options);
    } else if (detectExploration(request)) {
      nodes = buildExploratoryDag(request, this._options);
    } else {
      // Default: scout → worker
      nodes = [
        {
          id: "scout-default",
          role: AgentRole.Scout,
          description: `Analyze codebase for: ${request}`,
          dependencies: [],
          priority: 1,
        },
        {
          id: "worker-default",
          role: AgentRole.Worker,
          description: `Execute: ${request}`,
          dependencies: ["scout-default"],
          priority: 1,
        },
      ];
    }

    // Enforce limits
    if (nodes.length > this._options.maxTasks) {
      nodes = nodes.slice(0, this._options.maxTasks);
    }

    const dag = createDAG(nodes);
    const validation = validateDAG(dag);

    if (!validation.valid) {
      throw new Error(`Invalid DAG generated: ${validation.errors.join("; ")}`);
    }

    this.onDecomposition?.(dag, strat);
    return dag;
  }

  /**
   * Decompose using a specific strategy.
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
 * Convenience function for one-shot decomposition.
 */
export async function decomposeRequest(
  request: string,
  context?: ProjectContext,
): Promise<TaskDAG> {
  const decomposer = new TaskDecomposer();
  return decomposer.decompose(request, context);
}
