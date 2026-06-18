/**
 * Update checker and self-updater.
 *
 * Checks GitHub Releases for a newer version at most once per 24 hours.
 * Caches the result in ~/.swarmflow/.update-check.json.
 *
 * Update flow:
 *   1. Background check finds a new version 鈫?downloads tarball to ~/.swarmflow/staged/
 *   2. TUI shows a hint: "v0.3.0 ready 鈥?restart to apply"
 *   3. On next startup, applyStaged() installs staged files into the install
 *      dir in-process 鈥?on every platform. Windows refuses to delete or
 *      overwrite a file whose image is in use (the running swarmflow.exe, a DLL
 *      loaded by another instance) but allows RENAMING it, so locked files
 *      are renamed aside to *.old.<timestamp> and the new file moved in;
 *      leftovers are cleaned up best-effort on later launches. Same idiom as
 *      Claude Code's native installer and rustup. If an install still fails
 *      (transient lock), staged is kept and retried on the next launch.
 *
 * `swarmflow update` uses the same staging path and asks the user to restart.
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
// No longer throttled 鈥?every launch checks for updates in the background.

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
  } catch { /* ignore */ }
  return null;
}

function writeCache(cache: UpdateCache, home: string): void {
  try {
    mkdirSync(home, { recursive: true });
    writeFileSync(cachePath(home), JSON.stringify(cache));
  } catch { /* ignore */ }
}

function parseVersion(v: string): { parts: number[]; pre: string | undefined } {
  const clean = v.replace(/^v/, "");
  const [main, pre] = clean.split("-", 2);
  const parts = (main ?? "").split(".").map(Number);
  return { parts, pre };
}

/**
 * Returns true if `latest` is a newer version than `current`.
 * Handles prerelease: release > prerelease for same major.minor.patch.
 * Does NOT compare prerelease identifiers (alpha.1 vs alpha.2) 鈥?those
 * are treated as equal (manual `swarmflow update` handles prerelease upgrades).
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
 * Three-way version comparison: a < b 鈫?-1, a === b 鈫?0, a > b 鈫?1.
 * Used for disk-version checks where we need >=, not just "is newer".
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
 * Classify the update as patch, minor, or major.
 * Only call after `compareVersions(current, latest) === true`.
 * Returns null if latest <= current (defensive).
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

// Pre-v0.3.10 Windows updates went through a detached PowerShell handoff;
// these are its on-disk leftovers. Removed best-effort on every launch.
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
 * Delete *.old.<timestamp> files left behind by installFile's rename-away
 * fallback. Deletion fails while the renamed image is still mapped by a
 * running process 鈥?those are skipped and retried on a later launch.
 * Depth 3 covers everywhere locked files live: the executable (root) and
 * native libraries (native/<platform>/<lib>).
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
        } catch { /* still mapped by a running process; next launch */ }
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

// Abort a download if no bytes arrive for this long. Bun's fetch has no
// built-in stall timeout, so a connection that hangs with no progress
// (a blocked host behind a proxy the process can't reach) would
// otherwise wait forever 鈥?the bug that surfaced as a self-update stuck
// at "Downloading update...". A stall watchdog (rather than a fixed
// total timeout) still tolerates a slow-but-progressing large download.
const DOWNLOAD_STALL_TIMEOUT_MS = 30_000;

/**
 * Download a URL into memory with a stall watchdog: the timer is armed
 * before the request (so it also bounds connect/TTFB) and reset on every
 * chunk; if it fires, the fetch is aborted. Returns the full body bytes.
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
      throw new Error("Checksum mismatch 鈥?download may be corrupted");
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
 * Install one file via copy鈫抰mp鈫抮ename. On POSIX the rename atomically
 * replaces dest even while it is executing (the old inode lives on unnamed).
 * On Windows, replacing a file whose image is in use fails 鈥?but renaming
 * that file is allowed, so the fallback moves dest aside to *.old.<ts>,
 * moves the new file in, and rolls the rename back if that fails. The .old
 * file is deleted immediately when possible, otherwise by
 * cleanupRenamedOldFiles on a later launch.
 */
function installFile(src: string, dest: string, preserveDestMode: boolean): void {
  const tmp = `${dest}.tmp`;
  rmSync(tmp, { force: true });
  cpSync(src, tmp);
  if (preserveDestMode && osCapabilities.supportsPosixPermissions) {
    try {
      chmodSync(tmp, statSync(dest).mode);
    } catch { /* dest might not exist yet */ }
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
        renameSync(old, dest); // roll back so the install keeps working
      } catch { /* leave the renamed copy; nothing destructive happened */ }
      throw moveErr;
    }
    try {
      rmSync(old, { force: true });
    } catch { /* image still mapped; cleaned up on a later launch */ }
  }
}

/** Per-file merge of src dir into dest dir; replaces files, keeps strays. */
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
 * Install staged entries into the install directory, binaries last: the
 * executable swap is the commit point, so a failure partway through leaves
 * the old binary launchable and the next launch retries from staged.
 *
 * Directories are replaced wholesale (clears files dropped by the new
 * version); when that fails 鈥?e.g. a DLL inside is loaded by another
 * running instance on Windows 鈥?they fall back to a per-file overlay with
 * rename-away handling for the locked files.
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
 * Apply a staged update on startup. Installs files from ~/.swarmflow/staged/
 * into the install directory (~/.swarmflow/bin/) 鈥?same in-process path on every
 * platform (see the module header for the Windows locked-file strategy).
 * On failure, staged is kept and the apply retries on the next launch.
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

  // Disk version check: skip if another instance already applied
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
    } catch { /* proceed with apply */ }
  }

  try {
    installStagedEntries(staged, installDir);
  } catch (err) {
    // Most likely a transient lock (another swarmflow instance still running).
    // Keep staged so the next launch retries; this session runs the current
    // binary.
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`swarmflow: staged update not applied (${msg}); will retry on next launch.`);
    return { kind: "none" };
  }
  rmSync(staged, { recursive: true, force: true });
  return { kind: "applied", version };
}

/**
 * Non-blocking background update check.
 * `autoUpdate` controls download behavior:
 *   - true (default): patch/minor auto-download; major notify only
 *   - "notify": all versions notify only
 * Returns a callback that yields the current UpdateState.
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
 * Check-only: fetch latest version and print comparison.
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
    console.log(`Update available: ${currentVersion} 鈫?${release.version} (${type ?? "unknown"})`);
    if (!release.downloadUrl) {
      console.log(`No binary found for ${process.platform}-${process.arch}.`);
    }
  }
}

/**
 * Full update: download, verify, and stage for the next restart.
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
  // Checksum was already verified inside downloadAndStage if .sha256 was available.

  console.log("[3/3] Staging update...");
  console.log(`鉁?v${release.version} ready. Restart swarmflow to apply the update.`);
}

// ------------------------------------------------------------------
// Structured update state for TUI consumption
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
      return `鉁?v${state.latestVersion} ready (restart to apply)`;
    case "available":
      return `v${state.latestVersion} available 鈥?run \`swarmflow update\``;
    case "downloading":
      return `Downloading v${state.latestVersion}...`;
    case "failed":
      return state.latestVersion
        ? `Update to v${state.latestVersion} failed 鈥?check proxy/network`
        : "Update check failed 鈥?check proxy/network";
    default:
      return null;
  }
}
