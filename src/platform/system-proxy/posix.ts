import type { SystemProxyProvider } from "../types.js";

/**
 * POSIX has no registry-style proxy store that Bun's `fetch` ignores:
 * macOS/Linux users configure CLI proxies through the HTTP_PROXY /
 * HTTPS_PROXY environment variables, which Bun already honours. We
 * deliberately do NOT shell out to `scutil --proxy` (macOS) or
 * gsettings (GNOME): those describe GUI-application proxies that
 * terminal tools conventionally don't inherit, and adopting them would
 * surprise users who expect env-var-only behaviour. Returning null lets
 * the env vars remain the single source of truth on POSIX.
 */
export const posixSystemProxy: SystemProxyProvider = {
  id: "posix-noop",
  getSystemProxy() {
    return null;
  },
};
