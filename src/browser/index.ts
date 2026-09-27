/**
 * Browser module — reusable local browser server for interactive design.
 *
 * Provides:
 * - `launchDesignHelper()` — opens a browser-based design assistant (beta)
 * - `stopServer()` — shuts down the running server
 *
 * Pages are stored in `.swarmflow/<session_id>/chrome/` and served via
 * a Node.js HTTP server on localhost (no external dependencies).
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { startServer } from "./server.js";
import { browser } from "../platform/index.js";

export { stopServer } from "./server.js";

// ── Helpers ────────────────────────────────────────────────────────

function ensureChromeDir(sessionId: string, cwd: string): string {
  const dir = join(cwd, ".swarmflow", sessionId, "chrome");
  mkdirSync(dir, { recursive: true });
  return dir;
}

// ── Design Helper ──────────────────────────────────────────────────

/** Options for launching the browser-based design assistant. */
export interface DesignHelperOptions {
  sessionId: string;
  goal: string;
  cwd: string;
}

/**
 * Launch a browser-based design assistant page.
 * Currently serves a simple landing page; can be extended with
 * wireframe tools, color scheme generators, etc.
 */
export async function launchDesignHelper(options: DesignHelperOptions): Promise<void> {
  const { sessionId, goal, cwd } = options;

  const chromeDir = ensureChromeDir(sessionId, cwd);

  // Generate a simple design helper landing page
  const html = generateDesignHelperHtml(goal);
  writeFileSync(join(chromeDir, "index.html"), html, "utf-8");

  const { url } = await startServer(chromeDir);
  browser.openUrl(url);
}

function generateDesignHelperHtml(goal: string): string {
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
    background: #1e1e2e;
    color: #cdd6f4;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    min-height: 100vh;
    padding: 40px;
  }
  h1 { color: #cba6f7; margin-bottom: 12px; }
  .goal {
    background: #313244;
    border: 1px solid #45475a;
    border-radius: 8px;
    padding: 16px 24px;
    margin: 16px 0;
    max-width: 600px;
    font-size: 15px;
    line-height: 1.6;
  }
  .goal strong { color: #89b4fa; }
  .note {
    color: #6c7086;
    font-size: 13px;
    margin-top: 16px;
  }
  .beta {
    font-size: 11px;
    background: #7c3aed;
    color: #cdd6f4;
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
