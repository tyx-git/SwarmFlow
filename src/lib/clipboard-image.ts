/**
 * System clipboard image reader.
 *
 * Thin wrapper over `src/platform/clipboard`. Kept as a stable
 * external API so existing callers (composer, image attachment flow)
 * don't have to know about the platform layer.
 */

import { clipboard } from "./platform/index.js";

export interface ClipboardImageResult {
  buffer: Buffer;
  mediaType: "image/png" | "image/jpeg" | "image/tiff";
}

/**
 * Read an image from the system clipboard.
 * Returns null when there's no image, when the platform can't read
 * clipboard images, or when the required tool (wl-paste / xclip) is
 * missing on Linux.
 */
export async function readClipboardImage(): Promise<ClipboardImageResult | null> {
  return clipboard.readImage();
}
