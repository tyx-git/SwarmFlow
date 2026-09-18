/** @jsxImportSource @opentui/react */

import React, { useState } from "react";

interface SelectableRowProps {
  width?: number | "auto" | `${number}%`;
  hoverBackgroundColor?: string;
  onPress?: () => void;
  children: React.ReactNode;
}

export function SelectableRow({
  width = "100%",
  hoverBackgroundColor,
  onPress,
  children,
}: SelectableRowProps): React.ReactNode {
  const [hovered, setHovered] = useState(false);

  return (
    <box
      width={width}
      cursor={onPress ? "pointer" : undefined}
      backgroundColor={hovered && onPress ? hoverBackgroundColor : undefined}
      onMouseOver={onPress ? () => setHovered(true) : undefined}
      onMouseOut={onPress ? () => setHovered(false) : undefined}
      onMouseDown={onPress ? (event: any) => {
        event.stopPropagation();
        event.preventDefault();
        onPress();
      } : undefined}
    >
      {children}
    </box>
  );
}
