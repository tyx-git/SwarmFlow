/** @jsxImportSource @opentui/react */

import React from "react";

import type { DisplayThemeColorTokens } from "../theme/index.js";

/**
 * Constant scroll-acceleration adapter. Returns the same multiplier
 * for every wheel tick — used to apply a fixed speed scale per
 * platform (Windows raw wheel ticks feel slow without it). For
 * variable-speed acceleration we'd reach for MacOSScrollAccel from
 * @opentui/core; this class is intentionally minimal and stateless.
 */
class ConstantScrollAccel {
  constructor(private readonly factor: number) {}
  tick(): number { return this.factor; }
  reset(): void {}
}

interface ScrollViewportProps {
  colors: DisplayThemeColorTokens;
  scrollRef: React.RefObject<any>;
  stickyScroll?: boolean;
  stickyStart?: "top" | "bottom";
  viewportPaddingRight?: number;
  /**
   * Per-tick scroll delta multiplier. Defaults to 1 (no acceleration
   * — caller relies on the underlying terminal / OS to deliver
   * comfortable speed). Set higher on platforms that send raw wheel
   * ticks (Windows). See `osCapabilities.conversationScrollMultiplier`.
   */
  multiplier?: number;
  children: React.ReactNode;
}

export function ScrollViewport({
  colors,
  scrollRef,
  stickyScroll = false,
  stickyStart = "bottom",
  viewportPaddingRight = 1,
  multiplier = 1,
  children,
}: ScrollViewportProps): React.ReactNode {
  // Build the accel once per multiplier change. ConstantScrollAccel
  // is stateless so a fresh instance per re-render would also be
  // correct, but memoising keeps prop identity stable so ScrollBox's
  // setter doesn't repeatedly swap the instance.
  const scrollAccel = React.useMemo(
    () => (multiplier > 1 ? new ConstantScrollAccel(multiplier) : undefined),
    [multiplier],
  );

  return (
    <scrollbox
      ref={scrollRef}
      flexGrow={1}
      flexShrink={1}
      stickyScroll={stickyScroll}
      stickyStart={stickyStart}
      viewportOptions={{ paddingRight: viewportPaddingRight }}
      verticalScrollbarOptions={{
        paddingLeft: 1,
        trackOptions: {
          backgroundColor: colors.scrollbarTrack,
          foregroundColor: colors.scrollbarThumb,
        },
      }}
      scrollAcceleration={scrollAccel}
    >
      {children}
    </scrollbox>
  );
}
