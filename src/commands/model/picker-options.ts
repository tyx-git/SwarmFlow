/** /model 选择器的选项树构建（两级/分组/厂商前缀）。 */

import { buildModelPickerTree } from "../../models/picker/model-tree.js";
import { toCommandPickerOptions } from "../../models/picker/labels.js";
import type { ModelPickerTreeContext } from "../../models/picker/types.js";

import { type CommandOption, type CommandOptionsContext } from "../types.js";

/**
 * 构建 /model 选择器的选项。
 *
 * 支持三种结构：
 * - 两级：provider → model（适用于 anthropic、openai 这类未分组的 provider）
 * - 借助 group 字段的三级：group → 子 provider → model（kimi、glm、minimax）
 * - 借助厂商前缀的三级：openrouter → 厂商 → model
 */
export function modelOptions(ctx: CommandOptionsContext): CommandOption[] {
  return modelOptionsWithTree(ctx);
}

export type ModelPickerOverrides = Omit<ModelPickerTreeContext, "session">;

export function modelOptionsWithTree(
  ctx: CommandOptionsContext,
  overrides?: ModelPickerOverrides,
): CommandOption[] {
  return toCommandPickerOptions(buildModelPickerTree({
    session: ctx.session,
    ...overrides,
  })) as CommandOption[];
}

export function flatModelOptionsWithTree(
  ctx: CommandOptionsContext,
  overrides?: ModelPickerOverrides,
): CommandOption[] {
  const tree = buildModelPickerTree({
    session: ctx.session,
    ...overrides,
  });
  const flat: CommandOption[] = [];
  function walk(nodes: Array<{ label: string; value: string; children?: any[] }>) {
    for (const node of nodes) {
      if (node.children && node.children.length > 0) {
        walk(node.children);
      } else {
        flat.push({ label: node.label, value: node.value });
      }
    }
  }
  walk(toCommandPickerOptions(tree));
  return flat;
}
