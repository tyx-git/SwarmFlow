/**
 * Release tarball naming + install path conventions per platform.
 *
 * Used by build scripts, the install.sh script, and the update
 * checker so they all agree on what file lives at what URL.
 */

import type { BinaryAssetProvider } from "../types.js";
import { currentPlatform, type SupportedPlatform } from "../detect.js";

function archLabel(arch: string = process.arch): string {
  return arch === "x64" ? "x64" : arch;
}

export function binaryAssetForPlatform(
  platform: SupportedPlatform,
  arch: string = process.arch,
): BinaryAssetProvider {
  const suffix = archLabel(arch);
  switch (platform) {
    case "darwin":
      return {
        tarballName: `swarmflow-darwin-${suffix}.tar.gz`,
        executableName: "swarmflow",
        needsQuarantineRemoval: true,
      };
    case "linux":
      return {
        tarballName: `swarmflow-linux-${suffix}.tar.gz`,
        executableName: "swarmflow",
        needsQuarantineRemoval: false,
      };
    case "win32":
      return {
        tarballName: `swarmflow-win32-${suffix}.tar.gz`,
        executableName: "swarmflow.exe",
        needsQuarantineRemoval: false,
      };
  }
}

export function selectBinaryAsset(): BinaryAssetProvider {
  return binaryAssetForPlatform(currentPlatform());
}
