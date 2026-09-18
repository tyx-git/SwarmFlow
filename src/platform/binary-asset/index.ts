/**
 * 每个平台的发布 tarball 命名 + 安装路径约定。
 *
 * 被构建脚本、install.sh 脚本和更新检查器使用，
 * 以便它们都同意什么文件位于什么 URL。
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
