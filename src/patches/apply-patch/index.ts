/**
 * apply_patch 纯引擎：解析、匹配、逐行 EOL 与顺序应用。
 *
 * 逻辑移植自 OpenAI Codex `codex-rs/apply-patch`（Apache-2.0），
 * 上游许可与 NOTICE 见本目录。
 */

export * from "./markers.js";
export * from "./parser.js";
export * from "./seek-sequence.js";
export * from "./text-file.js";
export * from "./file-update.js";
export * from "./apply.js";
export * from "./extract.js";
