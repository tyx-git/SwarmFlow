/**
 * 浏览器模块：为交互式设计提供可复用的本地浏览器服务器。
 *
 * 提供：
 * - `launchDesignHelper()` — 打开基于浏览器的设计助手（beta）
 * - `stopServer()` — 关闭正在运行的服务器
 *
 * 页面存放在 `.swarmflow/<session_id>/chrome/`，由 localhost 上的
 * Node.js HTTP 服务器提供（无外部依赖）。
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startServer } from "./server.js";
import { browser } from "../platform/index.js";
import { getUiCommonColors } from "../config/ui-colors.js";

export { stopServer } from "./server.js";

// ── 辅助函数 ──

function ensureChromeDir(sessionId: string, cwd: string): string {
  const dir = join(cwd, ".swarmflow", sessionId, "chrome");
  mkdirSync(dir, { recursive: true });
  return dir;
}

// ── 设计助手 ──

/** 启动浏览器设计助手的选项。 */
export interface DesignHelperOptions {
  sessionId: string;
  goal: string;
  cwd: string;
}

/**
 * 打开浏览器设计助手页面。
 * 目前只提供简单落地页，后续可扩展线框工具、
 * 配色生成器等。
 */
export async function launchDesignHelper(options: DesignHelperOptions): Promise<void> {
  const { sessionId, goal, cwd } = options;

  const chromeDir = ensureChromeDir(sessionId, cwd);

  // 生成简单的设计助手落地页
  const html = generateDesignHelperHtml(goal);
  writeFileSync(join(chromeDir, "index.html"), html, "utf-8");

  const { url } = await startServer(chromeDir);
  browser.openUrl(url);
}

function generateDesignHelperHtml(goal: string): string {
  const colors = getUiCommonColors().browserDesign;
  const escapedGoal = goal
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>SwarmFlow Design Assistant</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: "Segoe UI", system-ui, sans-serif;
    background: ${colors.background};
    color: ${colors.text};
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    min-height: 100vh;
    padding: 40px;
  }
  h1 { color: ${colors.heading}; margin-bottom: 12px; }
  .goal {
    background: ${colors.surface};
    border: 1px solid ${colors.border};
    border-radius: 8px;
    padding: 16px 24px;
    margin: 16px 0;
    max-width: 600px;
    font-size: 15px;
    line-height: 1.6;
  }
  .goal strong { color: ${colors.goalStrong}; }
  .note {
    color: ${colors.note};
    font-size: 13px;
    margin-top: 16px;
  }
  .beta {
    font-size: 11px;
    background: ${colors.badge};
    color: ${colors.text};
    padding: 2px 8px;
    border-radius: 10px;
    vertical-align: middle;
    margin-left: 8px;
  }
</style>
</head>
<body>
  <h1>Design Assistant <span class="beta">beta</span></h1>
  <div class="goal">
    <strong>Plan Goal:</strong> ${escapedGoal || "(not specified)"}
  </div>
  <p class="note">
    This is a browser-based design assistant.
    Use <code>/theme custom</code> for the full color customizer.
  </p>
</body>
</html>`;
}
