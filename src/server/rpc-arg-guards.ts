/**
 * RPC 参数守卫：把对端发来的任意 JSON 值收敛成方法要求的类型，不合规即抛出带方法名的错误。
 */

import type { PermissionMode } from "../permissions/index.js";

const PERMISSION_MODES = new Set<PermissionMode>(["read_only", "reversible", "yolo"]);
export function expectObject(params: unknown, method: string): Record<string, unknown> {
  if (params == null) return {};
  if (typeof params !== "object" || Array.isArray(params)) {
    throw new Error(`${method}: params must be an object`);
  }
  return params as Record<string, unknown>;
}

export function expectString(params: Record<string, unknown>, key: string, method: string): string {
  const v = params[key];
  if (typeof v !== "string") throw new Error(`${method}: '${key}' must be a string`);
  return v;
}

export function optString(params: Record<string, unknown>, key: string): string | undefined {
  const v = params[key];
  return typeof v === "string" ? v : undefined;
}

export function optNumber(params: Record<string, unknown>, key: string): number | undefined {
  const v = params[key];
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

export function expectPermissionMode(
  params: Record<string, unknown>,
  key: string,
  method: string,
): PermissionMode {
  const v = expectString(params, key, method);
  if (!PERMISSION_MODES.has(v as PermissionMode)) {
    throw new Error(`${method}: '${key}' must be one of read_only, reversible, yolo`);
  }
  return v as PermissionMode;
}
