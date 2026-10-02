import { addDefaultParsers } from "@opentui/core";
import { getParsers } from "./forked/core/lib/tree-sitter/default-parsers.js";

/** 在 renderer 创建 Tree-sitter 单例客户端前注册 fork 的解析器表。 */
export async function registerSwarmFlowTreeSitterParsers(): Promise<void> {
  // 应用注册表与 fork 的 OpenTUI 解析器表保持一致，并用本地资产覆盖内置定义，
  // 让开发环境和 SEA 构建使用同一套 worker 配置。
  addDefaultParsers(await getParsers());
}
