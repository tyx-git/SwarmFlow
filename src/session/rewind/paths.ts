/** 路径重叠判定（回退安全性）。 */

import { relative, resolve, sep, isAbsolute } from "node:path";

export function pathsOverlap(a: string, b: string): boolean {
  const left = resolve(a);
  const right = resolve(b);
  const leftToRight = relative(left, right);
  const rightToLeft = relative(right, left);
  const isInside = (value: string) => value === "" || (value !== ".." && !value.startsWith(`..${sep}`) && !isAbsolute(value));
  return isInside(leftToRight) || isInside(rightToLeft);
}
