#!/usr/bin/env bun

import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { basename, join, resolve } from "node:path";

// Builds the single-file binary for the host platform. CI runs this
// once per matrix slot (darwin-arm64 / linux-{x64,arm64} /
// win32-{x64,arm64}) so each runner produces its own tarball.
// Cross-compilation is intentionally not supported here — the bundled
// native libopentui binary has to match the host, and that's simplest
// when host == target.

type SupportedHost =
  | { platform: "darwin"; arch: "arm64" }
  | { platform: "linux"; arch: "x64" | "arm64" }
  | { platform: "win32"; arch: "x64" | "arm64" };

function detectHost(): SupportedHost {
  const { platform, arch } = process;
  if (platform === "darwin" && arch === "arm64") return { platform, arch };
  if (platform === "linux" && (arch === "x64" || arch === "arm64")) return { platform, arch };
  if (platform === "win32" && (arch === "x64" || arch === "arm64")) return { platform, arch };
  console.error(
    `build-binary: unsupported host ${platform}-${arch}. ` +
      `Supported: darwin-arm64, linux-x64, linux-arm64, win32-x64, win32-arm64.`,
  );
  process.exit(1);
}

const host = detectHost();

// Build-time gate: importing the registry runs loadModelSpecs / loadProviderSpecs,
// which throw on any invalid models.json / providers.json. Fail fast before the
// expensive compile so bad registry data can never ship.
try {
  await import("../src/model-registry.js");
  console.log("model/provider registry: valid");
} catch (err) {
  console.error("model/provider registry INVALID — aborting build:");
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}

const root = resolve(import.meta.dir, "..");
const buildDir = join(root, "build");
const binaryName = host.platform === "win32" ? "swarmflow.exe" : "swarmflow";
const binaryPath = join(buildDir, binaryName);
const entrypoint = join(root, "external", "opentui", "main.tsx");
const treeSitterWorkerEntrypoint = join(root, "external", "opentui", "forked", "core", "lib", "tree-sitter", "parser.worker.ts");
const treeSitterWorkerDir = join(buildDir, "tree-sitter");
const assetDirs = ["prompts", "skills"] as const;
const releaseTarball = join(buildDir, `swarmflow-${host.platform}-${host.arch}.tar.gz`);
const bunTarget = `bun-${host.platform}-${host.arch}` as const;

function nativeLibName(): string {
  if (host.platform === "darwin") return "libopentui.dylib";
  if (host.platform === "win32") return "opentui.dll";
  return "libopentui.so";
}

function findNativeLibrary(): string {
  const packageName = `@opentui/core-${host.platform}-${host.arch}`;
  const candidates = [
    join(root, "node_modules", packageName, nativeLibName()),
    join(root, "external", "opentui", "forked", "core", "zig", "zig-out", "lib", nativeLibName()),
  ];

  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) {
    throw new Error(
      `Could not find ${nativeLibName()} for ${host.platform}-${host.arch}. Checked:\n` +
        candidates.map((candidate) => `  - ${candidate}`).join("\n"),
    );
  }
  return found;
}

async function run(cmd: string[]): Promise<void> {
  const proc = Bun.spawn(cmd, {
    cwd: root,
    stdout: "inherit",
    stderr: "inherit",
    stdin: "inherit",
  });
  const code = await proc.exited;
  if (code !== 0) {
    throw new Error(`${cmd.join(" ")} exited with code ${code}`);
  }
}

rmSync(buildDir, { recursive: true, force: true });
mkdirSync(buildDir, { recursive: true });

await run([
  "bun",
  "build",
  "--compile",
  `--target=${bunTarget}`,
  "--outfile",
  binaryPath,
  entrypoint,
]);

mkdirSync(treeSitterWorkerDir, { recursive: true });
await run([
  "bun",
  "build",
  "--target",
  "bun",
  "--outdir",
  treeSitterWorkerDir,
  treeSitterWorkerEntrypoint,
]);

for (const dir of assetDirs) {
  cpSync(join(root, dir), join(buildDir, dir), {
    recursive: true,
    dereference: true,
    filter: (source) => basename(source) !== ".DS_Store",
  });
}

const nativeSource = findNativeLibrary();
const nativeTargetDir = join(buildDir, "native", `${host.platform}-${host.arch}`);
mkdirSync(nativeTargetDir, { recursive: true });
cpSync(nativeSource, join(nativeTargetDir, basename(nativeSource)), { dereference: true });

// Copy shell parser WASM files (used by the permission system's tree-sitter classifier)
const bashParserDir = join(buildDir, "bash-parser");
mkdirSync(bashParserDir, { recursive: true });
const { createRequire } = await import("node:module");
const { dirname: pathDirname } = await import("node:path");
const req = createRequire(import.meta.url);
const webTsWasm = req.resolve("web-tree-sitter/tree-sitter.wasm");
const bashWasm = join(pathDirname(req.resolve("tree-sitter-bash/package.json")), "tree-sitter-bash.wasm");
const psWasm = join(pathDirname(req.resolve("tree-sitter-powershell/package.json")), "tree-sitter-powershell.wasm");
cpSync(webTsWasm, join(bashParserDir, "tree-sitter.wasm"), { dereference: true });
cpSync(bashWasm, join(bashParserDir, "tree-sitter-bash.wasm"), { dereference: true });
cpSync(psWasm, join(bashParserDir, "tree-sitter-powershell.wasm"), { dereference: true });

await run([
  "tar",
  "-czf",
  releaseTarball,
  "-C",
  buildDir,
  binaryName,
  "native",
  "tree-sitter",
  "bash-parser",
  ...assetDirs,
]);

console.log(`Built ${binaryPath}`);
console.log(`Copied runtime assets to ${buildDir}`);
console.log(`Packaged ${releaseTarball}`);
