/**
 * Shell-aware prompt fragments.
 *
 * Generates context notes injected into the system prompt so the model
 * knows which shell it is driving and adjusts its syntax accordingly.
 */

import type { ShellKind } from "../platform/types.js";

/**
 * Build shell notes for the {SHELL_NOTES} template variable in tools.md.
 * For bash/sh this is empty (default assumption). For PowerShell variants
 * it explains the syntax differences the model must respect.
 */
export function buildShellNotes(kind: ShellKind): string {
  if (kind === "bash" || kind === "sh") {
    return "> **Shell: bash** 鈥?all `bash` tool commands run through bash.";
  }

  const edition = kind === "pwsh" ? "PowerShell 7+" : "Windows PowerShell 5.1";
  const chainNote = kind === "pwsh"
    ? "You can chain dependent commands with `&&` (supported in pwsh 7+), or use `cmd1; if ($?) { cmd2 }`."
    : "Chain dependent commands with `cmd1; if ($?) { cmd2 }` 鈥?Windows PowerShell 5.1 does **NOT** support `&&`.";

  return [
    `> **Shell: ${edition}** 鈥?all \`bash\` tool commands run through PowerShell, not bash. Write PowerShell syntax.`,
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
