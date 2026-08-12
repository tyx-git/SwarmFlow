import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { build as buildWithEsbuild } from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputRoot = join(root, "release", "SwarmFlow-win32-x64");
const runtimeRoot = join(outputRoot, "runtime");
const executablePath = join(outputRoot, "SwarmFlow.exe");
const seaConfigPath = join(outputRoot, "sea-config.json");
const seaBlobPath = join(outputRoot, "sea-prep.blob");
const nvmPostjectCli = join(root, "node_modules", "postject", "dist", "cli.js");
const bootstrapPath = join(root, "scripts", "sea-bootstrap.cjs");
const ignoredNodeModuleRoots = new Set([".bun", ".vite", ".vite-temp", ".cache"]);
const nodeMajorVersion = Number.parseInt(process.versions.node.split(".", 1)[0] ?? "0", 10);

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: "inherit",
    ...options,
  });

  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with exit code ${result.status ?? "unknown"}.`);
  }
}

function requireFile(path, label) {
  if (!existsSync(path)) throw new Error(`${label} was not found: ${path}`);
}

function readSeaFuse(nodePath) {
  const match = readFileSync(nodePath).toString("latin1").match(/NODE_SEA_FUSE_[A-Za-z0-9]+/);
  if (!match) throw new Error(`The current Node.js binary does not expose a SEA fuse: ${nodePath}`);
  return match[0];
}

function copyRuntimeDirectory(sourceName) {
  const source = join(root, sourceName);
  requireFile(source, `${sourceName} directory`);
  cpSync(source, join(runtimeRoot, sourceName), { recursive: true, force: true });
}

function copyRuntimeNodeModules() {
  const source = join(root, "node_modules");
  const destination = join(runtimeRoot, "node_modules");
  requireFile(source, "node_modules directory");

  cpSync(source, destination, {
    recursive: true,
    force: true,
    filter: (current) => {
      const pathFromRoot = relative(source, current);
      if (!pathFromRoot) return true;
      const firstSegment = pathFromRoot.split(sep)[0];
      return !ignoredNodeModuleRoots.has(firstSegment);
    },
  });
}

function patchNodeRuntimePackages() {
  const reconcilerPackagePath = join(runtimeRoot, "node_modules", "react-reconciler", "package.json");
  if (!existsSync(reconcilerPackagePath)) return;

  const packageJson = JSON.parse(readFileSync(reconcilerPackagePath, "utf8"));
  packageJson.exports = {
    ".": "./index.js",
    "./constants": "./constants.js",
    "./reflection": "./reflection.js",
    "./package.json": "./package.json",
  };
  writeFileSync(reconcilerPackagePath, `${JSON.stringify(packageJson, null, 2)}\n`);
}

async function buildOpenTuiEntry() {
  const entry = join(root, "external", "opentui", "main.tsx");
  const output = join(runtimeRoot, "external", "opentui", "main.js");

  console.log("Compiling OpenTUI entry for the Node runtime...");
  await buildWithEsbuild({
    absWorkingDir: root,
    entryPoints: [entry],
    outfile: output,
    bundle: true,
    format: "esm",
    platform: "node",
    target: `node${nodeMajorVersion}`,
    packages: "external",
    jsx: "automatic",
    loader: {
      ".scm": "file",
      ".wasm": "file",
    },
    assetNames: "assets/[name]-[hash]",
    plugins: [
      {
        name: "normalize-file-import-attributes",
        setup(build) {
          build.onLoad({ filter: /default-parsers\.ts$/ }, (args) => ({
            contents: readFileSync(args.path, "utf8").replace(
              /import\((['"])([^'"]+)\1\s+as string,\s*\{\s*with:\s*\{\s*type:\s*['"]file['"]\s*\}\s*\}\s*\)/g,
              "import($1$2$1)",
            ),
            loader: "ts",
          }));
        },
      },
    ],
    sourcemap: false,
    logLevel: "error",
  });
}

if (process.platform !== "win32" || process.arch !== "x64") {
  throw new Error("build:exe currently supports win32-x64 only.");
}

if (!Number.isFinite(nodeMajorVersion) || nodeMajorVersion < 26) {
  throw new Error(
    `build:exe requires Node.js 26 or newer because @opentui/core uses node:ffi (current: ${process.versions.node}).`,
  );
}

requireFile(bootstrapPath, "SEA bootstrap");
requireFile(nvmPostjectCli, "postject CLI");
requireFile(join(root, "node_modules", "typescript", "bin", "tsc"), "TypeScript compiler");

console.log("Assembling portable runtime...");
rmSync(outputRoot, { recursive: true, force: true });
mkdirSync(runtimeRoot, { recursive: true });
const runtimeDist = join(runtimeRoot, "dist");

console.log("Building compiled JavaScript output...");
run(process.execPath, [
  join(root, "node_modules", "typescript", "bin", "tsc"),
  "-p",
  "tsconfig.build.json",
  "--outDir",
  runtimeDist,
]);
run(process.execPath, [join(root, "scripts", "copy-node-assets.mjs"), runtimeDist]);
requireFile(join(runtimeDist, "src", "cli.js"), "compiled CLI");

for (const directory of ["src", "assets", "prompts", "skills", "external/opentui"]) {
  copyRuntimeDirectory(directory);
}
await buildOpenTuiEntry();
copyFileSync(join(root, "package.json"), join(runtimeRoot, "package.json"));
copyRuntimeNodeModules();
patchNodeRuntimePackages();

writeFileSync(
  seaConfigPath,
  JSON.stringify(
    {
      main: bootstrapPath,
      output: seaBlobPath,
      disableExperimentalSEAWarning: true,
    },
    null,
    2,
  ),
);

console.log("Generating SEA blob...");
run(process.execPath, ["--experimental-sea-config", seaConfigPath]);
requireFile(seaBlobPath, "SEA blob");

console.log("Injecting SEA blob into SwarmFlow.exe...");
copyFileSync(process.execPath, executablePath);
run(process.execPath, [
  nvmPostjectCli,
  executablePath,
  "NODE_SEA_BLOB",
  seaBlobPath,
  "--sentinel-fuse",
  readSeaFuse(process.execPath),
  "--overwrite",
]);

rmSync(seaConfigPath, { force: true });
rmSync(seaBlobPath, { force: true });
writeFileSync(
  join(outputRoot, "README.txt"),
  [
    "Run SwarmFlow.exe directly. Keep the runtime directory next to the executable.",
    "This distribution targets Windows x64.",
  ].join("\r\n") + "\r\n",
);

const sizeMb = (statSync(executablePath).size / (1024 * 1024)).toFixed(1);
console.log(`Built ${executablePath} (${sizeMb} MB).`);
