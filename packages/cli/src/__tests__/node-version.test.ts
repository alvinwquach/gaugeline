import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { MIN_NODE_MAJOR, nodeVersionProblem } from "../node-version.js";
import { runBin } from "./helpers/bin.js";

const fake = fileURLToPath(new URL("./helpers/fake-node-version.cjs", import.meta.url));

/** Run the built bin as if it were on the given Node version. */
function onNode(version: string, args: string[] = ["https://example.test"]) {
  return runBin(args, {
    NODE_OPTIONS: `--require ${fake}`,
    GAUGELINE_TEST_NODE_VERSION: version,
  });
}

describe("node version guard: unit", () => {
  it("accepts Node 22 and newer", () => {
    expect(MIN_NODE_MAJOR).toBe(22);
    for (const v of ["22.0.0", "22.23.4", "24.0.0", "24.22.2", "26.1.0"]) {
      expect(nodeVersionProblem(v), v).toBeUndefined();
    }
  });

  it("refuses older versions with one line that names both versions", () => {
    for (const v of ["18.17.0", "20.18.0", "21.7.3", "16.20.2"]) {
      const msg = nodeVersionProblem(v);
      expect(msg, v).toBe(`Gaugeline needs Node 22 or newer. This is Node ${v}.`);
      expect(msg).not.toContain("\n");
    }
  });

  it("refuses a version string it cannot read", () => {
    expect(nodeVersionProblem("")).toMatch(/needs Node 22 or newer/);
    expect(nodeVersionProblem("banana")).toMatch(/needs Node 22 or newer/);
  });
});

describe("node version guard: built bin", () => {
  it("exits 2 with a one-line message on stderr under Node 20", async () => {
    const r = await onNode("20.18.0");
    expect(r.status).toBe(2);
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe("Gaugeline needs Node 22 or newer. This is Node 20.18.0.\n");
  });

  it("exits 2 under Node 18.17 even for --help and --version", async () => {
    for (const flag of ["--help", "--version"]) {
      const r = await onNode("18.17.0", [flag]);
      expect(r.status, flag).toBe(2);
      expect(r.stderr.trim().split("\n")).toHaveLength(1);
    }
  });

  it("does not stop the real Node it is running on", async () => {
    const r = await runBin(["--version"]);
    expect(r.status).toBe(0);
  });
});
