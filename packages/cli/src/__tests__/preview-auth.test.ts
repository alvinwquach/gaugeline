import { Buffer } from "node:buffer";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SITES_DIR, expectedOutput, startFixture } from "@gaugeline/fixtures";
import { afterEach, describe, expect, it } from "vitest";
import { main, REPORT_FILE } from "../main.js";

const BASIC = "harbour:glaze-and-fire";
const BYPASS = "gaugeline-fixture-bypass-0001";

function capture(env: Record<string, string> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: {
      stdout: { write: (s: string) => out.push(s) },
      stderr: { write: (s: string) => err.push(s) },
      env: { NO_COLOR: "1", ...env },
    },
    out: () => out.join(""),
    err: () => err.join(""),
  };
}

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function workdir(): string {
  const dir = mkdtempSync(join(tmpdir(), "gaugeline-auth-"));
  dirs.push(dir);
  cpSync(join(SITES_DIR, "plan-built", "plan.csv"), join(dir, "plan.csv"));
  return dir;
}

describe("a protected preview: e2e (CLI)", () => {
  it("gaugeline plan plan.csv --base against the basic-auth fixture: exit 2, stderr names GAUGELINE_BASIC_AUTH, no findings", async () => {
    const site = await startFixture("preview-basic-auth");
    try {
      const dir = workdir();
      const run = capture();
      const args = ["plan", "plan.csv", "--base", site.origin, "--allow-private"];
      expect(await main(args, run.io, { cwd: dir })).toBe(2);
      expect(run.err()).toContain(
        `Could not check: the preview at ${site.origin} asked for a password (401, Basic).`,
      );
      expect(run.err()).toContain("Set GAUGELINE_BASIC_AUTH to user:password.");
      expect(run.out()).not.toMatch(/plan-404|plan-title-drift/);
      // The docs show this stderr, with the preview's address in place of the fixture's port.
      const shown = run
        .err()
        .replaceAll(site.origin, "https://preview.yoursite.com")
        .split("\n")
        .filter((l) => !l.startsWith("Keyword checks skipped"))
        .join("\n")
        .trimEnd();
      expect(shown).toBe(expectedOutput("plan-check", "A preview behind a password"));

      // With the variable, the 10-row plan is checked: the five planted findings, exit 1.
      const open = capture({ GAUGELINE_BASIC_AUTH: BASIC });
      expect(await main(args, open.io, { cwd: dir })).toBe(1);
      expect(open.err()).toContain(
        `Reading 8 planned addresses on ${site.origin} (basic auth (set))`,
      );
      expect(open.err()).toContain(
        `basic auth (set) is sent in clear text to ${site.origin} (allowed on this machine only).`,
      );
      expect(open.out()).toContain("/gallery returned 404 on the preview");
    } finally {
      await site.close();
    }
  });

  it("a password flag is refused with the variable to set, and its value is not echoed", async () => {
    for (const [flag, variable] of [
      ["--password=hunter2-canary", "GAUGELINE_BASIC_AUTH"],
      ["--vercel-bypass=hunter2-canary", "GAUGELINE_VERCEL_BYPASS"],
      ["--token=hunter2-canary", "GAUGELINE_PREVIEW_HEADER"],
    ] as const) {
      const run = capture();
      expect(await main(["plan", "plan.csv", flag], run.io, { cwd: workdir() })).toBe(2);
      expect(run.err()).toContain(`Set ${variable} in the environment instead.`);
      expect(run.out() + run.err()).not.toContain("hunter2-canary");
    }
  });

  it("the probe passes and one planned page returns 401 (a members area): could-not-check, exit 2", async () => {
    const site = await startFixture("preview-basic-auth");
    try {
      const dir = workdir();
      writeFileSync(
        join(dir, "members.csv"),
        "URL,H1\n/,Harbour Pottery\n/members,Members\n/shop,Shop\n",
      );
      const run = capture({ GAUGELINE_BASIC_AUTH: BASIC });
      expect(
        await main(["plan", "members.csv", "--base", site.origin, "--allow-private"], run.io, {
          cwd: dir,
        }),
      ).toBe(2);
      expect(run.out()).toMatch(
        /^\? plan-404 could not be checked: asked for a password \(401\) \(.*\/members\)$/m,
      );
      expect(run.out()).not.toMatch(/plan-404.*\n.*\/members returned/);
    } finally {
      await site.close();
    }
  });
});

describe("a protected preview: promise test (no secret leaves the request)", () => {
  const cases = [
    ["preview-basic-auth", { GAUGELINE_BASIC_AUTH: BASIC }, [BASIC, "glaze-and-fire"]],
    ["preview-vercel", { GAUGELINE_VERCEL_BYPASS: BYPASS }, [BYPASS]],
    [
      "preview-vercel",
      { GAUGELINE_PREVIEW_HEADER: `x-vercel-protection-bypass: ${BYPASS}` },
      [BYPASS],
    ],
  ] as const;

  for (const [name, env, values] of cases) {
    const variable = Object.keys(env)[0] ?? "";
    it(`${variable}: the value and its base64 are in no output, report or JSON; only GET and HEAD`, async () => {
      const site = await startFixture(name);
      try {
        const dir = workdir();
        const canaries = values.flatMap((v) => [v, Buffer.from(v, "utf8").toString("base64")]);
        const texts: string[] = [];

        const plan = capture(env);
        await main(
          ["plan", "plan.csv", "--base", site.origin, "--allow-private", "--annotate", "--verbose"],
          plan.io,
          { cwd: dir },
        );
        texts.push(plan.out(), plan.err(), readFileSync(join(dir, "plan.gaugeline.csv"), "utf8"));

        const check = capture(env);
        await main([site.origin, "--allow-private", "--no-open", "--verbose"], check.io, {
          cwd: dir,
        });
        texts.push(check.out(), check.err(), readFileSync(join(dir, REPORT_FILE), "utf8"));

        const json = capture(env);
        await main([site.origin, "--allow-private", "--json"], json.io, { cwd: dir });
        texts.push(json.out(), json.err());
        // The check really ran with the secret: the preview's pages, not its login.
        expect(JSON.parse(json.out()).url).toBe(`${site.origin}/`);

        for (const text of texts) for (const c of canaries) expect(text).not.toContain(c);
        expect([...site.methods.keys()].filter((m) => m !== "GET" && m !== "HEAD")).toEqual([]);
        // The secret did go out: every request after the first carries it.
        expect(site.requests.length).toBeGreaterThan(10);
      } finally {
        await site.close();
      }
    });
  }

  it("the protection page itself is read with GET only", async () => {
    const site = await startFixture("preview-vercel");
    try {
      const run = capture();
      expect(
        await main(["plan", "plan.csv", "--base", site.origin, "--allow-private"], run.io, {
          cwd: workdir(),
        }),
      ).toBe(2);
      expect(run.err()).toContain("(Vercel deployment protection)");
      expect(run.err()).toContain("Set GAUGELINE_VERCEL_BYPASS");
      expect([...site.methods.keys()]).toEqual(["GET"]);
    } finally {
      await site.close();
    }
  });
});
