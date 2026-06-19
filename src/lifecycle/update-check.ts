/**
 * 更新检查器和自我更新器。
 *
 * 每次启动最多一次在后台检查 GitHub Releases 是否有新版本。
 * 将结果缓存到 ~/.swarmflow/.update-check.json。
 *
 * 更新流程：
 *   1. 后台检查发现新版本 → 下载 tarball 到 ~/.swarmflow/staged/
 *   2. TUI 显示提示："v0.3.0 ready — restart to apply"
 *   3. 在下次启动时，applyStaged() 将暂存文件安装到安装
 *      目录（进程内）— 在每个平台上。Windows 拒绝删除或
 *      覆盖正在使用的文件（运行中的 swarmflow.exe、被另一个实例
 *      加载的 DLL），但允许重命名，因此被锁定的文件
 *      被重命名为 *.old.<timestamp>，新文件移入；
 *      残留物在后续启动时最佳努力清理。与
 *      Claude Code 的原生安装程序和 rustup 相同。如果安装仍然失败
 *      （临时锁定），暂存文件保留并在下次启动时重试。
 *
 * `swarmflow update` 使用相同的暂存路径并要求用户重启。
 */

import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { basename, dirname, join } from "node:path";

import { binaryAsset, osCapabilities } from "./platform/index.js";
import { binaryAssetForPlatform } from "./platform/binary-asset/index.js";
import { currentPlatform, type SupportedPlatform } from "./platform/detect.js";
import { getSwarmflowHomeDir } from "./lib/home-path.js";

const GITHUB_REPO = "tyx-git/SwarmFlow";
const CACHE_FILE = ".update-check.json";
// 不再节流 — 每次启动都在后台检查更新。

interface UpdateCache {
  lastCheck: number;
  latestVersion: string;
}

interface GitHubRelease {
  tag_name?: string;
  assets?: { name?: string; browser_download_url?: string }[];
}

interface ApplyStagedOptions {
  platform?: SupportedPlatform;
  execPath?: string;
}

export type ApplyStagedResult =
  | { kind: "none" }
  | { kind: "applied"; version: string | null };

function homeDir(override?: string): string {
  return override ?? getSwarmflowHomeDir();
}

function cachePath(home: string): string {
  return join(home, CACHE_FILE);
}

function stagedDir(home: string): string {
  return join(home, "staged");
}

function readCache(home: string): UpdateCache | null {
  try {
    const raw = JSON.parse(readFileSync(cachePath(home), "utf-8"));
    if (typeof raw.lastCheck === "number" && typeof raw.latestVersion === "string") {
      return raw as UpdateCache;
    }
  } catch { /* 忽略 */ }
  return null;
}

function writeCache(cache: UpdateCache, home: string): void {
  try {
    mkdirSync(home, { recursive: true });
    writeFileSync(cachePath(home), JSON.stringify(cache));
  } catch { /* 忽略 */ }
}

function parseVersion(v: string): { parts: number[]; pre: string | undefined } {
  const clean = v.replace(/^v/, "");
  const [main, pre] = clean.split("-", 2);
  const parts = (main ?? "").split(".").map(Number);
  return { parts, pre };
}

/**
 * 如果 `latest` 比 `current` 更新则返回 true。
 * 处理预发布版本：相同 major.minor.patch 下正式版 > 预发布版。
 * 不比较预发布标识符（alpha.1 vs alpha.2）— 它们被视为相等
 *（手动 `swarmflow update` 会处理预发布升级）。
 */
export function compareVersions(current: string, latest: string): boolean {
  const c = parseVersion(current);
  const l = parseVersion(latest);
  for (let i = 0; i < 3; i++) {
    const cv = c.parts[i] ?? 0;
    const lv = l.parts[i] ?? 0;
    if (isNaN(cv) || isNaN(lv)) return false;
    if (lv > cv) return true;
    if (lv < cv) return false;
  }
  if (c.pre && !l.pre) return true;
  return false;
}

/**
 * 三向版本比较：a < b → -1，a === b → 0，a > b → 1。
 * 用于磁盘版本检查，此处需要 >=，而不只是“是否更新”。
 */
export function compareVersionOrder(a: string, b: string): -1 | 0 | 1 {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  for (let i = 0; i < 3; i++) {
    const av = pa.parts[i] ?? 0;
    const bv = pb.parts[i] ?? 0;
    if (isNaN(av) || isNaN(bv)) return 0;
    if (av < bv) return -1;
    if (av > bv) return 1;
  }
  if (pa.pre && !pb.pre) return -1;
  if (!pa.pre && pb.pre) return 1;
  return 0;
}

