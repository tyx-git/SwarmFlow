/**
 * Pre-defined swarm orchestration patterns.
 *
 * Each pattern specifies a topology, agent roles, and execution strategy.
 * Patterns can be composed: e.g., a fan-out of chains.
 *
 * @packageDocumentation
 */

import { AgentRole, Swarm拓扑 } from "./types.js";
import type { SwarmPattern } from "./types.js";

// ------------------------------------------------------------------
// 内置模式
// ------------------------------------------------------------------

/**
 * Fan-out / Fan-in: distribute work to parallel workers, then merge.
 *
 * Best for: large refactors, implementing features across multiple files,
 * exploratory analysis of multiple independent areas.
 */
export const FAN_OUT_FAN_IN: SwarmPattern = {
  name: "fan-out-fan-in",
  description: "Distribute work to parallel workers, then merge results",
  topology: Swarm拓扑.Star,
  stages: [
    {
      role: AgentRole.Scout,
      count: 1,
      description: "Analyze codebase and plan work partitioning",
      partitionStrategy: "auto",
    },
    {
      role: AgentRole.Worker,
      count: 3,
      description: "Execute implementation in parallel partitions",
      partitionStrategy: "auto",
    },
    {
      role: AgentRole.Merger,
      count: 1,
      description: "Merge parallel results and resolve conflicts",
      mergeStrategy: "resolve_conflicts",
    },
  ],
};

/**
 * Pipeline / Chain: sequential stages, each feeding into the next.
 *
 * Best for: code review workflows, build-test-review cycles,
 * multi-stage data processing.
 */
export const PIPELINE: SwarmPattern = {
  name: "pipeline",
  description: "Sequential stages in a chain — each feeds into the next",
  topology: Swarm拓扑.Chain,
  stages: [
    {
      role: AgentRole.Scout,
      count: 1,
      description: "Explore codebase and gather context",
    },
    {
      role: AgentRole.Worker,
      count: 1,
      description: "Implement changes based on scout findings",
    },
    {
      role: AgentRole.Reviewer,
      count: 1,
      description: "Review worker changes for correctness and quality",
    },
    {
      role: AgentRole.Guard,
      count: 1,
      description: "Security and safety validation",
      mergeStrategy: "synthesize",
    },
  ],
};

/**
 * Ensemble: multiple workers independently solve the same problem, vote.
 *
 * Best for: critical decisions, security reviews, code generation
 * where correctness is paramount.
 */
export const ENSEMBLE: SwarmPattern = {
  name: "ensemble",
  description: "Multiple agents solve independently, vote on best result",
  topology: Swarm拓扑.Star,
  stages: [
    {
      role: AgentRole.Worker,
      count: 3,
      description: "Each worker independently produces a solution",
      partitionStrategy: "manual",
    },
    {
      role: AgentRole.Reviewer,
      count: 1,
      description: "Review all solutions and recommend the best",
      mergeStrategy: "vote",
    },
  ],
};

/**
 * Debate: agents with different roles argue pros/cons, then synthesize.
 *
 * Best for: architectural decisions, trade-off analysis,
 * choosing between implementation approaches.
 */
export const DEBATE: SwarmPattern = {
  name: "debate",
  description: "Agents argue different perspectives, then synthesize",
  topology: Swarm拓扑.Mesh,
  stages: [
    {
      role: AgentRole.Scout,
      count: 1,
      description: "Gather facts and context for the decision",
    },
    {
      role: AgentRole.Worker,
      count: 2,
      description: "Propose approach A and approach B respectively",
      partitionStrategy: "manual",
    },
    {
      role: AgentRole.Reviewer,
      count: 1,
      description: "Analyze trade-offs and recommend",
      mergeStrategy: "synthesize",
    },
  ],
};

/**
 * Exploratory: multiple scouts investigate different areas in parallel.
 *
 * Best for: onboarding to a new codebase, bug hunting,
 * understanding system architecture.
 */
export const EXPLORATORY: SwarmPattern = {
  name: "exploratory",
  description: "Parallel scouts investigate different areas",
  topology: Swarm拓扑.Star,
  stages: [
    {
      role: AgentRole.Scout,
      count: 3,
      description: "Each scout explores a different area in parallel",
      partitionStrategy: "auto",
    },
    {
      role: AgentRole.Merger,
      count: 1,
      description: "Synthesize findings into a cohesive understanding",
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
