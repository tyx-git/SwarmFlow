/**
 * SwarmFlow 版本号。
 *
 * 从 package.json 的 version 字段读取。
 * 构建时由 bun/tsx 解析 JSON 导入，若解析失败则回退为 "0.0.0"。
 */

import pkg from "../package.json" with { type: "json" };

export const VERSION = typeof pkg.version === "string" && pkg.version.trim() !== ""
  ? pkg.version
  : "0.0.0";
