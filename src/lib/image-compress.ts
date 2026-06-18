/**
 * Image compression / resizing.
 *
 * Implemented with `jimp` (pure JS, cross-platform). Same constraints
 * as the previous sips-based implementation:
 *   - Long edge 鈮?2000 px
 *   - File size  鈮?4.5 MB
 *
 * Behaviour:
 *   0. If the input is already a small PNG (long edge 鈮?2000 px and
 *      鈮?4.5 MB), return the original bytes unchanged. jimp's PNG
 *      encoder otherwise inflates real screenshots by 1.5鈥?.7脳 over
 *      what most capture tools produce, so the fast-path saves both
 *      payload size and a decode/encode round-trip.
 *   1. Decode the buffer into a Jimp image.
 *   2. If long edge > 2000 px, downscale preserving aspect ratio.
 *   3. If the encoded result fits under 4.5 MB, return PNG; otherwise
 *      progressively re-encode as JPEG with decreasing quality.
 *   4. Last resort: return the lowest-quality JPEG even if still
 *      slightly over the limit (matches the prior sips fallback).
 */

import { Jimp } from "jimp";

const MAX_LONG_EDGE = 2000;
const MAX_SIZE_BYTES = 4.5 * 1024 * 1024; // 4.5 MB

// Quality ladder used when the PNG output is too large. Each value
// is the JPEG quality passed to `getBuffer("image/jpeg", { quality })`.
const JPEG_QUALITY_LADDER = [90, 85, 80, 70, 60];

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export interface ProcessedImage {
  base64: string;
  mediaType: "image/png" | "image/jpeg";
  width: number;
  height: number;
  sizeBytes: number;
}

/**
 * Read width/height from the PNG IHDR chunk without doing a full
 * decode. IHDR is mandatory and always the first chunk after the
 * 8-byte signature; its width/height occupy bytes 16-23 of the file.
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
 * Cross-platform 鈥?runs on macOS, Linux, and Windows without external
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

  // 1. Try PNG first 鈥?lossless, fits most attachments.
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

  // 2. PNG too large 鈥?re-encode as JPEG with decreasing quality.
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
