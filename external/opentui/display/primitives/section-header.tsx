/** @jsxImportSource @opentui/react */

import React from "react";
import { createTextAttributes } from "@opentui/core";

const ATTRS_BOLD = createTextAttributes({ bold: true });
const ATTRS_NONE = createTextAttributes({});

interface SectionHeaderProps {
  label: string;
  color: string;
  bold?: boolean;
  paddingLeft?: number;
  paddingBottom?: number;
}

export function SectionHeader({
  label,
  color,
  bold = true,
  paddingLeft = 0,
  paddingBottom = 0,
}: SectionHeaderProps): React.ReactNode {
  return (
    <box paddingLeft={paddingLeft} paddingBottom={paddingBottom}>
      <text fg={color} attributes={bold ? ATTRS_BOLD : ATTRS_NONE} content={label} />
    </box>
  );
}