/**
 * 将更新分类为 patch、minor 或 major。
 * 仅在 `compareVersions(current, latest) === true` 后调用。
 * 如果 latest <= current 则返回 null（防御性处理）。
 */
export function getReleaseType(current: string, latest: string): "patch" | "minor" | "major" | null {
  const c = parseVersion(current);
  const l = parseVersion(latest);
  const cMajor = c.parts[0] ?? 0;
  const cMinor = c.parts[1] ?? 0;
  const lMajor = l.parts[0] ?? 0;
  const lMinor = l.parts[1] ?? 0;
  if (isNaN(cMajor) || isNaN(cMinor) || isNaN(lMajor) || isNaN(lMinor)) return null;
  if (lMajor > cMajor) return "major";
  if (lMajor < cMajor) return null;
  if (lMinor > cMinor) return "minor";
  if (lMinor < cMinor) return null;
  if (compareVersionOrder(current, latest) < 0) return "patch";
  return null;
}

function assetName(): string {
  return binaryAsset.tarballName;
}

const BINARY_NAMES = new Set(["swarmflow", "swarmflow.exe"]);

function executableNameForPlatform(platform: SupportedPlatform): string {
  return binaryAssetForPlatform(platform).executableName;
}

function isProductionInstall(
  platform: SupportedPlatform = currentPlatform(),
  execPath: string = process.execPath,
): boolean {
  const expected = executableNameForPlatform(platform);
  return basename(execPath).toLowerCase() === expected.toLowerCase();
}

// v0.3.10 之前的 Windows 更新会经过分离的 PowerShell 交接；
// 这些是它留在磁盘上的残留物。每次启动时尽力删除。
const LEGACY_HANDOFF_FILES = [
  ".update-handoff-pending",
  "apply-staged-helper.ps1",
  ".update-restart-args.json",
];

function cleanupLegacyHandoffArtifacts(home: string, installDir: string): void {
  for (const name of LEGACY_HANDOFF_FILES) {
    try {
      rmSync(join(home, name), { force: true });
    } catch { /* best-effort */ }
  }
  try {
    rmSync(join(installDir, "updater"), { recursive: true, force: true });
  } catch { /* best-effort */ }
}

const RENAMED_OLD_PATTERN = /\.old\.\d+$/;

/**
 * 删除 installFile 重命名回退留下的 *.old.<timestamp> 文件。
 * 当重命名后的镜像仍被运行中进程映射时删除会失败 — 这些文件会被跳过，
 * 并在后续启动时重试。深度 3 覆盖所有锁定文件可能存在的位置：
 * 可执行文件（根目录）和原生库（native/<platform>/<lib>）。
 */
function cleanupRenamedOldFiles(dir: string, depth = 3): void {
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth > 1) cleanupRenamedOldFiles(full, depth - 1);
      } else if (RENAMED_OLD_PATTERN.test(entry.name)) {
        try {
          rmSync(full, { force: true });
        } catch { /* 仍被运行中进程映射；下次启动再试 */ }
      }
    }
  } catch { /* best-effort */ }
}

async function fetchChecksumFile(downloadUrl: string): Promise<string | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    const resp = await fetch(`${downloadUrl}.sha256`, { signal: controller.signal });
    clearTimeout(timer);
    if (!resp.ok) return null;
    const text = await resp.text();
    const match = text.match(/^[a-f0-9]{64}/i);
    return match?.[0] ?? null;
  } catch {
    return null;
  }
}

