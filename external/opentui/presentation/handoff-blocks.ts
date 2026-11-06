/**
 * 机器交接块（swarmflow-handoff 围栏）的展示拆分。
 *
 * 角色提示词要求每次 DAG 任务回复末尾附一段结构化 JSON；它是给运行时看的，不该
 * 刷进聊天区。这里只做展示层处理：移除所有已闭合块与流式未闭合的半块，并取最后
 * 一个有效 conclusion 作为摘要。刻意宽松——只要求 conclusion，根 Queen 的 handoff
 * 允许省略 open_questions。
 */

export interface TaskHandoffDisplaySplit {
  displayText: string;
  conclusion?: string;
  hadBlock: boolean;
}

/** BOM 码位；用码位比较而不是字面量，避免源码里混入不可见字符。 */
const BOM_CODE_POINT = 0xfeff;

function stripLeadingBoms(text: string): string {
  let index = 0;
  while (text.codePointAt(index) === BOM_CODE_POINT) {
    index += 1;
  }
  return index === 0 ? text : text.slice(index);
}

/** 解析回复中最后一个有效的结构化交接区块。 */
export function splitTaskHandoffForDisplay(output: string): TaskHandoffDisplaySplit {
  const source = stripLeadingBoms(output);
  const pattern = /```swarmflow-handoff\s*\r?\n([\s\S]*?)\r?\n```/gi;
  let conclusion: string | undefined;
  let hadBlock = false;

  for (const match of source.matchAll(pattern)) {
    hadBlock = true;
    try {
      const payload = JSON.parse(match[1]!) as Record<string, unknown>;
      if (typeof payload["conclusion"] === "string") {
        const normalized = payload["conclusion"].replace(/\s+/g, " ").trim();
        if (normalized) conclusion = normalized;
      }
    } catch {
      // 无效块也隐藏，但不产生 conclusion。
    }
  }

  let displayText = source.replace(pattern, "");
  const openIndex = displayText.lastIndexOf("```swarmflow-handoff");
  if (!hadBlock && openIndex < 0) {
    return { displayText: source, hadBlock: false };
  }
  if (openIndex >= 0) {
    displayText = displayText.slice(0, openIndex);
  }
  // 块被移除后可能留下多余空行；只保留段落间的一个空行。
  displayText = displayText.replace(/\n{3,}/g, "\n\n").trim();
  return { displayText, conclusion, hadBlock: true };
}
