import pkg from "../package.json" with { type: "json" };

export const VERSION = typeof pkg.version === "string" && pkg.version.trim() !== ""
  ? pkg.version
  : "0.0.0";