function computeSha256(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

async function fetchLatestRelease(): Promise<{ version: string; downloadUrl: string | null } | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    const resp = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/releases/latest`, {
      signal: controller.signal,
      headers: { Accept: "application/vnd.github.v3+json" },
    });
    clearTimeout(timer);
    if (!resp.ok) return null;
    const data = (await resp.json()) as GitHubRelease;
    const version = data.tag_name?.replace(/^v/, "");
    if (!version) return null;
    const target = assetName();
    const asset = data.assets?.find((a) => a.name === target);
    return { version, downloadUrl: asset?.browser_download_url ?? null };
  } catch {
    return null;
  }
}

// 如果这么久没有收到任何字节，则中止下载。Bun 的 fetch 没有内置停滞超时，
// 因此没有进展的挂起连接（进程无法到达代理后的受阻主机）否则会永远等待 —
// 这个 bug 曾表现为自更新卡在 "Downloading update..."。停滞看门狗
//（而不是固定总超时）仍能容忍缓慢但持续推进的大文件下载。
const DOWNLOAD_STALL_TIMEOUT_MS = 30_000;

/**
 * 使用停滞看门狗将 URL 下载到内存：计时器在请求前启动
 *（因此也限制连接/TTFB），并在每个 chunk 上重置；
 * 如果触发，则中止 fetch。返回完整 body 字节。
 */
async function downloadToBytes(
  url: string,
  stallMs = DOWNLOAD_STALL_TIMEOUT_MS,
): Promise<Uint8Array> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const armWatchdog = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(
      () =>
        controller.abort(
          new Error(`Download stalled (no data for ${Math.round(stallMs / 1000)}s)`),
        ),
      stallMs,
    );
  };

  armWatchdog();
  try {
    const resp = await fetch(url, { signal: controller.signal });
    if (!resp.ok || !resp.body) throw new Error(`Download failed: ${resp.status}`);

    const reader = resp.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        chunks.push(value);
        total += value.length;
        armWatchdog();
      }
    }

    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      out.set(chunk, offset);
      offset += chunk.length;
    }
    return out;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function downloadAndStage(downloadUrl: string, home: string): Promise<void> {
  const staged = stagedDir(home);
  rmSync(staged, { recursive: true, force: true });
  mkdirSync(staged, { recursive: true });

  const tarball = join(staged, "update.tar.gz");
  const bytes = await downloadToBytes(downloadUrl);

  const expectedHash = await fetchChecksumFile(downloadUrl);
  if (expectedHash) {
    const actualHash = computeSha256(bytes);
    if (actualHash.toLowerCase() !== expectedHash.toLowerCase()) {
      rmSync(staged, { recursive: true, force: true });
      throw new Error("Checksum mismatch — download may be corrupted");
    }
  }

  writeFileSync(tarball, bytes);

  const proc = Bun.spawn(["tar", "-xzf", tarball, "-C", staged], {
    stdout: "ignore",
    stderr: "pipe",
  });
  const code = await proc.exited;
  if (code !== 0) throw new Error("Failed to extract update tarball");

  rmSync(tarball);
}

/**
 * 通过 copy→temp→rename 安装单个文件。在 POSIX 上，即使 dest 正在执行，
 * rename 也会原子替换 dest（旧 inode 以无名形式继续存在）。
 * 在 Windows 上，替换正在使用镜像的文件会失败 — 但允许重命名该文件，
 * 因此回退路径会将 dest 移到 *.old.<ts>，再移入新文件；如果失败则回滚重命名。
 * .old 文件会在可行时立即删除，否则由后续启动中的 cleanupRenamedOldFiles 清理。
 */
function installFile(src: string, dest: string, preserveDestMode: boolean): void {
  const tmp = `${dest}.tmp`;
  rmSync(tmp, { force: true });
  cpSync(src, tmp);
  if (preserveDestMode && osCapabilities.supportsPosixPermissions) {
    try {
      chmodSync(tmp, statSync(dest).mode);
    } catch { /* Dest可能还不存在 */ }
  }
  try {
    renameSync(tmp, dest);
  } catch (err) {
    if (!existsSync(dest)) throw err;
    const old = `${dest}.old.${Date.now()}`;
    renameSync(dest, old);
    try {
      renameSync(tmp, dest);
    } catch (moveErr) {
      try {
        renameSync(old, dest); // 回滚以保持安装仍可工作
      } catch { /* 留下重命名的副本；没有发生什么破坏性的事情 */ }
      throw moveErr;
    }
    try {
      rmSync(old, { force: true });
    } catch { /* 镜像仍被映射；后续启动时清理 */ }
  }
}

/* 将 src 目录按文件叠加到 dest 目录；替换文件并保留目录结构。 */
function overlayEntry(src: string, dest: string): void {
  if (statSync(src).isDirectory()) {
    if (existsSync(dest) && !statSync(dest).isDirectory()) {
      rmSync(dest, { force: true });
    }
    mkdirSync(dest, { recursive: true });
    for (const child of readdirSync(src)) {
      overlayEntry(join(src, child), join(dest, child));
    }
  } else {
    installFile(src, dest, false);
  }
}

/**
 * 将暂存条目安装到安装目录，二进制文件最后处理：
 * 可执行文件替换是提交点，因此中途失败会留下可启动的旧二进制，
 * 下次启动会从暂存目录重试。
 *
 * 目录会整体替换（清理新版本已删除的文件）；当失败时 — 例如 Windows 上
 * 其中的 DLL 被另一个运行中实例加载 — 回退为逐文件叠加，
 * 并对锁定文件使用重命名移开处理。
 */
function installStagedEntries(staged: string, installDir: string): void {
  const entries = readdirSync(staged);
  const ordered = [
    ...entries.filter((e) => !BINARY_NAMES.has(e)),
    ...entries.filter((e) => BINARY_NAMES.has(e)),
  ];
  for (const entry of ordered) {
    const src = join(staged, entry);
    const dest = join(installDir, entry);

    if (BINARY_NAMES.has(entry)) {
      installFile(src, dest, true);
    } else if (statSync(src).isDirectory()) {
      try {
        rmSync(dest, { recursive: true, force: true });
        cpSync(src, dest, { recursive: true });
      } catch {
        overlayEntry(src, dest);
      }
    } else {
      installFile(src, dest, false);
    }
  }
}

/**
 * 启动时应用暂存更新。将文件从 ~/.swarmflow/staged/ 安装到安装目录
 *（~/.swarmflow/bin/）— 每个平台都使用相同的进程内路径
 *（Windows 锁定文件策略见模块头部）。失败时保留 staged，
 * 并在下次启动时重试应用。
 */
export function applyStaged(
  homeDirOverride?: string,
  options: ApplyStagedOptions = {},
): ApplyStagedResult {
  const home = homeDir(homeDirOverride);
  const platform = options.platform ?? currentPlatform();
  const execPath = options.execPath ?? process.execPath;
  if (!isProductionInstall(platform, execPath)) return { kind: "none" };

  const installDir = dirname(execPath);
  cleanupLegacyHandoffArtifacts(home, installDir);
  cleanupRenamedOldFiles(installDir);

  const staged = stagedDir(home);
  if (!existsSync(staged)) return { kind: "none" };

  const entries = readdirSync(staged);
  if (entries.length === 0) {
    rmSync(staged, { recursive: true, force: true });
    return { kind: "none" };
  }

  const cache = readCache(home);
  const version = cache?.latestVersion ?? null;

  // 磁盘版本检查：如果另一个实例已应用则跳过
  if (version) {
    try {
      const binaryPath = join(installDir, executableNameForPlatform(platform));
      const result = Bun.spawnSync([binaryPath, "--version"], {
        stdout: "pipe",
        stderr: "ignore",
        timeout: 3000,
      });
      const diskVersion = result.stdout.toString().trim();
      if (diskVersion && compareVersionOrder(diskVersion, version) >= 0) {
        rmSync(staged, { recursive: true, force: true });
        return { kind: "none" };
      }
    } catch { /* 继续申请 */ }
  }

  try {
    installStagedEntries(staged, installDir);
  } catch (err) {
    // 很可能是临时锁定（另一个 swarmflow 实例仍在运行）。
    // 保留 staged 以便下次启动重试；本会话继续运行当前二进制。
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`swarmflow: staged update not applied (${msg}); will retry on next launch.`);
    return { kind: "none" };
  }
  rmSync(staged, { recursive: true, force: true });
  return { kind: "applied", version };
}

/**
 * 非阻塞后台更新检查。
 * `autoUpdate` 控制下载行为：
 *   - true（默认）：patch/minor 自动下载；major 仅通知
 *   - "notify"：所有版本都仅通知
 * 返回一个生成当前 UpdateState 的回调。
 */
export function checkForUpdates(
  currentVersion: string,
  homeDirOverride?: string,
  autoUpdate: boolean | "notify" = true,
): () => UpdateState {
  const home = homeDir(homeDirOverride);
  let state: UpdateState = { phase: "checking", currentVersion };

  const shouldDownload = (releaseVersion: string): boolean => {
    if (autoUpdate === "notify") return false;
    const type = getReleaseType(currentVersion, releaseVersion);
    return type === "patch" || type === "minor";
  };

  void (async () => {
    let latestVersion: string | undefined;
    try {
      const release = await fetchLatestRelease();
      if (!release) {
        state = { phase: "idle", currentVersion };
        return;
      }
      latestVersion = release.version;
      writeCache({ lastCheck: Date.now(), latestVersion: release.version }, home);
      if (!compareVersions(currentVersion, release.version)) {
        state = { phase: "idle", currentVersion };
        return;
      }
      state = { phase: "available", currentVersion, latestVersion: release.version };
      if (release.downloadUrl && shouldDownload(release.version)) {
        state = { phase: "downloading", currentVersion, latestVersion: release.version };
        await downloadAndStage(release.downloadUrl, home);
        state = { phase: "staged", currentVersion, latestVersion: release.version };
      }
    } catch (err) {
      state = {
        phase: "failed",
        currentVersion,
        latestVersion,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  })();

  return () => state;
}

/**
 * 仅检查：获取最新版本并打印比较结果。
 */
export async function runUpdateCheck(currentVersion: string): Promise<void> {
  console.log("Checking for updates...");
  const release = await fetchLatestRelease();
  if (!release) {
    console.log("Could not reach GitHub. Check your network connection.");
    return;
  }
  if (!compareVersions(currentVersion, release.version)) {
    console.log(`Already up to date (${currentVersion}).`);
  } else {
    const type = getReleaseType(currentVersion, release.version);
    console.log(`Update available: ${currentVersion} → ${release.version} (${type ?? "unknown"})`);
    if (!release.downloadUrl) {
      console.log(`No binary found for ${process.platform}-${process.arch}.`);
    }
  }
}

/**
 * 完整更新：下载、验证，并为下次重启暂存。
 */
export async function runUpdate(currentVersion: string, homeDirOverride?: string): Promise<void> {
  const home = homeDir(homeDirOverride);
  const platform = currentPlatform();

  if (!isProductionInstall(platform)) {
    console.log("Cannot update: not running from a production install.");
    console.log(`Expected: ${join(home, "bin", executableNameForPlatform(platform))}`);
    console.log(`Actual:   ${process.execPath}`);
    return;
  }

  console.log("Checking for updates...");
  const release = await fetchLatestRelease();
  if (!release) {
    console.log("Could not reach GitHub. Check your network connection.");
    return;
  }

  if (!compareVersions(currentVersion, release.version)) {
    console.log(`Already up to date (${currentVersion}).`);
    return;
  }

  if (!release.downloadUrl) {
    console.log(`Version ${release.version} is available but no binary found for ${process.platform}-${process.arch}.`);
    return;
  }

  console.log(`[1/3] Downloading v${release.version}...`);
  await downloadAndStage(release.downloadUrl, home);
  writeCache({ lastCheck: Date.now(), latestVersion: release.version }, home);

  console.log("[2/3] Verifying checksum...");
  // 如果 .sha256 可用，校验和已在 downloadAndStage 内验证。

  console.log("[3/3] Staging update...");
  console.log(`✓ v${release.version} ready. Restart swarmflow to apply the update.`);
}

// ------------------------------------------------------------------
// 供 TUI 消费的结构化更新状态
// ------------------------------------------------------------------

export type UpdatePhase =
  | "idle"
  | "checking"
  | "available"
  | "downloading"
  | "staged"
  | "failed"
  | "disabled";

export interface UpdateState {
  phase: UpdatePhase;
  currentVersion: string;
  latestVersion?: string;
  error?: string;
}

const IDLE_STATE: UpdateState = { phase: "idle", currentVersion: "" };

let _updateStateGetter: (() => UpdateState) | null = null;

export function setUpdateStateGetter(getter: () => UpdateState): void {
  _updateStateGetter = getter;
}

export function getUpdateState(): UpdateState {
  return _updateStateGetter?.() ?? IDLE_STATE;
}

let _relaunchCallback: (() => void) | null = null;

export function setRelaunchCallback(cb: () => void): void {
  _relaunchCallback = cb;
}

export function triggerRelaunch(): void {
  _relaunchCallback?.();
}

export function getUpdateNotice(): string | null {
  const state = getUpdateState();
  switch (state.phase) {
    case "staged":
      return `✓ v${state.latestVersion} ready (restart to apply)`;
    case "available":
      return `v${state.latestVersion} available — run \`swarmflow update\``;
    case "downloading":
      return `Downloading v${state.latestVersion}...`;
    case "failed":
      return state.latestVersion
        ? `Update to v${state.latestVersion} failed — check proxy/network`
        : "Update check failed — check proxy/network";
    default:
      return null;
  }
}
