/**
 * rewind 崩溃恢复产物的命名与生命周期。
 *
 * journal 与其 `.data-*` 备份目录的规则只在这里定义；server 层只传 artifacts 目录，
 * 不自己拼文件名。
 */

import { existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

export const REWIND_JOURNAL_FILENAME = "rewind-journal.json";
const BACKUP_SUFFIX_PREFIX = ".data-";

export function rewindJournalPath(artifactsDir: string): string {
  return join(artifactsDir, REWIND_JOURNAL_FILENAME);
}

export function rewindJournalBackupDir(journalPath: string, id: string): string {
  return `${journalPath}${BACKUP_SUFFIX_PREFIX}${id}`;
}

/** `name` 是否为 journal 的备份目录/文件（只看 basename）。 */
export function isRewindJournalBackupName(name: string): boolean {
  return name.startsWith(`${REWIND_JOURNAL_FILENAME}${BACKUP_SUFFIX_PREFIX}`);
}

/** fork 等场景：丢弃继承来的 journal 与 `.data-*`；best effort，不抛错。 */
export function discardRewindArtifacts(artifactsDir: string): void {
  try {
    rmSync(rewindJournalPath(artifactsDir), { force: true });
  } catch {
    // best effort
  }
  if (!existsSync(artifactsDir)) return;
  let names: string[];
  try {
    names = readdirSync(artifactsDir);
  } catch {
    return;
  }
  for (const name of names) {
    if (!isRewindJournalBackupName(name)) continue;
    try {
      rmSync(join(artifactsDir, name), { recursive: true, force: true });
    } catch {
      // best effort
    }
  }
}
