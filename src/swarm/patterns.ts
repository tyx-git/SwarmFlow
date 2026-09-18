/**
 * 预定义的 swarm 编排模式。
 *
 * 每个模式指定了拓扑结构、智能体角色和执行策略。
 * 模式可以组合：例如，链式模式的扇出。
 *
 * @packageDocumentation
 */

import { AgentRole, SwarmTopology } from "./types.js";
import type { SwarmPattern } from "./types.js";

// ------------------------------------------------------------------
// 内置模式
// ------------------------------------------------------------------

/**
 * 扇出 / 扇入：将工作分发给并行的 worker，然后合并。
 *
 * 最适合：大型重构、跨多个文件实现功能、
 * 对多个独立区域进行探索性分析。
 */
export const FAN_OUT_FAN_IN: SwarmPattern = {
  name: "fan-out-fan-in",
  description: "将工作分发给并行的 worker，然后合并结果",
  topology: SwarmTopology.Star,
  stages: [
    {
      role: AgentRole.Scout,
      count: 1,
      description: "分析代码库并规划工作分区",
      partitionStrategy: "auto",
    },
    {
      role: AgentRole.Worker,
      count: 3,
      description: "在并行分区中执行实现",
      partitionStrategy: "auto",
    },
    {
      role: AgentRole.Merger,
      count: 1,
      description: "合并并行结果并解决冲突",
      mergeStrategy: "resolve_conflicts",
    },
  ],
};

/**
 * 流水线 / 链式：顺序阶段，每个阶段馈送给下一个阶段。
 *
 * 最适合：代码审查工作流、构建-测试-审查循环、
 * 多阶段数据处理。
 */
export const PIPELINE: SwarmPattern = {
  name: "pipeline",
  description: "链式顺序阶段 — 每个阶段馈送给下一个阶段",
  topology: SwarmTopology.Chain,
  stages: [
    {
      role: AgentRole.Scout,
      count: 1,
      description: "探索代码库并收集上下文",
    },
    {
      role: AgentRole.Worker,
      count: 1,
      description: "根据 scout 的发现实现更改",
    },
    {
      role: AgentRole.Reviewer,
      count: 1,
      description: "审查 worker 更改的正确性和质量",
    },
    {
      role: AgentRole.Guard,
      count: 1,
      description: "安全性和安全验证",
      mergeStrategy: "synthesize",
    },
  ],
};

/**
 * 集成：多个 worker 独立解决同一问题，投票表决。
 *
 * 最适合：关键决策、安全审查、代码生成
 * 其中正确性至关重要。
 */
export const ENSEMBLE: SwarmPattern = {
  name: "ensemble",
  description: "多个 agent 独立解决，投票选出最佳结果",
  topology: SwarmTopology.Star,
  stages: [
    {
      role: AgentRole.Worker,
      count: 3,
      description: "每个 worker 独立生成一个解决方案",
      partitionStrategy: "manual",
    },
    {
      role: AgentRole.Reviewer,
      count: 1,
      description: "审查所有解决方案并推荐最佳方案",
      mergeStrategy: "vote",
    },
  ],
};

/**
 * 辩论：不同角色的 agent 辩论利弊，然后综合。
 *
 * 最适合：架构决策、权衡分析、
 * 在实现方法之间进行选择。
 */
export const DEBATE: SwarmPattern = {
  name: "debate",
  description: "Agent 从不同角度辩论，然后综合",
  topology: SwarmTopology.Mesh,
  stages: [
    {
      role: AgentRole.Scout,
      count: 1,
      description: "收集决策的事实和上下文",
    },
    {
      role: AgentRole.Worker,
      count: 2,
      description: "分别提出方案 A 和方案 B",
      partitionStrategy: "manual",
    },
    {
      role: AgentRole.Reviewer,
      count: 1,
      description: "分析权衡并给出建议",
      mergeStrategy: "synthesize",
    },
  ],
};

/**
 * 探索性：多个 scout 并行调查不同区域。
 *
 * 最适合：新代码库的上手、bug 搜寻、
 * 理解系统架构。
 */
export const EXPLORATORY: SwarmPattern = {
  name: "exploratory",
  description: "并行的 scout 调查不同区域",
  topology: SwarmTopology.Star,
  stages: [
    {
      role: AgentRole.Scout,
      count: 3,
      description: "每个 scout 并行探索一个不同区域",
      partitionStrategy: "auto",
    },
    {
      role: AgentRole.Merger,
      count: 1,
      description: "将发现综合为连贯的理解",
      mergeStrategy: "synthesize",
    },
  ],
};

// ------------------------------------------------------------------
// 模式注册表
// ------------------------------------------------------------------

/** 所有内置模式，按名称键控。 */
export const BUILTIN_PATTERNS: Record<string, SwarmPattern> = {
  [FAN_OUT_FAN_IN.name]: FAN_OUT_FAN_IN,
  [PIPELINE.name]: PIPELINE,
  [ENSEMBLE.name]: ENSEMBLE,
  [DEBATE.name]: DEBATE,
  [EXPLORATORY.name]: EXPLORATORY,
};

/** 按名称获取模式。如果未找到则返回 undefined。 */
export function getPattern(name: string): SwarmPattern | undefined {
  return BUILTIN_PATTERNS[name];
}

/** 列出所有可用的模式名称。 */
export function listPatterns(): string[] {
  return Object.keys(BUILTIN_PATTERNS);
}