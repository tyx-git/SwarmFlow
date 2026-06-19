/**
 * 系统剪贴板图片读取器。
 *
 * 封装 `src/platform/clipboard` 的薄层包装。作为稳定的外部 API 保留，
 * 使现有调用者（composer、图片附件流程）无需了解平台层。
 */

import { clipboard } from "./platform/index.js";

/** 剪贴板图片读取结果 */
export interface ClipboardImageResult {
  /** 图片二进制数据 */
  buffer: Buffer;
  /** 媒体类型 */
  mediaType: "image/png" | "image/jpeg" | "image/tiff";
}

/**
 * 从系统剪贴板读取图片。
 * 无图片、平台不支持读取剪贴板图片、或 Linux 上缺少必要工具
 * （wl-paste / xclip）时返回 null。
 */
export async function readClipboardImage(): Promise<ClipboardImageResult | null> {
  return clipboard.readImage();
}
