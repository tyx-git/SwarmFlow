import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";

import { binaryAssetForPlatform } from "../src/platform/binary-asset/index.js";
import { currentPlatform } from "../src/platform/detect.js";
import {
  applyStaged,
  checkForUpdates,
  compareVersions,
  compareVersionOrder,
  getReleaseType,
  runUpdate,
} from "../src/update-check.js";

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function buildReleaseTarball(entries: Record<string, string>): Uint8Array {
  const tempDir = mkdtempSync(join(tmpdir(), "swarmflow-release-src-"));
  const tarDir = mkdtempSync(join(tmpdir(), "swarmflow-release-out-"));
  const tarPath = join(tarDir, "release.tar.gz");
  try {
    for (const [relativePath, contents] of Object.entries(entries)) {
      const fullPath = join(tempDir, relativePath);
      mkdirSync(dirname(fullPath), { recursive: true });
      writeFileSync(fullPath, contents);
    }

    const result = Bun.spawnSync(["tar", "-czf", tarPath, "-C", tempDir, "."], {
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode).toBe(0);
    return new Uint8Array(readFileSync(tarPath));
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
    rmSync(tarDir, { recursive: true, force: true });
  }
}

describe("compareVersions", () => {
  it("detects newer patch version", () => {
    expect(compareVersions("0.3.0", "0.3.1")).toBe(true);
  });

  it("detects newer minor version", () => {
    expect(compareVersions("0.3.1", "0.4.0")).toBe(true);
  });

  it("detects newer major version", () => {
    expect(compareVersions("0.3.1", "1.0.0")).toBe(true);
  });

  it("returns false for same version", () => {
    expect(compareVersions("0.3.1", "0.3.1")).toBe(false);
  });

  it("returns false for older version", () => {
    expect(compareVersions("0.4.0", "0.3.1")).toBe(false);
  });

  it("strips v prefix", () => {
    expect(compareVersions("v0.3.0", "v0.3.1")).toBe(true);
  });

  it("treats release as newer than prerelease for same base", () => {
    expect(compareVersions("0.3.2-alpha", "0.3.2")).toBe(true);
    expect(compareVersions("0.3.2-alpha.3", "0.3.2")).toBe(true);
  });

  it("does not treat prerelease as newer than release for same base", () => {
    expect(compareVersions("0.3.2", "0.3.2-alpha")).toBe(false);
  });

  it("does not compare prerelease identifiers", () => {
    expect(compareVersions("0.3.2-alpha.1", "0.3.2-alpha.2")).toBe(false);
    expect(compareVersions("0.3.2-alpha", "0.3.2-beta")).toBe(false);
  });

  it("handles NaN gracefully", () => {
    expect(compareVersions("abc", "0.3.1")).toBe(false);
    expect(compareVersions("0.3.1", "abc")).toBe(false);
  });
});

describe("compareVersionOrder", () => {
  it("returns -1 when a < b", () => {
    expect(compareVersionOrder("0.3.0", "0.3.1")).toBe(-1);
  });

  it("returns 0 when equal", () => {
    expect(compareVersionOrder("0.3.1", "0.3.1")).toBe(0);
  });

  it("returns 1 when a > b", () => {
    expect(compareVersionOrder("0.4.0", "0.3.1")).toBe(1);
  });

  it("ranks release higher than prerelease for same base", () => {
    expect(compareVersionOrder("0.3.2-alpha", "0.3.2")).toBe(-1);
    expect(compareVersionOrder("0.3.2", "0.3.2-alpha")).toBe(1);
  });

  it("treats two prereleases for same base as equal", () => {
    expect(compareVersionOrder("0.3.2-alpha", "0.3.2-beta")).toBe(0);
  });
});

describe("getReleaseType", () => {
  it("detects patch", () => {
    expect(getReleaseType("0.3.0", "0.3.1")).toBe("patch");
  });

  it("detects minor", () => {
    expect(getReleaseType("0.3.1", "0.4.0")).toBe("minor");
  });

  it("detects major", () => {
    expect(getReleaseType("0.3.1", "1.0.0")).toBe("major");
  });

  it("returns null when latest <= current", () => {
    expect(getReleaseType("0.3.1", "0.3.1")).toBeNull();
    expect(getReleaseType("0.4.0", "0.3.1")).toBeNull();
  });

  it("classifies prerelease to release as patch", () => {
    expect(getReleaseType("0.3.2-alpha", "0.3.2")).toBe("patch");
  });
});

describe("applyStaged", () => {
  let tempHome: string;
  let tempSwarmflowHome: string;
  let tempInstallDir: string;

  beforeEach(() => {
    tempHome = mkdtempSync(join(tmpdir(), "swarmflow-update-apply-"));
    tempSwarmflowHome = join(tempHome, ".swarmflow");
    tempInstallDir = mkdtempSync(join(tmpdir(), "swarmflow-install-"));
  });

  afterEach(() => {
    mock.restore();
    rmSync(tempHome, { recursive: true, force: true });
    rmSync(tempInstallDir, { recursive: true, force: true });
  });

  it("applies staged files inline on POSIX platforms", () => {
    const execPath = join(tempInstallDir, "swarmflow");
    const staged = join(tempSwarmflowHome, "staged");
    writeFileSync(execPath, "old-binary");
    mkdirSync(join(staged, "skills"), { recursive: true });
    writeFileSync(join(staged, "swarmflow"), "new-binary");
    writeFileSync(join(staged, "skills", "tool.txt"), "new-skill");

    const result = applyStaged(tempSwarmflowHome, {
      platform: "linux",
      execPath,
    });

    expect(result).toEqual({ kind: "applied", version: null });
    expect(readFileSync(execPath, "utf-8")).toBe("new-binary");
    expect(readFileSync(join(tempInstallDir, "skills", "tool.txt"), "utf-8")).toBe("new-skill");
    expect(existsSync(staged)).toBe(false);
  });

  it("applies staged updates inline on Windows too (no helper handoff)", () => {
    const execPath = join(tempInstallDir, "swarmflow.exe");
    const staged = join(tempSwarmflowHome, "staged");
    writeFileSync(execPath, "old-binary");
    mkdirSync(join(staged, "skills"), { recursive: true });
    writeFileSync(join(staged, "swarmflow.exe"), "new-binary");
    writeFileSync(join(staged, "skills", "tool.txt"), "new-skill");

    const result = applyStaged(tempSwarmflowHome, {
      platform: "win32",
      execPath,
    });

    expect(result).toEqual({ kind: "applied", version: null });
    expect(readFileSync(execPath, "utf-8")).toBe("new-binary");
    expect(readFileSync(join(tempInstallDir, "skills", "tool.txt"), "utf-8")).toBe("new-skill");
    expect(existsSync(staged)).toBe(false);
  });

  it("keeps staged for retry when the install fails partway", () => {
    const execPath = join(tempInstallDir, "swarmflow");
    const staged = join(tempSwarmflowHome, "staged");
    writeFileSync(execPath, "old-binary");
    // A directory under the binary's name makes installFile's cpSync throw
    // deterministically on every platform.
    mkdirSync(join(staged, "swarmflow"), { recursive: true });
    writeFileSync(join(staged, "swarmflow", "oops.txt"), "x");

    const result = applyStaged(tempSwarmflowHome, { platform: "linux", execPath });

    expect(result).toEqual({ kind: "none" });
    expect(readFileSync(execPath, "utf-8")).toBe("old-binary");
    expect(existsSync(staged)).toBe(true);
  });

  it("cleans up rename-away leftovers and legacy handoff artifacts", () => {
    const execPath = join(tempInstallDir, "swarmflow");
    writeFileSync(execPath, "binary");
    // rename-away leftovers at root and one level deep (native libs)
    writeFileSync(join(tempInstallDir, "swarmflow.old.1718000000000"), "stale");
    mkdirSync(join(tempInstallDir, "native", "win32-x64"), { recursive: true });
    writeFileSync(join(tempInstallDir, "native", "win32-x64", "opentui.dll.old.5"), "stale");
    // legacy PowerShell-handoff artifacts
    mkdirSync(tempSwarmflowHome, { recursive: true });
    writeFileSync(join(tempSwarmflowHome, ".update-handoff-pending"), "1");
    writeFileSync(join(tempSwarmflowHome, "apply-staged-helper.ps1"), "x");
    writeFileSync(join(tempSwarmflowHome, ".update-restart-args.json"), "[]");
    mkdirSync(join(tempInstallDir, "updater"), { recursive: true });
    writeFileSync(join(tempInstallDir, "updater", "apply-staged.ps1"), "x");

    const result = applyStaged(tempSwarmflowHome, { platform: "linux", execPath });

    expect(result).toEqual({ kind: "none" }); // no staged update present
    expect(existsSync(join(tempInstallDir, "swarmflow.old.1718000000000"))).toBe(false);
    expect(existsSync(join(tempInstallDir, "native", "win32-x64", "opentui.dll.old.5"))).toBe(false);
    expect(existsSync(join(tempSwarmflowHome, ".update-handoff-pending"))).toBe(false);
    expect(existsSync(join(tempSwarmflowHome, "apply-staged-helper.ps1"))).toBe(false);
    expect(existsSync(join(tempSwarmflowHome, ".update-restart-args.json"))).toBe(false);
    expect(existsSync(join(tempInstallDir, "updater"))).toBe(false);
    expect(readFileSync(execPath, "utf-8")).toBe("binary");
  });
});

describe("checkForUpdates", () => {
  const originalFetch = globalThis.fetch;
  let tempHome: string;
  let tempSwarmflowHome: string;

  beforeEach(() => {
    tempHome = mkdtempSync(join(tmpdir(), "swarmflow-update-check-"));
    tempSwarmflowHome = join(tempHome, ".swarmflow");
  });

  afterEach(() => {
    mock.restore();
    if (originalFetch) {
      globalThis.fetch = originalFetch;
    } else {
      delete (globalThis as { fetch?: typeof fetch }).fetch;
    }
    rmSync(tempHome, { recursive: true, force: true });
  });

  it("ignores the on-disk cache and always starts a fresh background check", () => {
    // The cache short-circuit was removed on purpose: a stale cache must not
    // produce a synchronous "available"/"idle" verdict. The check always
    // starts in "checking" and resolves from the network.
    let resolveFetch!: (value: unknown) => void;
    globalThis.fetch = mock(async () => await new Promise((resolve) => {
      resolveFetch = resolve;
    })) as unknown as typeof fetch;

    mkdirSync(tempSwarmflowHome, { recursive: true });
    writeFileSync(join(tempSwarmflowHome, ".update-check.json"), JSON.stringify({
      lastCheck: Date.now(),
      latestVersion: "0.2.0",
    }));

    const getState = checkForUpdates("0.1.0", tempSwarmflowHome);
    expect(getState().phase).toBe("checking");
    expect(globalThis.fetch).toHaveBeenCalled();
    resolveFetch({ ok: false, status: 500 });
  });

  it("starts in checking phase before background fetch completes", async () => {
    let resolveFetch!: (value: {
      ok: boolean;
      json: () => Promise<{ tag_name: string; assets: { name: string; browser_download_url: string }[] }>;
    }) => void;
    const pendingFetch = new Promise<{
      ok: boolean;
      json: () => Promise<{ tag_name: string; assets: { name: string; browser_download_url: string }[] }>;
    }>((resolve) => {
      resolveFetch = resolve;
    });
    globalThis.fetch = mock(async () => await pendingFetch) as typeof fetch;

    const getState = checkForUpdates("0.1.0", tempSwarmflowHome);
    expect(getState().phase).toBe("checking");

    resolveFetch({
      ok: true,
      json: async () => ({ tag_name: "v0.2.0", assets: [] }),
    });

    for (let i = 0; i < 10; i++) await Promise.resolve();

    expect(getState().phase).toBe("available");
    expect(getState().latestVersion).toBe("0.2.0");
  });
});

describe("runUpdate", () => {
  const originalFetch = globalThis.fetch;
  const originalExecPath = process.execPath;
  let tempHome: string;
  let tempSwarmflowHome: string;
  let tempInstallDir: string;

  beforeEach(() => {
    tempHome = mkdtempSync(join(tmpdir(), "swarmflow-run-update-"));
    tempSwarmflowHome = join(tempHome, ".swarmflow");
    tempInstallDir = mkdtempSync(join(tmpdir(), "swarmflow-install-"));
  });

  afterEach(() => {
    mock.restore();
    Object.defineProperty(process, "execPath", { value: originalExecPath, configurable: true });
    if (originalFetch) {
      globalThis.fetch = originalFetch;
    } else {
      delete (globalThis as { fetch?: typeof fetch }).fetch;
    }
    rmSync(tempHome, { recursive: true, force: true });
    rmSync(tempInstallDir, { recursive: true, force: true });
  });

  it("downloads and stages the update without installing it inline", async () => {
    const platform = currentPlatform();
    const asset = binaryAssetForPlatform(platform);
    const execPath = join(tempInstallDir, asset.executableName);
    writeFileSync(execPath, "old-binary");
    Object.defineProperty(process, "execPath", { value: execPath, configurable: true });

    const tarballBytes = buildReleaseTarball({
      [asset.executableName]: "new-binary",
      "skills/tool.txt": "new-skill",
    });
    const checksum = createHash("sha256").update(tarballBytes).digest("hex");
    const fetchMock = mock(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/releases/latest")) {
        return {
          ok: true,
          json: async () => ({
            tag_name: "v9.9.9",
            assets: [{
              name: asset.tarballName,
              browser_download_url: "https://example.com/release.tar.gz",
            }],
          }),
        };
      }
      if (url === "https://example.com/release.tar.gz") {
        return {
          ok: true,
          body: new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new Uint8Array(tarballBytes));
              controller.close();
            },
          }),
          arrayBuffer: async () => toArrayBuffer(tarballBytes),
        };
      }
      if (url === "https://example.com/release.tar.gz.sha256") {
        return {
          ok: true,
          text: async () => `${checksum}  release.tar.gz`,
        };
      }
      throw new Error(`Unexpected fetch URL: ${url}`);
    });
    globalThis.fetch = fetchMock as typeof fetch;

    const logSpy = spyOn(console, "log").mockImplementation(() => {});
    try {
      await runUpdate("0.1.0", tempSwarmflowHome);
    } finally {
      logSpy.mockRestore();
    }

    expect(readFileSync(execPath, "utf-8")).toBe("old-binary");
    expect(readFileSync(join(tempSwarmflowHome, "staged", asset.executableName), "utf-8")).toBe("new-binary");
    expect(readFileSync(join(tempSwarmflowHome, "staged", "skills", "tool.txt"), "utf-8")).toBe("new-skill");
    expect(readFileSync(join(tempSwarmflowHome, ".update-check.json"), "utf-8")).toContain("\"latestVersion\":\"9.9.9\"");
  });
});
