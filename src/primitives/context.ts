/**
 * 用于 Agent 输入的可组合消息块。
 *
 * 块可以通过 `add()` 组合，并渲染为带有 XML 标签结构的单个字符串。
 */

// ------------------------------------------------------------------
// Part type
// ------------------------------------------------------------------

type PartType = "prompt" | "context" | "raw";

interface Part {
  type: PartType;
  label: string | null;
  content: string;
}

// ------------------------------------------------------------------
// XML attribute escaping (equivalent to Python's quoteattr)
// ------------------------------------------------------------------

function quoteAttr(value: string): string {
  let escaped = value.replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  // Use double-quotes; escape them inside
  if (escaped.includes('"')) {
    if (!escaped.includes("'")) {
      return `'${escaped}'`;
    }
    escaped = escaped.replace(/"/g, "&quot;");
  }
  return `"${escaped}"`;
}

// ------------------------------------------------------------------
// MessageBlock class
// ------------------------------------------------------------------

export class MessageBlock {
  parts: Part[];

  constructor(parts: Part[] = []) {
    this.parts = parts;
  }

  /** Combine this block with another block or plain string. */
  add(other: MessageBlock | string): MessageBlock {
    if (typeof other === "string") {
      other = new MessageBlock([{ type: "raw", label: null, content: other }]);
    }
    return new MessageBlock([...this.parts, ...other.parts]);
  }

  /** Render all parts into a single string for the model. */
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
// Factory functions
// ------------------------------------------------------------------

/** Create an instruction block. */
export function prompt(text: string): MessageBlock {
  return new MessageBlock([{ type: "prompt", label: null, content: text }]);
}

/** Create a context block with an optional label. */
export function context(content: string, label?: string): MessageBlock {
  return new MessageBlock([{ type: "context", label: label ?? null, content }]);
}

/** Combine multiple blocks into one. */
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
