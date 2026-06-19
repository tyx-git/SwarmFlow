/**
 * 文件附件支持@filename引用。
 * 
 * 解析用户输入中的“@path/to/file”引用，读取并总结文件内容，
 * 并将其呈现为“<context label=" user Files“> ”块，
 * 以便注入到Talker消息中。
 * Usage:
 *
 *   import { process } from "./lib/file-attach.js";
 *
 *   const result = process("Review @src/main.ts and fix bugs");
 *   // result.cleanedText  -> "Review and fix bugs"
 *   // result.contextStr   -> '<context label="User Files">...</context>'
 *   // result.files         -> [FileInfo, ...]
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

import { context } from "../primitives/context.js";
import { SafePathError, safePath, toPosixPath } from "../security/path.js";
import { getSensitiveFileReadReason } from "../security/sensitive-files.js";
import {
  isProjectedDocumentPath,
  loadProjectedDocumentView,
  projectedDocumentLabel,
} from "../context/document-projection.js";
import { EXCLUDE_DIRS } from "../tools/shared.js";

// ------------------------------------------------------------------
// Constants
// ------------------------------------------------------------------

const PREVIEW_CHAR_LIMIT = 5000;
const CODE_LINE_LIMIT = 50;
const MAX_TEXT_FILE_SIZE = 50 * 1024 * 1024; // 50 MB
const MAX_IMAGE_FILE_SIZE = 50 * 1024 * 1024; // 50 MB

const CODE_EXTENSIONS = new Set([
  ".py", ".js", ".ts", ".jsx", ".tsx", ".java", ".c", ".cpp", ".cc",
  ".h", ".hpp", ".cs", ".go", ".rs", ".rb", ".swift", ".kt", ".kts",
  ".scala", ".lua", ".php", ".sh", ".bash", ".zsh", ".pl", ".r",
  ".m", ".mm", ".zig", ".v", ".nim", ".dart", ".ex", ".exs",
  ".hs", ".ml", ".mli", ".clj", ".lisp", ".el",
]);

const IMAGE_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".webp", ".svg", ".ico", ".tiff",
]);

const BINARY_EXTENSIONS = new Set([
  ".zip", ".tar", ".gz", ".bz2", ".7z", ".rar",
  ".exe", ".dll", ".so", ".dylib",
  ".bin", ".dat", ".iso",
  ".mp3", ".mp4", ".wav", ".avi", ".mov", ".mkv", ".flac",
  ".o", ".pyc", ".class", ".wasm",
]);

// Regex: @ must be at start-of-string or preceded by whitespace.
const AT_PATTERN =
  /(?:^|(?<=\s))@(?:"([^"]+)"|'([^']+)'|(\S+))/g;

export const IMAGE_MEDIA_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".bmp": "image/bmp",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".tiff": "image/tiff",
};

// 使用统一的排除列表，如文件附加自动完成，glob, grep，
// 和list_dir都共享“默认跳过”的概念。
const SCAN_EXCLUDE_DIRS = EXCLUDE_DIRS;

// ------------------------------------------------------------------
// 文件扫描自动完成
// ------------------------------------------------------------------

/**
 * 扫描‘ cwd ’查找匹配‘ prefix ’的文件，
 * 返回相对路径字符串。
 * —空前缀：只列出顶层文件（不递归）。
 * -非空前缀：递归扫描到‘ maxDepth ’，
 * 匹配以前缀开头的路径。—跳过‘ SCAN_EXCLUDE_DIRS ’中的目录。
 * -结果排序的路径长度（最短的第一），上限为‘ maxResults ’。
 */
