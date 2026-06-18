/**
 * Plan file parser and state types.
 *
 * The plan file is a Markdown document stored at {SESSION_ARTIFACTS}/plan.md.
 * Agents create and edit it using write_file / edit_file 鈥?no dedicated tool.
 *
 * Checkbox syntax:
 *   - [ ] pending checkpoint
 *   - [>] active (in-progress) checkpoint
 *   - [x] completed checkpoint
 */

// ------------------------------------------------------------------
// Types
// ------------------------------------------------------------------

export type CheckpointStatus = "pending" | "active" | "done";

export interface PlanCheckpoint {
  /** Full text of the checkbox line (without the `- [.] ` prefix). */
  text: string;
  status: CheckpointStatus;
}

// ------------------------------------------------------------------
// Parser
// ------------------------------------------------------------------

/**
 * Regex matching a plan checkbox line.
 * Captures: group 1 = marker character (space, >, x/X), group 2 = text.
 */
const CHECKBOX_RE = /^[-*]\s+\[([ >xX])\]\s+(.+)$/;

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
 * Parse a plan file's content into an ordered list of checkpoints.
 * Only lines matching the checkbox pattern are extracted;
 * all other content (headings, descriptions, blank lines) is ignored.
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
// Snapshot formatter (for compact injection)
// ------------------------------------------------------------------

const STATUS_MARKER: Record<CheckpointStatus, string> = {
  pending: "[ ]",
  active: "[>]",
  done: "[x]",
};

/**
 * Format plan checkpoints into a readable snapshot suitable for
 * injection into compact context.
 */
export function formatPlanSnapshot(checkpoints: PlanCheckpoint[]): string {
  if (checkpoints.length === 0) return "";
  const lines = checkpoints.map(
    (cp) => `- ${STATUS_MARKER[cp.status]} ${cp.text}`,
  );
  return "[Current Plan]\n" + lines.join("\n");
}

// ------------------------------------------------------------------
// Plan file name constant
// ------------------------------------------------------------------

export const PLAN_FILENAME = "plan.md";
