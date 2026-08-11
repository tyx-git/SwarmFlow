import { strict as assert } from "node:assert";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { PassThrough } from "node:stream";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { createRpcServer } from "../src/server/rpc-transport.js";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("CLI can start under Node.js", async () => {
  const child = spawn(process.execPath, ["--import", "tsx", "src/cli.ts", "--version"], {
    cwd: projectRoot,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });

  let stdout = "";
  let stderr = "";
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => { stdout += chunk; });
  child.stderr?.on("data", (chunk: string) => { stderr += chunk; });

  const [exitCode] = await once(child, "close") as [number | null];
  assert.equal(exitCode, 0, stderr);
  assert.match(stdout.trim(), /^\d+\.\d+\.\d+$/);
});

test("RPC transport works with Node streams", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  output.setEncoding("utf8");

  const response = new Promise<unknown>((resolveResponse, reject) => {
    let buffer = "";
    output.on("data", (chunk: string) => {
      buffer += chunk;
      const line = buffer.split("\n")[0];
      if (!line) return;
      try {
        resolveResponse(JSON.parse(line));
      } catch (error) {
        reject(error);
      }
    });
  });

  const rpc = createRpcServer(input, output);
  rpc.on("echo", (params) => params);
  input.end(JSON.stringify({ id: 1, method: "echo", params: { runtime: "node" } }) + "\n");

  assert.deepEqual(await response, { id: 1, result: { runtime: "node" } });
  rpc.close();
});
