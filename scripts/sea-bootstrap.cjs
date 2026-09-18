"use strict";

const { existsSync } = require("node:fs");
const { spawnSync } = require("node:child_process");
const { createRequire } = require("node:module");
const { resolve, dirname, join } = require("node:path");

const distributionRoot = dirname(process.execPath);
const runtimeRoot = join(distributionRoot, "runtime");
const cliPath = join(runtimeRoot, "dist", "src", "cli.js");
const runtimeRequire = createRequire(__filename);
const FFI_RELAUNCH_MARKER = "SWARMFLOW_SEA_FFI_RELAUNCHED";
const NODE_FFI_EXEC_ARGS = [
  "--experimental-ffi",
  "--no-warnings",
];

function isSamePath(left, right) {
  try {
    return resolve(left).toLowerCase() === resolve(right).toLowerCase();
  } catch {
    return left === right;
  }
}

function getUserArguments() {
  const args = process.argv.slice(1);

  // SEA normally omits a script path. A relaunch from cli.ts deliberately
  // passes cliPath, so strip either representation before forwarding args.
  if (args[0] && (isSamePath(args[0], process.execPath) || isSamePath(args[0], cliPath))) {
    return args.slice(1);
  }

  return args;
}

function getNodeMajorVersion() {
  const major = Number.parseInt(process.versions.node.split(".", 1)[0] ?? "0", 10);
  return Number.isFinite(major) ? major : 0;
}

function hasNodeFfi() {
  try {
    require("node:ffi");
    return true;
  } catch {
    return false;
  }
}

function relaunchWithNodeFfi(userArgs) {
  if (process.env[FFI_RELAUNCH_MARKER] === "1") {
    throw new Error(
      "Node.js FFI is still unavailable after relaunch. Use Node.js 26 or newer to run the TUI executable.",
    );
  }

  if (getNodeMajorVersion() < 26) {
    throw new Error(
      `The TUI executable requires Node.js 26 or newer for node:ffi; embedded runtime is ${process.versions.node}.`,
    );
  }

  const nodeOptions = [process.env.NODE_OPTIONS, ...NODE_FFI_EXEC_ARGS]
    .filter(Boolean)
    .join(" ");
  const child = spawnSync(process.execPath, userArgs, {
    stdio: "inherit",
    env: {
      ...process.env,
      NODE_OPTIONS: nodeOptions,
      [FFI_RELAUNCH_MARKER]: "1",
    },
  });

  if (child.error) throw child.error;
  process.exit(child.status ?? 1);
}

function ensureWindowsUtf8Console() {
  if (process.platform !== "win32" || !process.stdout.isTTY) return;

  const commandShell = process.env.ComSpec || process.env.COMSPEC;
  if (!commandShell) return;

  try {
    spawnSync(commandShell, ["/d", "/s", "/c", "chcp 65001 > nul"], {
      stdio: "ignore",
    });
    process.stdout.setDefaultEncoding("utf8");
    process.stderr.setDefaultEncoding("utf8");
  } catch {
    // A redirected or shell-less launch can still use the UTF-8 byte stream.
  }
}

async function run() {
  ensureWindowsUtf8Console();

  if (!existsSync(cliPath)) {
    throw new Error(`SwarmFlow runtime is missing: ${runtimeRoot}`);
  }

  const userArgs = getUserArguments();
  if (!hasNodeFfi()) {
    relaunchWithNodeFfi(userArgs);
    return;
  }

  // Require before assigning the conventional argv shape so cli.ts does not
  // auto-run while being loaded by this launcher. Node 26 supports requiring
  // this ESM entry and keeps it compatible with the permission-enabled SEA
  // process, whose embedder loader rejects dynamic file:// imports.
  const { main } = runtimeRequire(cliPath);
  process.argv = [process.execPath, cliPath, ...userArgs];
  await main(process.argv);
}

run().catch((error) => {
  console.error("Fatal error:", error);
  process.exitCode = 1;
});
