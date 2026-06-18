#!/usr/bin/env bun
/**
 * Generate the Ed25519 keypair used to sign the remote model registry.
 *
 *   bun run scripts/gen-registry-key.ts [private-key-output.pem]
 *
 * Writes the PRIVATE key (keep secret, never commit — store in a CI secret) and
 * prints the PUBLIC key to paste into src/registry-fetch.ts REGISTRY_PUBLIC_KEY_PEM.
 * Run this ONCE.
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
