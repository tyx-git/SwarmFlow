/** 附件类型判定与展示上限：扩展名集合、媒体类型、预览长度和扫描排除。 */

import path from "node:path";

import { isProjectedDocumentPath } from "../context/document/view.js";
import { EXCLUDE_DIRS } from "../tools/scan-exclusions.js";

// ------------------------------------------------------------------
// 常量
// ------------------------------------------------------------------

export const PREVIEW_CHAR_LIMIT = 5000;
export const CODE_LINE_LIMIT = 50;
export const MAX_TEXT_FILE_SIZE = 50 * 1024 * 1024; // 50 MB
export const MAX_IMAGE_FILE_SIZE = 50 * 1024 * 1024; // 50 MB

export const CODE_EXTENSIONS = new Set([
  ".py", ".js", ".ts", ".jsx", ".tsx", ".java", ".c", ".cpp", ".cc",
  ".h", ".hpp", ".cs", ".go", ".rs", ".rb", ".swift", ".kt", ".kts",
  ".scala", ".lua", ".php", ".sh", ".bash", ".zsh", ".pl", ".r",
  ".m", ".mm", ".zig", ".v", ".nim", ".dart", ".ex", ".exs",
  ".hs", ".ml", ".mli", ".clj", ".lisp", ".el",
]);

export const IMAGE_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".webp", ".svg", ".ico", ".tiff",
]);

export const BINARY_EXTENSIONS = new Set([
  ".zip", ".tar", ".gz", ".bz2", ".7z", ".rar",
  ".exe", ".dll", ".so", ".dylib",
  ".bin", ".dat", ".iso",
  ".mp3", ".mp4", ".wav", ".avi", ".mov", ".mkv", ".flac",
  ".o", ".pyc", ".class", ".wasm",
]);

// 正则：@ 必须位于字符串开头，或前面是空白字符。
export const AT_PATTERN =
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

// 与文件附加补全、glob、grep、list_dir 共用同一份默认跳过目录。
export const SCAN_EXCLUDE_DIRS = EXCLUDE_DIRS;

export function classifyFile(
  filePath: string,
): [boolean, boolean, string | null] {
  const ext = path.extname(filePath).toLowerCase();
  const isImage = IMAGE_EXTENSIONS.has(ext);
  const projectedDocumentType = isProjectedDocumentPath(filePath) ? ext.slice(1).toLowerCase() : null;
  const isBinary = isImage || projectedDocumentType !== null || BINARY_EXTENSIONS.has(ext);
  return [isImage, isBinary, projectedDocumentType];
}
