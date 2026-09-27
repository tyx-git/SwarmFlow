import { existsSync, renameSync, rmSync } from "node:fs";

/**
 * Rotate a bounded file history: `path` -> `path.1`, older files move up,
 * and the oldest archive is discarded. Returns false when there was no file
 * to rotate or the filesystem operation failed.
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
