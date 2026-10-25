/** 共享的 gzip JSON 读写（archive 与 sealed sidecar 共用）。 */

import { readFileSync, writeFileSync } from "node:fs";
import { gunzipSync, gzipSync } from "node:zlib";

export function writeGzipJson(file: string, value: unknown): void {
  writeFileSync(file, gzipSync(Buffer.from(JSON.stringify(value))));
}

export function readGzipJson<T>(file: string): T {
  return JSON.parse(gunzipSync(readFileSync(file)).toString("utf-8")) as T;
}
