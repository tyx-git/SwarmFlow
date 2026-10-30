/** read_file 执行器：按行窗口读取文本、图片与投影文档，处理敏感文件、大小与字符上限。 */

import fs from "node:fs/promises";
import { existsSync, statSync, readFileSync } from "node:fs";

import path from "node:path";

import { shell } from "../platform/index.js";

import { ToolResult } from "../providers/response.js";

import { safePath } from "../security/path.js";
import { getSensitiveFileReadReason } from "../security/sensitive-files.js";

import { isProjectedDocumentPath, loadProjectedDocumentView, projectedDocumentLabel } from "../context/document/view.js";
import { classifyFile, IMAGE_MEDIA_TYPES } from "../attachments/file-kinds.js";
import { readLineWindowFromFile, readLineWindowFromText, type LineWindowResult } from "../lib/line-window.js";

import { truncateLine } from "./output-truncation.js";

import {
  READ_MAX_IMAGE_SIZE,
  FILE_CONTENT_MAX_BYTES,
  READ_MAX_LINES,
  READ_MAX_LINE_CHARS,
  READ_LINE_CHARS_FLOOR,
  READ_LINE_CHARS_CEILING,
  READ_MAX_CHARS,
} from "./limits.js";
import { fileTooLargeMessage } from "./file-version.js";

