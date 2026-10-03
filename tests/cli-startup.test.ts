import { describe, expect, it } from "vitest";
import { main, type MainDeps } from "../src/cli.js";

describe("CLI startup", () => {
  it("dispatches init without update preflight", async () => {
    const events: string[] = [];
    const deps: MainDeps = {
      homeDir: "F:/tmp/swarmflow-test-home",
      loadDotenv: () => events.push("dotenv"),
      runInitWizard: async () => events.push("init"),
    };
    await main(["node", "swarmflow", "init"], deps);
    expect(events).toEqual(["dotenv", "init"]);
  });

});
