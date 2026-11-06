import { Buffer } from "node:buffer";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SITES_DIR, expectedOutput, startFixture } from "@gaugeline/fixtures";
import { afterEach, describe, expect, it } from "vitest";
import { main } from "../main.js";

const withoutPassed = (text: string) => text.replace(/^✓ [a-z0-9-]+\n/gm, "");

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
function workdir(from = "plan-progress"): string {
  const dir = mkdtempSync(join(tmpdir(), "gaugeline-progress-"));
  dirs.push(dir);
  cpSync(join(SITES_DIR, from, "plan.csv"), join(dir, "plan.csv"));
  return dir;
}

/** One `gaugeline plan plan.csv --base <week> --progress` run on the given day. */
async function week(name: string, dir: string, day: string, extra: string[] = [], env = {}) {
  const site = await startFixture(name);
  try {
    const run = capture(env);
    const code = await main(
      ["plan", "plan.csv", "--base", site.origin, "--allow-private", "--progress", ...extra],
      run.io,
      { cwd: dir, now: () => new Date(`${day}T09:00:00Z`) },
    );
    return { code, out: run.out(), err: run.err() };
  } finally {
    await site.close();
  }
}

const STATE = (dir: string) => join(dir, ".gaugeline", "plan-state.json");

describe("gaugeline plan --progress: e2e (CLI)", () => {
  it("two runs on a preview filling in: the second says (was 6), lists 3 fixed, and both exit 1", async () => {
    const dir = workdir();
    const one = await week("plan-progress-week1", dir, "2026-10-03");
    expect(one.code).toBe(1);
    expect(one.out.trimEnd().split("\n").at(-1)).toBe(
      "6 of 10 rows match the plan. First run: 4 open.",
    );
    expect(existsSync(STATE(dir))).toBe(true);

    const two = await week("plan-progress-week2", dir, "2026-10-10");
    expect(two.code).toBe(1);
    expect(two.out).toContain("(was 6)");
    expect(withoutPassed(two.out).trimEnd()).toBe(
      expectedOutput("plan-check", "Watching a preview fill in"),
    );
  });

  it("a title broken between runs is the one finding shown in full; --all lists the still-open one too", async () => {
    const dir = workdir();
    await week("plan-progress-week2", dir, "2026-10-10");
    const three = await week("plan-progress-week3", dir, "2026-10-17");
    expect(three.out).toContain("! A title tag isn't what the plan says\n");
    expect(three.out).not.toContain("/gift-cards returned 404");
    expect(three.out).toContain("1 still open: add --all to list it.");
    expect(three.out.trimEnd().split("\n").at(-1)).toBe(
      "8 of 10 rows match the plan (was 9). 0 fixed since 10 Oct, 1 new, 1 still open.",
    );
    const all = await week("plan-progress-week3", dir, "2026-10-18", ["--all"]);
    expect(all.out).toContain("/gift-cards returned 404 on the preview");
    expect(all.out).toContain('/shop: the plan says "Shop | Kiln Lane"');
  });

  it("--progress needs --base; without --progress nothing is read or written", async () => {
    const dir = workdir();
    const run = capture();
    expect(await main(["plan", "plan.csv", "--progress"], run.io, { cwd: dir })).toBe(2);
    expect(run.err()).toContain(
      "--progress compares runs of the plan against a preview: add --base.",
    );
    const site = await startFixture("plan-progress-week1");
    try {
      await main(["plan", "plan.csv", "--base", site.origin, "--allow-private"], capture().io, {
        cwd: dir,
      });
    } finally {
      await site.close();
    }
    expect(existsSync(join(dir, ".gaugeline"))).toBe(false);
  });
});

describe("gaugeline plan --progress: edge cases", () => {
  it("a state file from a later schema: exit 2, a message, and the file is not overwritten", async () => {
    const dir = workdir();
    mkdirSync(join(dir, ".gaugeline"));
    const later = JSON.stringify({ schema: 2, future: true });
    writeFileSync(STATE(dir), later);
    const r = await week("plan-progress-week1", dir, "2026-10-03");
    expect(r.code).toBe(2);
    expect(r.err).toContain("was written by a later version of Gaugeline (schema 2)");
    expect(readFileSync(STATE(dir), "utf8")).toBe(later);
  });

  it("corrupt JSON: a warning, the bad file kept as .bak, and a first run", async () => {
    const dir = workdir();
    mkdirSync(join(dir, ".gaugeline"));
    writeFileSync(STATE(dir), "{ not json");
    const r = await week("plan-progress-week1", dir, "2026-10-03");
    expect(r.err).toContain("could not be read: treated as the first run. The old file is kept as");
    expect(readFileSync(`${STATE(dir)}.bak`, "utf8")).toBe("{ not json");
    expect(r.out).toContain("First run: 4 open.");
  });

  it("a run that ended could-not-check writes no state", async () => {
    const dir = workdir("plan-built");
    writeFileSync(join(dir, "plan.csv"), "URL,H1\n/,Harbour Pottery\n/members,Members\n");
    const r = await week("preview-basic-auth", dir, "2026-10-03", [], {
      GAUGELINE_BASIC_AUTH: "harbour:glaze-and-fire",
    });
    expect(r.code).toBe(2);
    expect(r.err).toContain("No progress saved");
    expect(existsSync(STATE(dir))).toBe(false);
  });

  it("a state file at a given path, relative to where the command runs", async () => {
    const dir = workdir();
    await week("plan-progress-week1", dir, "2026-10-03", ["state/week.json"]);
    expect(existsSync(join(dir, "state", "week.json"))).toBe(true);
    expect(existsSync(STATE(dir))).toBe(false);
  });
});

describe("gaugeline plan --progress: promise test", () => {
  it("the state file holds no page text, no Authorization value and no bypass token", async () => {
    const dir = workdir("plan-built");
    const secret = "harbour:glaze-and-fire";
    await week("preview-basic-auth", dir, "2026-10-03", [], {
      GAUGELINE_BASIC_AUTH: secret,
      GAUGELINE_PREVIEW_HEADER: "X-Canary-Token: canary-bypass-0042",
    });
    const text = readFileSync(STATE(dir), "utf8");
    for (const canary of [
      secret,
      "glaze-and-fire",
      Buffer.from(secret, "utf8").toString("base64"),
      "canary-bypass-0042",
      "An invented page of an invented pottery shop",
      "Shop – Harbour Pottery",
    ])
      expect(text).not.toContain(canary);
    expect(Object.keys(JSON.parse(text) as object).sort()).toEqual([
      "at",
      "base",
      "open",
      "planHash",
      "rowsMatching",
      "rowsTotal",
      "schema",
    ]);
  });
});
