/**
 * 用于 Agent 输入的可组合消息块。
 *
 * 块可以通过 `add()` 组合，并渲染为带有 XML 标签结构的单个字符串。
 */

// ------------------------------------------------------------------
// Part 类型
// ------------------------------------------------------------------

type PartType = "prompt" | "context" | "raw";

interface Part {
  type: PartType;
  label: string | null;
  content: string;
}

// ------------------------------------------------------------------
// XML 属性转义（等同于 Python 的 quoteattr）
// ------------------------------------------------------------------

function quoteAttr(value: string): string {
  let escaped = value.replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  // 使用双引号；对其内部的引号进行转义
  if (escaped.includes('"')) {
    if (!escaped.includes("'")) {
      return `'${escaped}'`;
    }
    escaped = escaped.replace(/"/g, "&quot;");
  }
  return `"${escaped}"`;
}

// ------------------------------------------------------------------
// MessageBlock 类
// ------------------------------------------------------------------

export class MessageBlock {
  parts: Part[];

  constructor(parts: Part[] = []) {
    this.parts = parts;
  }

  /** 将此块与另一个块或纯字符串组合。 */
  add(other: MessageBlock | string): MessageBlock {
    if (typeof other === "string") {
      other = new MessageBlock([{ type: "raw", label: null, content: other }]);
    }
    return new MessageBlock([...this.parts, ...other.parts]);
  }

  /** 将所有部分渲染为用于模型的单个字符串。 */
  render(): string {
    const sections: string[] = [];

    for (const part of this.parts) {
      if (part.type === "context" && part.label) {
        sections.push(`<context label=${quoteAttr(part.label)}>\n${part.content}\n</context>`);
      } else if (part.type === "context") {
        sections.push(`<context>\n${part.content}\n</context>`);
      } else if (part.type === "prompt") {
        sections.push(`<instruction>\n${part.content}\n</instruction>`);
      } else {
        sections.push(part.content);
      }
    }

    return sections.join("\n\n");
  }

  toString(): string {
    return this.render();
  }
}

// ------------------------------------------------------------------
// 工厂函数
// ------------------------------------------------------------------

/** 创建指令块。 */
export function prompt(text: string): MessageBlock {
  return new MessageBlock([{ type: "prompt", label: null, content: text }]);
}

/** 创建带有可选标签的上下文块。 */
export function context(content: string, label?: string): MessageBlock {
  return new MessageBlock([{ type: "context", label: label ?? null, content }]);
}

/** 将多个块组合成一个。 */
export function combine(...blocks: Array<MessageBlock | string>): MessageBlock {
  let result = new MessageBlock();
  for (const b of blocks) {
    if (typeof b === "string") {
      result = result.add(new MessageBlock([{ type: "raw", label: null, content: b }]));
    } else {
      result = result.add(b);
    }
  }
  return result;
}