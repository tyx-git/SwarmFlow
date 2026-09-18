/**
 * 计划文件解析器与状态类型。
 *
 * 计划文件是存储在 {SESSION_ARTIFACTS}/plan.md 的 Markdown 文档。
 * 代理通过 write_file / edit_file 创建和编辑它——没有专用工具。
 *
 * 复选框语法：
 *   - [ ] 待处理检查点
 *   - [>] 进行中检查点
 *   - [x] 已完成检查点
 */

// ------------------------------------------------------------------
// 类型定义
// ------------------------------------------------------------------

export type CheckpointStatus = "pending" | "active" | "done";

/** 计划文件中的一个检查点 */
export interface PlanCheckpoint {
  /** 复选框行的完整文本（不含 `- [.] ` 前缀）。 */
  text: string;
  /** 状态 */
  status: CheckpointStatus;
}

// ------------------------------------------------------------------
// 解析器
// ------------------------------------------------------------------

/**
 * 匹配计划复选框行的正则。
 * 捕获：组 1 = 标记字符（空格、>、x/X），组 2 = 文本。
 */
const CHECKBOX_RE = /^[-*]\s+\[([ >xX])\]\s+(.+)$/;

/** 将标记字符映射为状态 */
function markerToStatus(marker: string): CheckpointStatus {
  switch (marker) {
    case "x":
    case "X":
      return "done";
    case ">":
      return "active";
    default:
      return "pending";
  }
}

/**
 * 解析计划文件内容为有序的检查点列表。
 * 仅提取匹配复选框模式的行；
 * 其他内容（标题、描述、空行）将被忽略。
 */
export function parsePlanFile(content: string): PlanCheckpoint[] {
  const checkpoints: PlanCheckpoint[] = [];
  for (const line of content.split("\n")) {
    const m = CHECKBOX_RE.exec(line.trim());
    if (m) {
      checkpoints.push({
        text: m[2].trim(),
        status: markerToStatus(m[1]),
      });
    }
  }
  return checkpoints;
}

// ------------------------------------------------------------------
// 快照格式化器（用于压缩上下文注入）
// ------------------------------------------------------------------

const STATUS_MARKER: Record<CheckpointStatus, string> = {
  pending: "[ ]",
  active: "[>]",
  done: "[x]",
};

/**
 * 将计划检查点格式化为可读的快照，适合注入到压缩上下文中。
 */
export function formatPlanSnapshot(checkpoints: PlanCheckpoint[]): string {
  if (checkpoints.length === 0) return "";
  const lines = checkpoints.map(
    (cp) => `- ${STATUS_MARKER[cp.status]} ${cp.text}`,
  );
  return "[Current Plan]\n" + lines.join("\n");
}

// ------------------------------------------------------------------
// 计划文件名常量
// ------------------------------------------------------------------

export const PLAN_FILENAME = "plan.md";