export function scanCandidates(
  prefix: string,
  cwd?: string,
  maxResults = 20,
  maxDepth = 3,
): string[] {
  const base = cwd ?? process.cwd();
  const matches: string[] = [];

  if (!prefix) {
    // Top-level entries only
    try {
      const entries = readdirSync(base).sort();
      for (const name of entries) {
        if (name.startsWith(".") || SCAN_EXCLUDE_DIRS.has(name)) continue;
        const full = path.join(base, name);
        let isDir = false;
        try {
          isDir = statSync(full).isDirectory();
        } catch {
          // skip
        }
        matches.push(name + (isDir ? "/" : ""));
        if (matches.length >= maxResults) break;
      }
    } catch {
      // ignore
    }
    return matches;
  }

  const prefixLower = prefix.toLowerCase();

  function walk(directory: string, depth: number): void {
    if (depth > maxDepth || matches.length >= maxResults) return;
    let entries: string[];
    try {
      entries = readdirSync(directory).sort();
    } catch {
      return;
    }

    for (const name of entries) {
      if (SCAN_EXCLUDE_DIRS.has(name) || name.startsWith(".")) continue;
      const full = path.join(directory, name);
      // 路径。相对返回操作系统本地分隔符（反斜杠）
      //  Windows);用户的@-query和下面使用的目录后缀
      // 正斜杠，因此规范化或嵌套路径完成中断
      // 在Windows上（候选人从不以键入的前缀开始）。
      const rel = toPosixPath(path.relative(base, full));
      const relLower = rel.toLowerCase();

      let isDir = false;
      try {
        isDir = statSync(full).isDirectory();
      } catch {
        continue;
      }

      if (isDir) {
        const relDir = rel + "/";
        const relDirLower = relLower + "/";
        if (
          relDirLower.startsWith(prefixLower) ||
          prefixLower.startsWith(relDirLower)
        ) {
          if (relDirLower.startsWith(prefixLower)) {
            matches.push(relDir);
          }
          walk(full, depth + 1);
        }
      } else {
        if (relLower.startsWith(prefixLower)) {
          matches.push(rel);
        }
      }
      if (matches.length >= maxResults) return;
    }
  }

  walk(base, 1);
  matches.sort((a, b) => a.length - b.length);
  return matches.slice(0, maxResults);
}

// ------------------------------------------------------------------
// Data structures
// ------------------------------------------------------------------

/* 单个附加文件的元数据和内容。 */
export interface FileInfo {
  originalRef: string; // raw @reference from user input
  path: string; // resolved absolute path
  exists: boolean;
  isImage: boolean;
  isBinary: boolean;
  projectedDocumentType: string | null;
  sizeBytes: number;
  charCount: number;
  lineCount: number;
  content: string; // full content or preview
  isPreview: boolean;
  isCode: boolean;
  error: string;
  imageData: string | null; // base64-encoded image (multimodal)
  imageMediaType: string | null; // MIME type for image
}

function makeFileInfo(partial: Partial<FileInfo> & { originalRef: string; path: string }): FileInfo {
  return {
    exists: false,
    isImage: false,
    isBinary: false,
    projectedDocumentType: null,
    sizeBytes: 0,
    charCount: 0,
    lineCount: 0,
    content: "",
    isPreview: false,
    isCode: false,
    error: "",
    imageData: null,
    imageMediaType: null,
    ...partial,
  };
}

function summarizeTextContent(
  text: string,
  filePath: string,
): Pick<FileInfo, "charCount" | "lineCount" | "content" | "isPreview" | "isCode"> {
  const charCount = text.length;
  const lineCount = text === ""
    ? 0
    : text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
  const ext = path.extname(filePath).toLowerCase();
  const isCode = CODE_EXTENSIONS.has(ext);

  let content: string;
  let isPreview: boolean;

  if (isCode) {
    const lines = text.split("\n");
    isPreview = lines.length > CODE_LINE_LIMIT;
    content = isPreview ? lines.slice(0, CODE_LINE_LIMIT).join("\n") : text;
  } else {
    isPreview = charCount > PREVIEW_CHAR_LIMIT;
    content = isPreview ? text.slice(0, PREVIEW_CHAR_LIMIT) : text;
  }

  return {
    charCount,
    lineCount,
    content,
    isPreview,
    isCode,
  };
}

/* 处理用户输入中的@file引用的结果。 */
export interface FileAttachResult {
  cleanedText: string; // user message with @refs removed
  contextStr: string; // rendered <context> block (empty if no files)
  files: FileInfo[];
  warnings: string[];
}

/* 是否附加了任何文件。 */
export function hasFiles(result: FileAttachResult): boolean {
  return result.files.length > 0;
}

/* 是否任何附加文件有base64图像数据的多模态。 */
export function hasImages(result: FileAttachResult): boolean {
  return result.files.some((f) => f.imageData !== null);
}

// ------------------------------------------------------------------
// Core functions
// ------------------------------------------------------------------

/**
 * 提取@path引用并返回[cleanedText， paths]。
 * 不匹配类似电子邮件的模式（user@example.com），
 * 因为regex要求@前面有空格或行开始。
 */
