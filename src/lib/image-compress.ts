/**
 * 图片压缩 / 调整大小。
 *
 * 使用 `jimp` 实现（纯 JS，跨平台）。约束与之前基于 sips 的实现相同：
 *   - 长边 ≤ 2000 px
 *   - 文件大小 ≤ 4.5 MB
 *
 * 行为：
 *   0. 如果输入已经是小 PNG（长边 ≤ 2000 px 且 ≤ 4.5 MB），
 *      直接返回原始字节。jimp 的 PNG 编码器会使真实截图
 *      膨胀 1.5-2.7 倍，快速路径既节省载荷大小又避免
 *      解码/编码往返。
 *   1. 将缓冲区解码为 Jimp 图片。
 *   2. 若长边 > 2000 px，按比例缩小保持宽高比。
 *   3. 若编码结果 ≤ 4.5 MB，返回 PNG；否则
 *      以降低质量的 JPEG 逐步重新编码。
 *   4. 最后手段：即使仍略超限制也返回最低质量 JPEG
 *      （与之前 sips 回退行为一致）。
 */

import { Jimp } from "jimp";

/** 长边最大像素数 */
const MAX_LONG_EDGE = 2000;
/** 最大文件大小（字节） */
const MAX_SIZE_BYTES = 4.5 * 1024 * 1024; // 4.5 MB

// 当 PNG 输出过大时使用的 JPEG 质量阶梯。
// 每个值作为 `getBuffer("image/jpeg", { quality })` 的 quality 参数。
const JPEG_QUALITY_LADDER = [90, 85, 80, 70, 60];

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** 处理后的图片信息 */
export interface ProcessedImage {
  /** Base64 编码的图片数据 */
  base64: string;
  /** 媒体类型 */
  mediaType: "image/png" | "image/jpeg";
  /** 宽度 */
  width: number;
  /** 高度 */
  height: number;
  /** 文件大小（字节） */
  sizeBytes: number;
}

/**
 * 不做完整解码，从 PNG IHDR 块读取宽/高。
 * IHDR 是强制的，总在 8 字节签名后的第一个块；
 * 其宽/高占文件字节 16-23。
 */
function readPngDimensions(buf: Buffer): { width: number; height: number } | null {
  if (buf.length < 24) return null;
  if (!buf.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
  // IHDR type tag at bytes 12-15 must spell "IHDR" for a valid PNG.
  if (buf.toString("ascii", 12, 16) !== "IHDR") return null;
  return {
    width: buf.readUInt32BE(16),
    height: buf.readUInt32BE(20),
  };
}

/**
 * Process an image buffer: resize if too large, compress if too heavy.
 * Cross-platform — runs on macOS, Linux, and Windows without external
 * binaries.
 */
export async function processImage(
  inputBuffer: Buffer,
  _inputMediaType: string,
): Promise<ProcessedImage> {
  // 0. Fast path: well-formed PNG that already fits the size + edge
  //    budget. Return as-is so we don't bloat real screenshots by
  //    re-encoding through jimp's PNG writer.
  if (inputBuffer.length <= MAX_SIZE_BYTES) {
    const dims = readPngDimensions(inputBuffer);
    if (dims && Math.max(dims.width, dims.height) <= MAX_LONG_EDGE) {
      return {
        base64: inputBuffer.toString("base64"),
        mediaType: "image/png",
        width: dims.width,
        height: dims.height,
        sizeBytes: inputBuffer.length,
      };
    }
  }

  const image = await Jimp.fromBuffer(inputBuffer);

  const longEdge = Math.max(image.bitmap.width, image.bitmap.height);
  if (longEdge > MAX_LONG_EDGE) {
    if (image.bitmap.width >= image.bitmap.height) {
      image.resize({ w: MAX_LONG_EDGE });
    } else {
      image.resize({ h: MAX_LONG_EDGE });
    }
  }

  const width = image.bitmap.width;
  const height = image.bitmap.height;

  // 1. Try PNG first — lossless, fits most attachments.
  const pngBuf = await image.getBuffer("image/png");
  if (pngBuf.length <= MAX_SIZE_BYTES) {
    return {
      base64: pngBuf.toString("base64"),
      mediaType: "image/png",
      width,
      height,
      sizeBytes: pngBuf.length,
    };
  }

  // 2. PNG too large — re-encode as JPEG with decreasing quality.
  let lastJpegBuf: Buffer | null = null;
  for (const quality of JPEG_QUALITY_LADDER) {
    const buf = await image.getBuffer("image/jpeg", { quality });
    lastJpegBuf = buf;
    if (buf.length <= MAX_SIZE_BYTES) {
      return {
        base64: buf.toString("base64"),
        mediaType: "image/jpeg",
        width,
        height,
        sizeBytes: buf.length,
      };
    }
  }

  // 3. Even the lowest quality is over the limit. Return it anyway
  //    (matches the prior sips-based behaviour).
  const finalBuf = lastJpegBuf ?? pngBuf;
  return {
    base64: finalBuf.toString("base64"),
    mediaType: lastJpegBuf ? "image/jpeg" : "image/png",
    width,
    height,
    sizeBytes: finalBuf.length,
  };
}
