#!/usr/bin/env bun
/**
 * Sign the model registry JSON files with the Ed25519 private key, producing the
 * detached `.sig` files SwarmFlow verifies on fetch.
 *
 *   bun run scripts/sign-registry.ts <private-key.pem> [registry-dir]
 *
 * Default registry-dir is assets/model-registry. Run this each time you publish
 * an updated models.json / providers.json, then commit the .json + .sig files.
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