export function parseReferences(text: string): [string, string[]] {
  const paths: string[] = [];

  const cleaned = text.replace(AT_PATTERN, (_, g1, g2, g3) => {
    const raw = g1 ?? g2 ?? g3;
    paths.push(raw);
    return "";
  });

  // 折叠被删除的引用留下的空白
  const normalized = cleaned.replace(/ {2,}/g, " ").trim();
  return [normalized, paths];
}

/**
 *  将原始路径字符串解析为绝对路径。
 */
export function resolvePath(raw: string, cwd?: string): string {
  if (path.isAbsolute(raw)) return raw;
  const base = cwd ?? process.cwd();
  return path.resolve(base, raw);
}

/**
 * 按扩展名对文件进行分类。
 * 返回‘ [isImage, isBinary, projectedDocumentType] ’。
 */
export function classifyFile(
  filePath: string,
): [boolean, boolean, string | null] {
  const ext = path.extname(filePath).toLowerCase();
  const isImage = IMAGE_EXTENSIONS.has(ext);
  const projectedDocumentType = isProjectedDocumentPath(filePath) ? ext.slice(1).toLowerCase() : null;
  const isBinary = isImage || projectedDocumentType !== null || BINARY_EXTENSIONS.has(ext);
  return [isImage, isBinary, projectedDocumentType];
}

/**
 * 读取文件并生成包含内容/摘要的FileInfo。
 */
export async function readAndSummarize(
  filePath: string,
  isImage = false,
  isBinary = false,
  projectedDocumentType: string | null = null,
  supportsMultimodal = false,
  artifactsDir?: string,
): Promise<FileInfo> {
  const ref = filePath;

  if (!existsSync(filePath)) {
    return makeFileInfo({
      originalRef: ref,
      path: filePath,
      exists: false,
      error: "File not found.",
    });
  }

  let stat;
  try {
    stat = statSync(filePath);
  } catch (e) {
    return makeFileInfo({
      originalRef: ref,
      path: filePath,
      exists: false,
      error: `Stat error: ${e instanceof Error ? e.message : String(e)}`,
    });
  }
  const size = stat.size;

  // --- Image ---
  if (isImage) {
    if (size > MAX_IMAGE_FILE_SIZE) {
      return makeFileInfo({
        originalRef: ref,
        path: filePath,
        exists: true,
        isImage: true,
        isBinary: true,
        sizeBytes: size,
        error: `Image too large (${(size / 1024 / 1024).toFixed(1)} MB, limit ${MAX_IMAGE_FILE_SIZE / 1024 / 1024} MB).`,
      });
    }

    if (supportsMultimodal) {
      try {
        const raw = readFileSync(filePath);
        const b64Data = raw.toString("base64");
        const ext = path.extname(filePath).toLowerCase();
        const mediaType = IMAGE_MEDIA_TYPES[ext] ?? "application/octet-stream";
        return makeFileInfo({
          originalRef: ref,
          path: filePath,
          exists: true,
          isImage: true,
          isBinary: true,
          sizeBytes: size,
          content: "Image file attached.",
          imageData: b64Data,
          imageMediaType: mediaType,
        });
      } catch (exc) {
        return makeFileInfo({
          originalRef: ref,
          path: filePath,
          exists: true,
          isImage: true,
          isBinary: true,
          sizeBytes: size,
          content: `Image read error: ${exc instanceof Error ? exc.message : String(exc)}`,
        });
      }
    }

    return makeFileInfo({
      originalRef: ref,
      path: filePath,
      exists: true,
      isImage: true,
      isBinary: true,
      sizeBytes: size,
      content: "Current model does not support image input.",
    });
  }

  // --- PDF ---
  if (projectedDocumentType) {
    try {
      const view = await loadProjectedDocumentView(filePath, artifactsDir);

      return makeFileInfo({
        originalRef: ref,
        path: filePath,
        exists: true,
        isBinary: true,
        projectedDocumentType,
        sizeBytes: size,
        ...summarizeTextContent(view.text, `${filePath}.md`),
      });
    } catch (exc) {
      return makeFileInfo({
        originalRef: ref,
        path: filePath,
        exists: true,
        isBinary: true,
        projectedDocumentType,
        sizeBytes: size,
        error: `${projectedDocumentLabel(filePath)} conversion failed: ${exc instanceof Error ? exc.message : String(exc)}`,
      });
    }
  }

  // ——其他二进制——
  if (isBinary) {
    return makeFileInfo({
      originalRef: ref,
      path: filePath,
      exists: true,
      isBinary: true,
      sizeBytes: size,
      content: "Binary file — path provided for reference.",
    });
  }

  // ——文本文件——
  if (size > MAX_TEXT_FILE_SIZE) {
    return makeFileInfo({
      originalRef: ref,
      path: filePath,
      exists: true,
      sizeBytes: size,
      error: `File too large (${(size / 1024 / 1024).toFixed(1)} MB, limit ${MAX_TEXT_FILE_SIZE / 1024 / 1024} MB).`,
    });
  }

  let text: string;
  try {
    text = readFileSync(filePath, { encoding: "utf-8" });
  } catch (exc) {
    return makeFileInfo({
      originalRef: ref,
      path: filePath,
      exists: true,
      error: `Read error: ${exc instanceof Error ? exc.message : String(exc)}`,
    });
  }

  return makeFileInfo({
    originalRef: ref,
    path: filePath,
    exists: true,
    sizeBytes: size,
    ...summarizeTextContent(text, filePath),
  });
}

