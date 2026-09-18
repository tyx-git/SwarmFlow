/** @jsxImportSource @opentui/react */

import React, { useState } from "react";
import path from "node:path";

import { browser } from "../../../../src/platform/index.js";
import { createTextAttributes } from "@opentui/core";

const ATTRS_UNDERLINE = createTextAttributes({ underline: true });

/** 用系统默认程序打开文件；相对路径按当前工作目录解析。 */
export function openFile(filePath: string): void {
  const resolved = path.isAbsolute(filePath) ? filePath : path.resolve(filePath);
  browser.openFile(resolved);
}

export interface ClickablePathProps {
  text: string;
  baseColor: string;
  /** 悬停时的行背景色。 */
  hoverBg: string;
}

/** 文件路径文本：悬停高亮，点击调用系统默认程序打开。 */
export function ClickablePath({ text, baseColor, hoverBg }: ClickablePathProps): React.ReactNode {
  const [hovered, setHovered] = useState(false);
  return (
    <box
      flexShrink={1}
      backgroundColor={hovered ? hoverBg : undefined}
      onMouseOver={() => setHovered(true)}
      onMouseOut={() => setHovered(false)}
      onMouseDown={(e: any) => {
        e.stopPropagation();
        e.preventDefault();
        if (text) openFile(text);
      }}
    >
      <text
        fg={baseColor}
        attributes={ATTRS_UNDERLINE}
        content={text}
        truncate
      />
    </box>
  );
}
