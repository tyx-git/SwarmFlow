import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * 守护"保留详细日志记录"的三条契约：
 *   1. 诊断日志默认落在 ~/.swarmflow/（和 stderr.log 同目录，排查只翻一个地方）
 *   2. 每次启动归档上一次的诊断日志，而不是清空证据
 *   3. stderr.log 追加写入并带运行分隔，超限轮转
 */
describe("诊断日志保留策略", () => {
  it("opentui 诊断默认路径在 ~/.swarmflow 下", () => {
    const source = readFileSync("external/opentui/forked/core/lib/diagnostic.ts", "utf8");
    // 不能再是 POSIX 的 /tmp/...
    expect(source).not.toContain('default: "/tmp/opentui-diag.jsonl"');
    expect(source).toContain('join(homedir(), ".swarmflow", "opentui-diag.jsonl")');
  });

  it("启动时归档上一次诊断日志而不是清空", () => {
    const source = readFileSync("external/opentui/forked/core/lib/diagnostic.ts", "utf8");
    expect(source).toContain("rotateLogFile");
    expect(source).toContain("DIAG_ARCHIVE_KEEP");
    // reset 里必须先归档再重建
    const resetIdx = source.indexOf("export function resetOpenTuiDiagLog");
    const archiveCallIdx = source.indexOf("rotateLogFile(path, DIAG_ARCHIVE_KEEP)");
    const writeFileIdx = source.indexOf('writeFileSync(path, "", "utf8")', resetIdx);
    expect(archiveCallIdx).toBeGreaterThan(resetIdx);
    expect(archiveCallIdx).toBeLessThan(writeFileIdx);
  });

  it("stderr.log 追加写入、带运行分隔、超限轮转", () => {
    const source = readFileSync("external/opentui/main.tsx", "utf8");
    expect(source).toContain('openSync(stderrLogPath, "a")');
    expect(source).toContain("===== run ");
    expect(source).toContain("rotateLogFile(stderrLogPath, 3)");
    // 不能再出现按 "w" 截断 stderr.log
    expect(source).not.toContain('openSync(join(stderrLogDir, "stderr.log"), "w")');
  });

  it("settings.diagnostics 可以在不设环境变量的情况下开启诊断", () => {
    const settings = readFileSync("src/config/settings/types.ts", "utf8");
    expect(settings).toContain("diagnostics?: boolean;");

    const cli = readFileSync("src/cli.ts", "utf8");
    expect(cli).toContain("globalSettings.diagnostics === true");
    expect(cli).toContain('process.env.OPENTUI_DIAG = "1"');
  });
});