/**
 * 将FileInfo列表格式化为编号的文本条目。
 */
export function formatContextBlock(files: FileInfo[]): string {
  const entries: string[] = [];

  for (let idx = 0; idx < files.length; idx++) {
    const fi = files[idx];
    const num = idx + 1;

    if (!fi.exists) {
      entries.push(
        `[${num}] ${fi.path}\n\u26a0 ${fi.error || "File not found."}`,
      );
      continue;
    }

    if (fi.error) {
      entries.push(`[${num}] ${fi.path}\n\u26a0 ${fi.error}`);
      continue;
    }

    const sizeMB = (fi.sizeBytes / (1024 * 1024)).toFixed(1);

    if (fi.isImage) {
      entries.push(
        `[${num}] ${fi.path} (image, ${sizeMB} MB)\n${fi.content}`,
      );
    } else if (fi.projectedDocumentType) {
      const docLabel = fi.projectedDocumentType.toUpperCase();
      if (fi.isPreview) {
        const shown = Math.min(PREVIEW_CHAR_LIMIT, fi.charCount);
        const pct = fi.charCount
          ? Math.round((shown / fi.charCount) * 100)
          : 0;
        const previewLines = fi.content.split("\n").length;
        const continueHint =
          `\nUse read_file on the original path (${fi.path}) with start_line=${previewLines + 1} to continue reading.`;
        entries.push(
          `[${num}] ${fi.path} (${docLabel}, ${sizeMB} MB; auto-extracted Markdown view, ${fi.charCount} chars, ${fi.lineCount} lines)\n` +
            `Preview (first ${shown}/${fi.charCount} chars(${pct}%), through line ${previewLines} of ${fi.lineCount}):\n${fi.content}\n...${continueHint}`,
        );
      } else {
        entries.push(
          `[${num}] ${fi.path} (${docLabel}, ${sizeMB} MB; auto-extracted Markdown view, ${fi.charCount} chars, ${fi.lineCount} lines)\n` +
            `Full extracted content:\n${fi.content}`,
        );
      }
    } else if (fi.isBinary) {
      entries.push(
        `[${num}] ${fi.path} (binary, ${sizeMB} MB)\n${fi.content}`,
      );
    } else if (fi.isPreview) {
      let hint: string;
      const previewLines = fi.content.split("\n").length;
      if (fi.isCode) {
        const shown = Math.min(CODE_LINE_LIMIT, fi.lineCount);
        const pct = fi.lineCount
          ? Math.round((shown / fi.lineCount) * 100)
          : 0;
        hint = `first ${shown}/${fi.lineCount} lines(${pct}%), through line ${previewLines} of ${fi.lineCount}. Use read_file with start_line=${previewLines + 1} to continue.`;
      } else {
        const shown = Math.min(PREVIEW_CHAR_LIMIT, fi.charCount);
        const pct = fi.charCount
          ? Math.round((shown / fi.charCount) * 100)
          : 0;
        hint = `first ${shown}/${fi.charCount} chars(${pct}%), through line ${previewLines} of ${fi.lineCount}. Use read_file with start_line=${previewLines + 1} to continue.`;
      }
      entries.push(
        `[${num}] ${fi.path} (${fi.charCount} chars, ${fi.lineCount} lines)\n` +
          `Preview (${hint}):\n${fi.content}\n...`,
      );
    } else {
      entries.push(
        `[${num}] ${fi.path} (${fi.charCount} chars, ${fi.lineCount} lines)\n` +
          `Full content:\n${fi.content}`,
      );
    }
  }

  return entries.join("\n\n");
}

