/** @jsxImportSource @opentui/react */

import React from "react";
import { createTextAttributes } from "@opentui/core";

const ATTRS_BOLD = createTextAttributes({ bold: true });

function parseHex(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ];
}

function toHex(r: number, g: number, b: number): string {
  const clamp = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
  return `#${clamp(r).toString(16).padStart(2, "0")}${clamp(g).toString(16).padStart(2, "0")}${clamp(b).toString(16).padStart(2, "0")}`;
}

function lerpColor(a: string, b: string, t: number): string {
  const [ar, ag, ab] = parseHex(a);
  const [br, bg, bb] = parseHex(b);
  return toHex(
    ar + (br - ar) * t,
    ag + (bg - ag) * t,
    ab + (bb - ab) * t,
  );
}

function noise2D(x: number, y: number): number {
  return (
    Math.sin(x * 1.2 + y * 0.7)
    + Math.sin(x * 0.7 + y * 1.3)
    + Math.sin((x + y) * 0.8)
  ) / 3;
}

interface GlowTextProps {
  text: string;
  fromColor: string;
  toColor: string;
}

// Animation disabled: continuous PTY output from the color animation resets
// Ghostty's cursor blink timer (processOutput → reset_cursor_blink every
// ≤500ms, while the blink period is 600ms), preventing the input cursor from
// blinking on the welcome screen. Static midpoint color until we move to a
// self-drawn cursor that doesn't depend on the terminal's blink timer.
function GlowTextInner({
  text,
  fromColor,
  toColor,
}: GlowTextProps): React.ReactNode {
  const fg = lerpColor(fromColor, toColor, 0.5);
  return <text fg={fg} attributes={ATTRS_BOLD} content={text} />;
}

export const GlowText = React.memo(GlowTextInner);
