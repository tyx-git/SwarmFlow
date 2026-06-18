/**
 * Hook command runner.
 *
 * Spawns a hook command, writes the event payload as JSON to stdin,
 * reads JSON output from stdout, enforces timeout.
 */

import { spawn } from "node:child_process";
import { osCapabilities } from "../platform/index.js";
import type { HookManifest, HookPayload, HookOutput } from "./types.js";

const DEFAULT_TIMEOUT_MS = 10_000;

export interface HookRunResult {
  success: boolean;
  output: HookOutput;
  error?: string;
  durationMs: number;
}

/**
 * Execute a hook command and parse its JSON output.
 */
export async function runHookCommand(
  manifest: HookManifest,
  payload: HookPayload,
): Promise<HookRunResult> {
  const startMs = Date.now();
  const timeoutMs = manifest.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return new Promise<HookRunResult>((resolve) => {
    const env: Record<string, string | undefined> = { ...process.env, ...manifest.env };
    let child;
    try {
      // Only ROUTE THROUGH cmd.exe when we actually need it. A command
      // with an explicit native-executable extension (.exe/.com) is
      // spawned directly (argv array, no shell) on every platform 鈥?cmd
      // reparsing would mangle args containing its metacharacters
      // (`&`, `|`, `<`, `>`, `%VAR%`), a regression for native hooks like
      // `node.exe ... R&D`. Only bare names and .cmd/.bat shims (npm/npx/
      // prettier) need the shell: a bare exec can't launch a .cmd shim and
      // modern Node throws EINVAL for it.
      const isNativeExe = /\.(exe|com)$/i.test(manifest.command);
      if (osCapabilities.scriptShimsRequireShell && !isNativeExe) {
        // Pre-quote each token into one command line so a path with spaces
        // (C:\Program Files\...) isn't split, and so cmd metacharacters are
        // protected: inside double quotes cmd treats &, |, <, >, (, )
        // literally. (%VAR% still expands even when quoted 鈥?an inherent
        // cmd /c limitation; native .exe hooks above avoid cmd entirely.)
        const quote = (s: string) =>
          /[\s"&|<>()^]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
        const commandLine = [manifest.command, ...(manifest.args ?? [])].map(quote).join(" ");
        child = spawn(commandLine, {
          shell: true,
          env,
          cwd: process.cwd(),
          stdio: ["pipe", "pipe", "pipe"],
          timeout: timeoutMs,
          // shell:true launches cmd.exe (a console-subsystem program). In
          // GUI/server mode the parent has no inherited console, so Windows
          // would allocate a fresh console window per child and flash a
          // black box on every hook firing (PreToolUse/PostToolUse run on
          // each tool call). Hide it, matching every other win32 spawn.
          windowsHide: true,
        });
      } else {
        child = spawn(manifest.command, manifest.args ?? [], {
          env,
          cwd: process.cwd(),
          stdio: ["pipe", "pipe", "pipe"],
          timeout: timeoutMs,
        });
      }
    } catch (e) {
      resolve({
        success: false,
        output: {},
        error: `Failed to spawn: ${e instanceof Error ? e.message : String(e)}`,
        durationMs: Date.now() - startMs,
      });
      return;
    }

    let stdout = "";
    let stderr = "";
    let settled = false;

    const settle = (result: HookRunResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    child.stdout?.on("data", (chunk: Buffer | string) => {
      stdout += typeof chunk === "string" ? chunk : chunk.toString("utf-8");
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderr += typeof chunk === "string" ? chunk : chunk.toString("utf-8");
    });

    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* best effort */ }
      settle({
        success: false,
        output: {},
        error: `Hook "${manifest.name}" timed out after ${timeoutMs}ms`,
        durationMs: Date.now() - startMs,
      });
    }, timeoutMs);

    child.on("close", (code) => {
      clearTimeout(timer);
      const durationMs = Date.now() - startMs;

      if (code !== 0) {
        settle({
          success: false,
          output: {},
          error: `Hook "${manifest.name}" exited with code ${code}${stderr ? `: ${stderr.trim().slice(0, 200)}` : ""}`,
          durationMs,
        });
        return;
      }

      const trimmed = stdout.trim();
      if (!trimmed) {
        settle({ success: true, output: {}, durationMs });
        return;
      }

      try {
        const parsed = JSON.parse(trimmed) as Record<string, unknown>;
        const output: HookOutput = {};

        if (parsed["decision"] === "allow" || parsed["decision"] === "deny") {
          output.decision = parsed["decision"] as "allow" | "deny";
        }
        if (typeof parsed["updatedInput"] === "object" && parsed["updatedInput"] !== null) {
          output.updatedInput = parsed["updatedInput"] as Record<string, unknown>;
        }
        if (typeof parsed["additionalContext"] === "string") {
          output.additionalContext = parsed["additionalContext"];
        }
        if (typeof parsed["reason"] === "string") {
          output.reason = parsed["reason"];
        }

        settle({ success: true, output, durationMs });
      } catch {
        settle({
          success: false,
          output: {},
          error: `Hook "${manifest.name}" returned invalid JSON: ${trimmed.slice(0, 100)}`,
          durationMs,
        });
      }
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      settle({
        success: false,
        output: {},
        error: `Hook "${manifest.name}" error: ${err.message}`,
        durationMs: Date.now() - startMs,
      });
    });

    // Write payload to stdin
    try {
      child.stdin?.write(JSON.stringify(payload));
      child.stdin?.end();
    } catch {
      // stdin may already be closed if process exited immediately
    }
  });
}
