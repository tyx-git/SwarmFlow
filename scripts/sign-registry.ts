#!/usr/bin/env bun
/**
 * 使用 Ed25519 私钥签名模型 registry JSON 文件，生成 SwarmFlow
 * 在获取时验证的独立 `.sig` 文件。
 *
 *   bun run scripts/sign-registry.ts <private-key.pem> [registry-dir]
 *
 * 默认 registry-dir 为 assets/model-registry。每次发布更新后的
 * models.json / providers.json 时运行此脚本，然后提交 .json + .sig 文件。
 */

import { createPrivateKey, sign as cryptoSign } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const keyPath = process.argv[2];
if (!keyPath) {
  console.error("usage: bun run scripts/sign-registry.ts <private-key.pem> [registry-dir]");
  process.exit(1);
}

const dir = resolve(process.argv[3] ?? "assets/model-registry");
const priv = createPrivateKey(readFileSync(keyPath));

for (const file of ["models.json", "providers.json"]) {
  const data = readFileSync(join(dir, file));
  const sig = cryptoSign(null, data, priv);
  writeFileSync(join(dir, `${file}.sig`), `${sig.toString("base64")}\n`);
  console.log(`signed ${file} -> ${file}.sig`);
}
