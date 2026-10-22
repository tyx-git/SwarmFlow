/** /reviewer 评审目标构建、提示词组装与派发。 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { getBundledAssetsDir } from "../../config/asset-paths.js";

import { type CommandContext, type CommandOption, type CommandOptionsContext } from "../types.js";
import { writeReviewerScaffold } from "./session-files.js";

function loadReviewPromptTemplate(): string {
  const promptPath = join(getBundledAssetsDir(), "prompts", "review.md");
  try {
    return readFileSync(promptPath, "utf-8");
  } catch {
    return "";
  }
}

function buildReviewTarget(kind: string, detail?: string): string {
  switch (kind) {
    case "uncommitted":
      return [
        "Review all uncommitted changes in the current repository.",
        "Run `git diff` for unstaged changes, `git diff --cached` for staged changes,",
        "and `git status --short` to identify untracked files. Read their contents.",
      ].join("\n");
    case "base": {
      const branch = detail || "main";
      return [
        `Review all changes on the current branch compared to \`${branch}\`.`,
        `Run \`git diff ${branch}...HEAD\` to get the diff.`,
        "Also check `git log --oneline " + branch + "..HEAD` for commit context.",
      ].join("\n");
    }
    case "commit": {
      const sha = detail || "HEAD";
      return [
        `Review the specific commit \`${sha}\`.`,
        `Run \`git show ${sha}\` to get the diff and commit message.`,
      ].join("\n");
    }
    default:
      return "Review the changes described in the user instructions below.";
  }
}

function buildReviewPrompt(reviewTarget: string, userInstructions: string): string {
  const template = loadReviewPromptTemplate();
  if (!template) {
    return `Review the following code changes.\n\n${reviewTarget}\n\n${userInstructions}`;
  }
  return template
    .replace("{REVIEW_TARGET}", reviewTarget)
    .replace("{USER_INSTRUCTIONS}", userInstructions || "(No additional instructions.)");
}

function gitCurrentBranch(): string {
  const result = spawnSync("git", ["branch", "--show-current"], {
    encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"],
  });
  return (result.stdout ?? "").trim() || "HEAD";
}

function gitBranchOptions(): CommandOption[] {
  const current = gitCurrentBranch();
  const result = spawnSync("git", ["branch", "-a", "--format=%(refname:short)"], {
    encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"],
  });
  const branches = (result.stdout ?? "").split("\n").map(l => l.trim()).filter(Boolean)
    .filter(b => b !== current && !b.endsWith("/HEAD"));
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const b of branches) {
    const short = b.replace(/^origin\//, "");
    if (!seen.has(short)) {
      seen.add(short);
      deduped.push(b);
    }
  }
  if (deduped.length === 0) {
    return [{ label: "No other branches found", value: "", disabled: true }];
  }
  return deduped.map(b => ({
    label: `${current} → ${b}`,
    value: b,
  }));
}

function gitCommitOptions(): CommandOption[] {
  const result = spawnSync("git", ["log", "--oneline", "-20"], {
    encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"],
  });
  const commits = (result.stdout ?? "").split("\n").map(l => l.trim()).filter(Boolean);
  if (commits.length === 0) {
    return [{ label: "No commits found", value: "", disabled: true }];
  }
  return commits.map(line => {
    const spaceIdx = line.indexOf(" ");
    return {
      label: line,
      value: spaceIdx > 0 ? line.slice(0, spaceIdx) : line,
    };
  });
}

export function reviewOptions(_ctx: CommandOptionsContext): CommandOption[] {
  return [
    {
      label: "Review against a base branch",
      value: "base",
      detail: "(PR Style)",
      children: gitBranchOptions(),
    },
    { label: "Review uncommitted changes", value: "uncommitted" },
    {
      label: "Review a commit",
      value: "commit",
      children: gitCommitOptions(),
    },
    { label: "Custom review instructions", value: "custom", customInput: true },
  ];
}

function reviewDisplayText(kind: string, detail: string, note: string): string {
  const parts = ["/reviewer"];
  switch (kind) {
    case "uncommitted": parts.push("uncommitted changes"); break;
    case "base": parts.push(`against ${detail || "base"}`); break;
    case "commit": parts.push(`commit ${detail || "HEAD"}`); break;
    case "custom": break;
  }
  if (note) parts.push(note);
  return parts.join(" ");
}

export async function cmdReviewer(ctx: CommandContext, args: string): Promise<void> {
  const trimmed = args.trim();
  let kind = "custom";
  let detail = "";
  let note = trimmed;

  if (trimmed) {
    if (trimmed === "uncommitted") {
      kind = "uncommitted";
      note = "";
    } else if (trimmed === "custom") {
      note = "";
    } else if (/^[0-9a-f]{7,40}$/.test(trimmed)) {
      kind = "commit";
      detail = trimmed;
      note = "";
    } else if (/^[A-Za-z0-9_./-]+$/.test(trimmed) && !trimmed.includes(" ")) {
      const check = spawnSync("git", ["rev-parse", "--verify", "--quiet", trimmed], {
        timeout: 3000, stdio: "ignore",
      });
      if (check.status === 0) {
        kind = "base";
        detail = trimmed;
        note = "";
      }
    }
  } else {
    if (!ctx.promptCommandPicker) {
      kind = "uncommitted";
    } else {
      const picked = await ctx.promptCommandPicker(
        reviewOptions({ session: ctx.session, store: ctx.store }),
        { title: "Review", allowNote: true },
      );
      if (!picked) return;
      note = picked.note ?? "";
      const value = picked.value;
      if (value === "custom") {
        kind = "custom";
      } else if (value === "uncommitted") {
        kind = "uncommitted";
      } else if (/^[0-9a-f]{7,40}$/.test(value)) {
        kind = "commit";
        detail = value;
      } else {
        kind = "base";
        detail = value;
      }
    }
  }

  const scope = note || detail || (kind === "uncommitted" ? "uncommitted changes" : "Whole project");
  const reviewerDir = writeReviewerScaffold(ctx, scope);
  const target = buildReviewTarget(kind, detail);
  const content = [
    buildReviewPrompt(target, note),
    "",
    "Reviewer output requirements:",
    `- Overwrite ${join(reviewerDir, "report.md")} with the final review report.` ,
    `- Overwrite ${join(reviewerDir, "todo.md")} with the repair todo using /plan Stage + checkbox format.`,
    "- Do not modify source code while running /reviewer.",
  ].join("\n");
  const displayText = reviewDisplayText(kind, detail, note);
  if (ctx.onInjectedTurnRequested) {
    ctx.onInjectedTurnRequested(displayText, content);
  } else if (ctx.onTurnRequested) {
    ctx.onTurnRequested(content);
  } else {
    ctx.showMessage(`Reviewer scaffold written to ${reviewerDir}. Agent turn runner is not available in this UI.`);
  }
}
