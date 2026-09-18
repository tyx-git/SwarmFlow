/**
 * Shell 感知的提示片段。
 *
 * 生成注入到系统提示中的上下文注释，
 * 以便模型知道它正在驱动哪个 shell 并相应地调整其语法。
 */

import type { ShellKind } from "../platform/types.js";

/**
 * 为 tools.md 中的 {SHELL_NOTES} 模板变量构建 shell 注释。
 * 对于 bash/sh，这是空的（默认假设）。对于 PowerShell 变体，
 * 它解释模型必须遵守的语法差异。
 */
export function buildShellNotes(kind: ShellKind): string {
  if (kind === "bash" || kind === "sh") {
    return "> **Shell: bash** —all `bash` tool commands run through bash.";
  }

  const edition = kind === "pwsh" ? "PowerShell 7+" : "Windows PowerShell 5.1";
  const chainNote = kind === "pwsh"
    ? "You can chain dependent commands with `&&` (supported in pwsh 7+), or use `cmd1; if ($?) { cmd2 }`."
    : "Chain dependent commands with `cmd1; if ($?) { cmd2 }` —Windows PowerShell 5.1 does **NOT** support `&&`.";

  return [
    `> **Shell: ${edition}** —all \`bash\` tool commands run through PowerShell, not bash. Write PowerShell syntax.`,
    "",
    "**PowerShell syntax reminders:**",
    "- Use full cmdlet names: `Get-ChildItem`, `Set-Content`, `Remove-Item`, `New-Item`, `Test-Path`.",
    "- Environment variables: `$env:VAR` or `${env:VAR}` (not `$VAR`).",
    "- Use double quotes for interpolation (`\"Hello $name\"`), single quotes for verbatim strings.",
    "- Call native executables with spaces via the call operator: `& \"path/to/exe\" args`.",
    "- Escape special characters with the backtick (`` ` ``) character.",
    `- ${chainNote}`,
    "- Use the `cwd` parameter instead of `Set-Location`.",
  ].join("\n");
}
