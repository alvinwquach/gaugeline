import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { main } from "../main.js";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const page = readFileSync(join(root, "docs/agent-evals.md"), "utf8").replace(/\r\n/g, "\n");
const outputs = [...page.matchAll(/```text title="Output"\n([\s\S]*?)```/g)].map((m) => m[1] ?? "");

let dir: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "gaugeline-evals-docs-")));
});
afterEach(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));

describe("docs/agent-evals.md: the gaugeline evals example is real output", () => {
  it("the page's command prints exactly the page's output, writes the file, and exits 0", async () => {
    expect(page).toContain("$ npx gaugeline evals\n");
    const out: string[] = [];
    const err: string[] = [];
    const code = await main(
      ["evals"],
      {
        stdout: { write: (s: string) => out.push(s) },
        stderr: { write: (s: string) => err.push(s) },
        env: { NO_COLOR: "1" },
      },
      { cwd: dir },
    );
    expect(code).toBe(0);
    expect(outputs).toContain(out.join(""));
    expect(err.join("")).toBe("Report written to gaugeline-evals.json\n");
    expect(page).toContain("`Report written to gaugeline-evals.json` on stderr");
  });
});

describe("docs/agent-evals.md: what it promises", () => {
  it("says there is no live mode, never in CI, and that a model's opinion is never a pass", () => {
    expect(page).toContain("**There is no live-model mode.**");
    expect(page).toMatch(/never run\s+in CI/);
    expect(page).toMatch(/`advisory` or\s+`unsure` and never a pass/);
    expect(page).toMatch(/no key is read\s+and nothing is sent anywhere/);
  });

  it("lists every flag of the command", async () => {
    const { FLAGS, flagsFor } = await import("../flags.js");
    for (const f of flagsFor(FLAGS, "evals").filter((x) => !x.hidden && x.commands[0] === "evals"))
      expect(page, f.name).toContain(`\`--${f.name}`);
    for (const name of ["out", "force"]) expect(page, name).toContain(`\`--${name}`);
  });
});
