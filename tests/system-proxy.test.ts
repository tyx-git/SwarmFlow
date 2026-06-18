import { describe, expect, it } from "bun:test";

import { parseWinInetProxy } from "../src/platform/system-proxy/win32.js";
import { applySystemProxyToEnv } from "../src/system-proxy.js";

describe("parseWinInetProxy", () => {
  const base = {
    autoConfigUrl: null,
    proxyEnable: "0x1",
    proxyServer: "127.0.0.1:7890",
    proxyOverride: null,
  };

  it("returns null when proxy is disabled (0x0)", () => {
    expect(parseWinInetProxy({ ...base, proxyEnable: "0x0" })).toBeNull();
  });

  it("returns null when ProxyEnable is absent", () => {
    expect(parseWinInetProxy({ ...base, proxyEnable: null })).toBeNull();
  });

  it("returns null when a PAC AutoConfigURL is set (can't resolve statically)", () => {
    expect(
      parseWinInetProxy({ ...base, autoConfigUrl: "http://wpad/wpad.dat" }),
    ).toBeNull();
  });

  it("uses one proxy for both schemes and adds http:// scheme", () => {
    expect(parseWinInetProxy(base)).toEqual({
      httpProxy: "http://127.0.0.1:7890",
      httpsProxy: "http://127.0.0.1:7890",
      noProxy: undefined,
    });
  });

  it("accepts a decimal '1' for ProxyEnable", () => {
    expect(parseWinInetProxy({ ...base, proxyEnable: "1" })?.httpsProxy).toBe(
      "http://127.0.0.1:7890",
    );
  });

  it("keeps an explicit scheme when present", () => {
    expect(
      parseWinInetProxy({ ...base, proxyServer: "http://127.0.0.1:7890" })?.httpProxy,
    ).toBe("http://127.0.0.1:7890");
  });

  it("parses per-protocol ProxyServer", () => {
    expect(
      parseWinInetProxy({
        ...base,
        proxyServer: "http=127.0.0.1:7890;https=10.0.0.1:8080;socks=1.2.3.4:1080",
      }),
    ).toEqual({
      httpProxy: "http://127.0.0.1:7890",
      httpsProxy: "http://10.0.0.1:8080",
      noProxy: undefined,
    });
  });

  it("reuses the http= entry for https when https= is absent", () => {
    const cfg = parseWinInetProxy({ ...base, proxyServer: "http=127.0.0.1:7890" });
    expect(cfg?.httpProxy).toBe("http://127.0.0.1:7890");
    expect(cfg?.httpsProxy).toBe("http://127.0.0.1:7890");
  });

  it("expands <local> in ProxyOverride to loopback hosts", () => {
    expect(
      parseWinInetProxy({ ...base, proxyOverride: "<local>;corp.example.com" })?.noProxy,
    ).toBe("localhost,127.0.0.1,::1,corp.example.com");
  });
});

describe("applySystemProxyToEnv", () => {
  it("does not overwrite an explicit HTTPS_PROXY env var", () => {
    const env = { HTTPS_PROXY: "http://explicit:1" } as NodeJS.ProcessEnv;
    applySystemProxyToEnv(env);
    expect(env["HTTPS_PROXY"]).toBe("http://explicit:1");
  });

  it("is a no-op on POSIX (provider returns null) — leaves a clean env untouched", () => {
    // The active provider on the test host (macOS/Linux) is the posix
    // noop, so nothing should be written into an empty env.
    const env = {} as NodeJS.ProcessEnv;
    applySystemProxyToEnv(env);
    expect(env["HTTPS_PROXY"]).toBeUndefined();
    expect(env["HTTP_PROXY"]).toBeUndefined();
  });
});
