import { existsSync, renameSync, rmSync } from "node:fs";

/**
 * 轮转有上限的文件历史：`path` -> `path.1`，旧文件依次后移，
 * 最旧的归档被丢弃。没有可轮转的文件或文件系统操作失败时
 * 返回 false。
 */
export function rotateLogFile(path: string, keep: number): boolean {
  if (!existsSync(path)) return false;
  try {
    rmSync(`${path}.${keep}`, { force: true });
    for (let index = keep - 1; index >= 1; index -= 1) {
      const from = `${path}.${index}`;
      if (existsSync(from)) renameSync(from, `${path}.${index + 1}`);
    }
    renameSync(path, `${path}.1`);
    return true;
  } catch {
    return false;
  }
}