// ------------------------------------------------------------------
// 主入口
// ------------------------------------------------------------------

/**
 * 处理用户输入中的“@file”引用。
 * 这是主要的入口。它解析引用、读取文件，
 * 并返回一个FileAttachResult，
 * 其中包含清理过的文本和呈现的“<context>”块。
 */
export async function processFileAttachments(
  userInput: string,
  cwd?: string,
  supportsMultimodal = false,
  baseDir?: string,
  allowedExternalBaseDirs?: string[],
  artifactsDir?: string,
): Promise<FileAttachResult> {
  const [cleanedText, paths] = parseReferences(userInput);

  if (paths.length === 0) {
    return {
      cleanedText,
      contextStr: "",
      files: [],
      warnings: [],
    };
  }

  const warnings: string[] = [];
  const files: FileInfo[] = [];
  const seenPaths = new Set<string>();
  const allowedBase = path.resolve(baseDir ?? cwd ?? process.cwd());
  const extraBases = (allowedExternalBaseDirs ?? []).map((p) => path.resolve(p));

  for (const raw of paths) {
    let absPath = "";
    try {
      absPath = safePath({
        baseDir: allowedBase,
        requestedPath: raw,
        cwd: cwd ?? allowedBase,
        mustExist: true,
        expectFile: true,
        accessKind: "attach",
      }).safePath!;
    } catch (e) {
      let matchedExternal = "";
      if (e instanceof SafePathError &&
          (e.code === "PATH_OUTSIDE_SCOPE" || e.code === "PATH_SYMLINK_ESCAPES_SCOPE")) {
        for (const extBase of extraBases) {
          try {
            absPath = safePath({
              baseDir: extBase,
              requestedPath: raw,
              cwd: cwd ?? allowedBase,
              mustExist: true,
              expectFile: true,
              accessKind: "attach",
            }).safePath!;
            matchedExternal = extBase;
            break;
          } catch {
            // 尝试下一个批准的外部根
          }
        }
        if (matchedExternal) {
          // 继续使用匹配的经批准的外底座。
        } else {
          if (e.code === "PATH_OUTSIDE_SCOPE") {
            warnings.push(`${raw}: path is outside the project root boundary.`);
          } else if (e.code === "PATH_SYMLINK_ESCAPES_SCOPE") {
            warnings.push(`${raw}: path escapes the project root via a symbolic link.`);
          } else {
            warnings.push(`${raw}: ${e.message}`);
          }
          continue;
        }
      } else if (e instanceof SafePathError) {
        if (e.code === "PATH_OUTSIDE_SCOPE") {
          warnings.push(`${raw}: path is outside the project root boundary.`);
        } else if (e.code === "PATH_SYMLINK_ESCAPES_SCOPE") {
          warnings.push(`${raw}: path escapes the project root via a symbolic link.`);
        } else {
          warnings.push(`${raw}: ${e.message}`);
        }
        continue;
      } else {
        warnings.push(`${raw}: ${e instanceof Error ? e.message : String(e)}`);
        continue;
      }
    }

    if (seenPaths.has(absPath)) continue;
    seenPaths.add(absPath);

    const sensitiveReason = getSensitiveFileReadReason(absPath);
    if (sensitiveReason) {
      warnings.push(`${raw}: blocked sensitive file (${sensitiveReason}).`);
      continue;
    }

    const [isImage, isBinary, projectedDocumentType] = classifyFile(absPath);
    const fi = await readAndSummarize(
      absPath,
      isImage,
      isBinary,
      projectedDocumentType,
      supportsMultimodal,
      artifactsDir,
    );
    files.push(fi);
    if (fi.error) {
      warnings.push(`${raw}: ${fi.error}`);
    }
  }

  const innerText = formatContextBlock(files);
  const contextStr = context(innerText, "User Files").render();

  return {
    cleanedText,
    contextStr,
    files,
    warnings,
  };
}
