declare module "marked-terminal" {
  import type { MarkedExtension } from "marked";

  export interface MarkedTerminalOptions {
    reflowText?: boolean;
    width?: number;
    [key: string]: unknown;
  }

  export function markedTerminal(options?: MarkedTerminalOptions): MarkedExtension;
}
