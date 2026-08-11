#!/usr/bin/env node
/**
 * 生成用于签名远程模型 registry 的 Ed25519 密钥对。
 *
 *   node --import tsx scripts/gen-registry-key.ts [private-key-output.pem]
 *
 * 写入私钥（保持私密，绝不提交——存放在 CI secret 中）并
 * 打印公钥以粘贴到 src/registry-fetch.ts REGISTRY_PUBLIC_KEY_PEM。
 * 运行一次即可。
 */

import { generateKeyPairSync } from "node:crypto";
import { writeFileSync } from "node:fs";

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const pubPem = publicKey.export({ type: "spki", format: "pem" }) as string;
const privPem = privateKey.export({ type: "pkcs8", format: "pem" }) as string;

const out = process.argv[2] ?? "swarmflow-registry-key.pem";
writeFileSync(out, privPem, { mode: 0o600 });

console.log(`Private key written to ${out}  (KEEP SECRET — do not commit; put in a CI secret)`);
console.log("\nPaste this into src/registry-fetch.ts as REGISTRY_PUBLIC_KEY_PEM:\n");
console.log(JSON.stringify(pubPem));