export async function toolReadFile(
  filePath: string,
  startLine?: number,
  endLine?: number,
  artifactsDir?: string,
  supportsMultimodal?: boolean,
  maxLineChars?: number,
  tailLines?: number,
): Promise<string | ToolResult> {
  const sensitiveReason = getSensitiveFileReadReason(filePath);
  if (sensitiveReason) {
    return `ERROR: Access to sensitive file is blocked by default: ${filePath} (${sensitiveReason}).`;
  }

  if (!existsSync(filePath)) {
    return `ERROR: File not found: ${filePath}`;
  }

  let stat;
  try {
    stat = statSync(filePath);
  } catch (e) {
    return `ERROR: ${e instanceof Error ? e.message : String(e)}`;
  }

  if (!stat.isFile()) {
    return `ERROR: Not a file: ${filePath}`;
  }

  // --- 图片文件处理 ---
  const [isImage] = classifyFile(filePath);
  if (isImage) {
    if (!supportsMultimodal) {
      return `ERROR: Cannot read image file: current model does not support multimodal input. File: ${filePath}`;
    }
    if (stat.size > READ_MAX_IMAGE_SIZE) {
      const sizeMB = (stat.size / 1024 / 1024).toFixed(1);
      return `ERROR: Image too large (${sizeMB} MB, limit ${READ_MAX_IMAGE_SIZE / 1024 / 1024} MB).`;
    }
    const ext = path.extname(filePath).toLowerCase();
    const mediaType = IMAGE_MEDIA_TYPES[ext] ?? "application/octet-stream";
    try {
      const raw = readFileSync(filePath);
      const b64Data = raw.toString("base64");
      const sizeFmt = stat.size < 1024
        ? `${stat.size} B`
        : stat.size < 1024 * 1024
          ? `${(stat.size / 1024).toFixed(1)} KB`
          : `${(stat.size / (1024 * 1024)).toFixed(1)} MB`;
      const description = `[Image: ${path.basename(filePath)} | ${mediaType} | ${sizeFmt}]`;
      return new ToolResult({
        content: description,
        contentBlocks: [
          { type: "text", text: description },
          {
            type: "image",
            source: {
              type: "base64",
              media_type: mediaType,
              data: b64Data,
            },
          },
        ],
      });
    } catch (e) {
      return `ERROR: Failed to read image: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  if (stat.size > FILE_CONTENT_MAX_BYTES) {
    return fileTooLargeMessage(stat.size);
  }

  const isProjectedDocument = isProjectedDocumentPath(filePath);

  let mtimeMs = Math.trunc(stat.mtimeMs);
  let sizeBytes = stat.size;
  let headerPrefix = "";
  let window: LineWindowResult;
  try {
    if (isProjectedDocument) {
      const view = await loadProjectedDocumentView(filePath, artifactsDir);
      mtimeMs = view.mtimeMs;
      sizeBytes = view.sizeBytes;
      headerPrefix =
        `[Auto-extracted Markdown view of ${path.basename(filePath)} (${projectedDocumentLabel(filePath)} source) | ` +
        `original_path=${filePath}]` + "\n";
      window = await readLineWindowFromText(view.text, {
        startLine,
        endLine,
        tailLines,
        maxLines: READ_MAX_LINES,
      });
    } else {
      window = await readLineWindowFromFile(filePath, {
        startLine,
        endLine,
        tailLines,
        maxLines: READ_MAX_LINES,
      });
    }
  } catch (e) {
    return `ERROR: ${e instanceof Error ? e.message : String(e)}`;
  }

  const total = window.totalLines;
  const start = window.start;
  let end = window.end;
  let selected = window.lines;
  // 熔断提示统一在结果末尾追加，保证它始终是最后一段可操作指引。
  let fuseNotice = "";
  if (window.tailCapped) {
    fuseNotice =
      `<--- This file has more than ${READ_MAX_LINES} lines; showing the latest ${READ_MAX_LINES} lines. ` +
      `Request a smaller \`tail_lines\`, or omit it and page with \`start_line\` if needed. --->`;
  }

  // 对压缩成一行的超长行做逐行截断。上限可按调用覆盖，
  // 被截断的长行能在工具内重新读全，不必绕道 shell 管道。
  const lineCap = Math.min(
    Math.max(maxLineChars ?? READ_MAX_LINE_CHARS, READ_LINE_CHARS_FLOOR),
    READ_LINE_CHARS_CEILING,
  );
  let lineTrimCount = 0;
  let longestLineChars = 0;
  selected = selected.map((line) => {
    if (line.length > lineCap) {
      lineTrimCount += 1;
      longestLineChars = Math.max(longestLineChars, line.length);
      return truncateLine(line, lineCap);
    }
    return line;
  });

  // 应用字符上限（按行截断后的字符数计算）
  let charCount = 0;
  let truncatedAtLine: number | null = null;
  for (let i = 0; i < selected.length; i++) {
    charCount += selected[i].length + 1; // +1 是新行符
    if (charCount > READ_MAX_CHARS) {
      selected = selected.slice(0, i);
      truncatedAtLine = start + i; // 从 1 开始计数、超限的那一行
      end = start + i - 1; // 最后一行完整的行
      break;
    }
  }

  // 行熔断只对普通读取生效；tail_lines 的提示已在上面的分支生成。
  if (window.lineCapApplied) {
    fuseNotice =
      `<--- This file has more than ${READ_MAX_LINES} lines. ` +
      `Continue with \`start_line=${end + 1}\` if you need the following lines. --->`;
  }

  let result =
    headerPrefix +
    `[Lines ${start}-${end} of ${total} | mtime_ms=${mtimeMs} | size_bytes=${sizeBytes}]\n` +
    selected.join("\n");

  if (truncatedAtLine !== null) {
    // tail_lines 会覆盖 start_line，因此不能用同一句提示；需要明确让模型
    // 先去掉 tail_lines 再翻页。
    const continueHint = tailLines != null
      ? `Request a smaller tail_lines, or omit tail_lines and use start_line=${end + 1}` +
        (isProjectedDocument ? " to read the extracted Markdown view" : "")
      : `Use start_line=${end + 1} to continue reading` +
        (isProjectedDocument ? " the extracted Markdown view of the same source path" : "");
    result +=
      `\n\n[WARNING: Reached ${READ_MAX_CHARS.toLocaleString()} character limit at line ` +
      `${truncatedAtLine}. Showing lines ${start}-${end} ` +
      `(${end - start + 1} complete lines). ${continueHint}.]`;
  }

  if (lineTrimCount > 0) {
    const plural = lineTrimCount === 1 ? "" : "s";
    const wasWere = lineTrimCount === 1 ? "was" : "were";
    if (longestLineChars <= READ_LINE_CHARS_CEILING) {
      // 工具内可恢复：用更大的上限重读即可看到整行。
      result +=
        `\n\n[Note: ${lineTrimCount} line${plural} exceeded ${lineCap} chars and ${wasWere} truncated ` +
        `(longest is ${longestLineChars} chars). ` +
        `Re-read with max_line_chars=${longestLineChars} to see ${lineTrimCount === 1 ? "it" : "them"} in full; ` +
        `the ${READ_MAX_CHARS.toLocaleString()}-character per-call budget still applies.]`;
    } else {
      // 这种长度的行根本装不进单次调用的字符预算，只能把模型引到只读的
      // shell 逃生口。命令与引号写法取决于解析到的 shell——PowerShell 没有
      // head/tail/cut，单引号转义也不同——所以要按 shell 生成对应提示。
      // 路径用完整绝对路径，模型在任何工作目录下都能原样粘贴。
      const isPwsh = shell.kind === "pwsh" || shell.kind === "powershell";
      let escapeHatch: string;
      if (isPwsh) {
        const psPath = filePath.replace(/'/g, "''");
        // @(...) 强制成数组，单行或压缩文件也一样——否则 Get-Content 返回裸字符串，
        // 索引得到 [char]，.Substring 就会抛错。这种窗口式写法不在
        // 预批准的只读清单里（不像下面的 bash 管道），
        // 因此可能弹出审批提示。
        escapeHatch =
          `run \`@(Get-Content '${psPath}')[LINE_NUM - 1].Substring(START_INDEX, LENGTH)\` ` +
          `(START_INDEX is 0-based; may prompt for approval).`;
      } else {
        const safePath = filePath.replace(/'/g, "'\\''");
        escapeHatch =
          `use bash: \`head -n LINE_NUM '${safePath}' | tail -n 1 | cut -c FROM-TO\` ` +
          `(head/tail/cut are pre-approved, no permission prompt).`;
      }
      result +=
        `\n\n[Note: ${lineTrimCount} line${plural} exceeded ${lineCap} chars and ${wasWere} truncated ` +
        `(longest is ${longestLineChars} chars —too long for the ${READ_MAX_CHARS.toLocaleString()}-character per-call budget). ` +
        `To read a slice of a specific long line, ${escapeHatch}]`;
    }
  }

  // 熔断提示放在所有警告/行截断说明之后，确保它是最后一段可操作指引。
  if (fuseNotice) result += `\n\n${fuseNotice}`;

  return result;
}

// ------------------------------------------------------------------
// list_dir
// ------------------------------------------------------------------
