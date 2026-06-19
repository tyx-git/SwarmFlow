/** @jsxImportSource @opentui/react */

import React from "react";
import { createTextAttributes } from "@opentui/core";
import type { DisplayTheme } from "../theme/index.js";
import { ToastFrame } from "./toast-frame.js";

const ATTRS_BOLD = createTextAttributes({ bold: true });

export type UpdateToastPhase = "downloading" | "staged" | "available" | "failed";

interface UpdateToastProps {
  phase: UpdateToastPhase;
  /** Target version. Optional: a failure before the version is known has none. */
  version?: string;
  /** Short failure reason, shown only when phase is "failed". */
  error?: string;
  theme: DisplayTheme;
  onRestart: () => void;
  onDismiss: () => void;
}

export function UpdateToast({
  phase,
  version,
  error,
  theme,
  onRestart,
  onDismiss,
}: UpdateToastProps): React.ReactNode {
  const { colors } = theme;

  const isReady = phase === "staged";
  const isFailed = phase === "failed";

  let bodyLine1: string;
  let bodyLine2: string | undefined;
  if (isFailed) {
    bodyLine1 = version ? `Couldn't download v${version}.` : "Update download failed.";
    bodyLine2 = "Check your proxy / network, then run `fermi update`.";
  } else if (isReady) {
    bodyLine1 = "A new version of Fermi downloaded.";
    bodyLine2 = undefined;
  } else {
    bodyLine1 = "A new version of Fermi detected.";
    bodyLine2 = phase === "downloading"
      ? "Downloading update..."
      : "Run `fermi update` to install.";
  }

  return (
    <ToastFrame
      title={isFailed ? " Update failed " : " New Fermi "}
      titleColor={isFailed ? colors.red : colors.accent}
      borderColor={colors.dim}
      theme={theme}
      footer={[
        { text: " Ctrl+L " },
        { text: "dismiss ", color: colors.accent, onClick: onDismiss },
      ]}
    >
      <text fg={colors.text} content={bodyLine1} />
      {bodyLine2 ? <text fg={colors.text} content={bodyLine2} /> : null}
      {isFailed && error ? <text fg={colors.dim} content={error} /> : null}
      {isReady ? (
        <box flexDirection="row">
          <text
            fg={colors.accent}
            attributes={ATTRS_BOLD}
            content="Restart"
            onMouseDown={(e: any) => {
              e.stopPropagation();
              e.preventDefault();
              onRestart();
            }}
          />
          <text fg={colors.text} content=" to apply." />
        </box>
      ) : null}
    </ToastFrame>
  );
}
