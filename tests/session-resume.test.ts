import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { findSessionById } from "../src/session-resume.js";
import { randomSessionId } from "../src/persistence.js";

describe("findSessionById", () => {
  it("returns null when the home dir has no projects/", () => {
    const home = mkdtempSync(join(tmpdir(), "swarmflow-resume-test-"));
    expect(findSessionById("019de786-1e41-7d21-b1e6-43919a4be1ce", home)).toBeNull();
    rmSync(home, { recursive: true, force: true });
  });

  it("returns null when the session UUID is not present in any project", () => {
    const home = mkdtempSync(join(tmpdir(), "swarmflow-resume-test-"));
    const projectsDir = join(home, "projects", "demo_abcdef");
    mkdirSync(projectsDir, { recursive: true });
    writeFileSync(join(projectsDir, "project.json"), JSON.stringify({ original_path: "/x" }));
    mkdirSync(join(projectsDir, randomSessionId()));

    expect(findSessionById("00000000-0000-7000-8000-000000000000", home)).toBeNull();
    rmSync(home, { recursive: true, force: true });
  });

  it("locates a session and returns its project path", () => {
    const home = mkdtempSync(join(tmpdir(), "swarmflow-resume-test-"));
    const projectsDir = join(home, "projects", "demo_abcdef");
    mkdirSync(projectsDir, { recursive: true });
    writeFileSync(
      join(projectsDir, "project.json"),
      JSON.stringify({ original_path: "/Users/me/work/demo" }),
    );
    const sid = randomSessionId();
    const sessionDir = join(projectsDir, sid);
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(
      join(sessionDir, "meta.json"),
      JSON.stringify({ session_id: sid, title: "Demo session" }),
    );

    const found = findSessionById(sid, home);
    expect(found).not.toBeNull();
    expect(found!.sessionDir).toBe(sessionDir);
    expect(found!.projectDir).toBe(projectsDir);
    expect(found!.projectPath).toBe("/Users/me/work/demo");
    expect(found!.title).toBe("Demo session");

    rmSync(home, { recursive: true, force: true });
  });
});

describe("randomSessionId", () => {
  it("returns a UUID v7 with the version nibble == 7", () => {
    const id = randomSessionId();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("yields distinct IDs across many calls", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 1000; i++) ids.add(randomSessionId());
    expect(ids.size).toBe(1000);
  });

  it("is monotonic across milliseconds (UUIDv7 timestamp prefix)", () => {
    const first = randomSessionId();
    // Sleep a few ms to ensure timestamp moves forward.
    const start = Date.now();
    while (Date.now() - start < 5) { /* spin */ }
    const second = randomSessionId();
    expect(first.slice(0, 8) <= second.slice(0, 8)).toBe(true);
  });
});
