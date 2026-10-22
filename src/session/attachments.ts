/**
 * turn 输入的附件处理：`@file` 引用展开与图片落盘/回读。
 *
 * 会话侧状态通过 {@link AttachmentContext} 注入，本模块不持有任何状态；
 * 图片序号由调用方（Session）维护，保证同一会话内文件名不冲突。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { processFileAttachments } from "../attachments/pipeline.js";
import { parseReferences } from "../attachments/reference.js";
import { hasFiles as fileAttachHasFiles, hasImages as fileAttachHasImages } from "../attachments/types.js";
import { SafePathError, safePath } from "../security/path.js";

/** 附件处理所需的会话侧状态。 */
export interface AttachmentContext {
  projectRoot: string;
  sessionDir(): string | undefined;
  artifactsDir(): string | undefined;
  supportsMultimodal(): boolean;
  /** 取下一个图片序号（从 1 开始，由调用方自增）。 */
  nextImageNumber(): number;
}

/**
 * Extract image blocks from multimodal content, save them to
 * <sessionDir>/images/, and replace them with image_ref blocks for the log.
 * Returns the original content if no images, or if session dir is unavailable.
 */
export function extractAndSaveImages(
  ctx: AttachmentContext,
  content: string | Array<Record<string, unknown>>,
): string | Array<Record<string, unknown>> {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return content;

  let hasImage = false;
  for (const block of content) {
    if (block["type"] === "image" && block["data"]) {
      hasImage = true;
      break;
    }
  }
  if (!hasImage) return content;

  const sessionDir = ctx.sessionDir();
  if (!sessionDir) return content; // Can't save without session dir

  const imagesDir = join(sessionDir, "images");
  try {
    mkdirSync(imagesDir, { recursive: true });
  } catch {
    return content; // Can't create images dir, keep inline
  }

  return content.map((block) => {
    if (block["type"] !== "image" || !block["data"]) return block;

    const mediaType = (block["media_type"] as string) || "image/png";
    const ext = mediaType.split("/")[1]?.replace("jpeg", "jpg") || "png";
    let filename = "";
    let filePath = "";
    do {
      const n = ctx.nextImageNumber();
      filename = `img-${String(n).padStart(3, "0")}.${ext}`;
      filePath = join(imagesDir, filename);
    } while (existsSync(filePath));

    try {
      writeFileSync(filePath, Buffer.from(block["data"] as string, "base64"));
    } catch {
      return block; // Write failed, keep inline
    }

    return {
      type: "image_ref",
      path: `images/${filename}`,
      media_type: mediaType,
    };
  });
}

/**
 * Resolve an image_ref path to base64 data for API consumption.
 * Used by projectToApiMessages to restore image data from files.
 */
export function resolveImageRef(
  sessionDir: string | undefined,
  refPath: string,
): { data: string; media_type: string } | null {
  if (!sessionDir) return null;
  const fullPath = join(sessionDir, refPath);
  try {
    const data = readFileSync(fullPath);
    const ext = refPath.split(".").pop() || "png";
    const mediaTypeMap: Record<string, string> = {
      png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
      gif: "image/gif", webp: "image/webp", bmp: "image/bmp",
    };
    return {
      data: data.toString("base64"),
      media_type: mediaTypeMap[ext] || "image/png",
    };
  } catch {
    return null;
  }
}

/** 展开 `@file` 引用：多模态模型走分块内容，其余走文本拼接。 */
export async function processAttachments(
  ctx: AttachmentContext,
  userInput: string,
): Promise<string | Array<Record<string, unknown>>> {
  const supportsMultimodal = ctx.supportsMultimodal();
  const [, refs] = parseReferences(userInput);
  const explicitAttachmentRoots = new Set<string>();
  for (const raw of refs) {
    if (!raw || typeof raw !== "string") continue;
    try {
      safePath({
        baseDir: ctx.projectRoot,
        requestedPath: raw,
        cwd: ctx.projectRoot,
        accessKind: "attach",
        allowCreate: true,
      });
    } catch (e) {
      if (!(e instanceof SafePathError)) continue;
      if (e.code !== "PATH_OUTSIDE_SCOPE" && e.code !== "PATH_SYMLINK_ESCAPES_SCOPE") continue;
      const lexicalTarget = e.details.resolvedPath || resolve(ctx.projectRoot, raw);
      explicitAttachmentRoots.add(resolve(lexicalTarget));
    }
  }
  const externalRoots = [...explicitAttachmentRoots];
  const attachmentArtifactsDir = ctx.artifactsDir();
  try {
    const result = await processFileAttachments(
      userInput,
      undefined,
      supportsMultimodal,
      ctx.projectRoot,
      externalRoots,
      attachmentArtifactsDir,
    );

    if (!fileAttachHasFiles(result)) return userInput;

    if (fileAttachHasImages(result) && supportsMultimodal) {
      const contentParts: Array<Record<string, unknown>> = [];
      const cleaned = result.cleanedText.trim();
      if (cleaned) {
        contentParts.push({ type: "text", text: cleaned });
      }
      for (const f of result.files) {
        if (f.isImage && f.imageData) {
          contentParts.push({
            type: "image",
            media_type: f.imageMediaType,
            data: f.imageData,
          });
        }
      }
      if (result.contextStr) {
        contentParts.push({ type: "text", text: result.contextStr });
      }
      return contentParts;
    }

    let userContent = result.cleanedText;
    if (result.contextStr) {
      userContent += "\n\n" + result.contextStr;
    }
    return userContent;
  } catch (e) {
    console.warn(
      `File attachment processing failed; continuing without attachments: ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
    return userInput;
  }
}
