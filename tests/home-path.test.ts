import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadDotenv } from "../src/lifecycle/dotenv.js";
import { getSwarmflowHomeDir } from "../src/lib/home-path.js";

describe("fixed SwarmFlow home directory", () => {
  let tempHome: string;
  let tempSwarmflowHome: string;

  beforeEach(() => {
    tempHome = mkdtempSync(join(tmpdir(), "swarmflow-home-"));
    tempSwarmflowHome = join(tempHome, ".swarmflow");
    mkdirSync(tempSwarmflowHome, { recursive: true });
  });

  afterEach(() => {
    delete process.env["SWARMFLOW_TEST_KEY"];
    rmSync(tempHome, { recursive: true, force: true });
  });

  it("returns a fixed path under the user home directory", () => {
    const home = getSwarmflowHomeDir();
    expect(home).toMatch(/\.swarmflow$/);
  });

  it("loads .env from a specified home directory", () => {
    writeFileSync(join(tempSwarmflowHome, ".env"), "SWARMFLOW_TEST_KEY=from-home\n", "utf-8");

    loadDotenv(tempSwarmflowHome);

    expect(process.env["SWARMFLOW_TEST_KEY"]).toBe("from-home");
  });

});
