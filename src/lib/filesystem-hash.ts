import { lstatSync, readFileSync, readlinkSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";

/** 对文件、目录树或符号链接计算稳定哈希，且不跟随符号链接。 */
export function hashFilesystemPath(path: string): string {
  const hash = createHash("sha256");

  const visit = (currentPath: string, relativePath: string): void => {
    const stat = lstatSync(currentPath);
    if (stat.isSymbolicLink()) {
      hash.update(`link\0${relativePath}\0${readlinkSync(currentPath)}\0`);
      return;
    }
    if (stat.isFile()) {
      hash.update(`file\0${relativePath}\0${stat.mode & 0o7777}\0`);
      hash.update(readFileSync(currentPath));
      return;
    }
    if (!stat.isDirectory()) {
      throw new Error(`Unsupported filesystem entry in mutation snapshot: ${currentPath}`);
    }

    hash.update(`directory\0${relativePath}\0${stat.mode & 0o7777}\0`);
    for (const name of readdirSync(currentPath).sort()) {
      visit(join(currentPath, name), relativePath ? `${relativePath}/${name}` : name);
    }
  };

  visit(path, "");
  return hash.digest("hex");
}
