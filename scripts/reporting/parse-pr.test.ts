import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { buildReport } from "./on-merge.js";
import { field, pacificDay, parsePr, section, trailers } from "./parse-pr.js";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const body = (changelog: string, extra = "") =>
  `## What a user can now do\nSomething.\n\n## Changelog\n${changelog}\n\nSection: Search & sharing\n${extra}`;

describe("parse-pr: unit", () => {
  it('trailers "1h30m", "45m", "2h" and "1.5h" add up correctly', () => {
    expect(
      trailers(["Time-Spent: 1h30m\nTime-Spent: 45m", "fix\n\nTime-Spent: 2h", "Time-Spent: 1.5h"]),
    ).toEqual({ minutes: 90 + 45 + 120 + 90, problems: [] });
  });

  it('an entry of "no user-facing change" produces no changelog line', () => {
    expect(parsePr(body("No user-facing change.")).changelog).toBeNull();
    expect(
      parsePr(body("`.changeset/x.md`: (internal) Refactors the runner.")).changelog,
    ).toBeNull();
  });

  it('the "(<time>)" opener is replaced with the real time', () => {
    expect(parsePr(body("(<time>) Checks the 301 map.", "Time-Spent: 1h30m\n")).changelog).toBe(
      "(1h30m) Checks the 301 map.",
    );
  });

  it("a merge at 11:30 PM Pacific is filed under that Pacific day, not the UTC one", () => {
    // 2026-11-05 23:30 PST is 2026-11-06 07:30 UTC.
    expect(pacificDay("2026-11-06T07:30:00Z").day).toBe("2026-11-05");
    expect(pacificDay("2026-11-06T07:30:00Z").week).toBe("2026-W45");
  });

  it("section and field read the body; a changeset-path line keeps only its sentence", () => {
    expect(section("# A\n\n## Changelog\nline\n\n## Next\nx", "Changelog")).toBe("line");
    expect(field("Section: Leads\n", "Section")).toBe("Leads");
    expect(
      parsePr(body("`.changeset/a.md` (gaugeline: minor): Adds the plan check.")).changelog,
    ).toBe("Adds the plan check.");
  });

  it("a placeholder in the Changelog is a problem; real angle brackets are not", () => {
    expect(parsePr(body("(<time>) One line a user would understand.")).problems).toEqual([
      'The Changelog still holds a placeholder: "(<time>) One line a user would understand.".',
    ]);
    expect(parsePr(body('Reads <link rel="canonical"> from the head.')).problems).toEqual([]);
  });
});

const servers: Server[] = [];
const temps: string[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});
async function standIn(
  answer: object,
): Promise<{ url: string; bodies: Record<string, unknown>[] }> {
  const bodies: Record<string, unknown>[] = [];
  const s = createServer((req, res) => {
    let data = "";
    req.on("data", (c: Buffer) => (data += c.toString()));
    req.on("end", () => {
      bodies.push(JSON.parse(data) as Record<string, unknown>);
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(answer));
    });
  });
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  servers.push(s);
  return { url: `http://127.0.0.1:${(s.address() as AddressInfo).port}/exec`, bodies };
}
function eventFile(prBody: string): string {
  const dir = mkdtempSync(join(tmpdir(), "gaugeline-merge-"));
  temps.push(dir);
  const recorded = JSON.parse(
    readFileSync(join(repoRoot, "scripts/reporting/__fixtures__/merged-event.json"), "utf8"),
  ) as { pull_request: { body: string } };
  recorded.pull_request.body = prBody;
  writeFileSync(join(dir, "event.json"), JSON.stringify(recorded));
  return join(dir, "event.json");
}
function onMerge(env: Record<string, string>) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    const child = spawn(
      process.execPath,
      [
        join(repoRoot, "node_modules/tsx/dist/cli.mjs"),
        join(repoRoot, "scripts/reporting/on-merge.ts"),
      ],
      { env: { ...process.env, ...env } },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

describe("on-merge: integration (recorded event, local stand-in for the web app)", () => {
  it("posts one body holding the status entry, the changelog line and the row", async () => {
    const app = await standIn({ ok: true });
    const r = await onMerge({
      REPORT_POST_URL: app.url,
      REPORT_POST_SECRET: "test-secret-value",
      GITHUB_EVENT_PATH: eventFile(body("(<time>) Checks the 301 map.", "Time-Spent: 45m\n")),
    });
    expect(r.code, r.stderr).toBe(0);
    expect(app.bodies).toHaveLength(1);
    expect(app.bodies[0]).toMatchObject({
      id: "pr-42",
      secret: "test-secret-value",
      status: { day: "2026-11-05", week: "2026-W45", entry: "#42 Check the 301 map (45m)" },
      changelog: { section: "Search & sharing", line: "(45m) Checks the 301 map." },
      row: { number: 42, minutes: 45, day: "2026-11-05", section: "Search & sharing" },
    });
    expect(r.stdout).not.toContain("test-secret-value");
  }, 30_000);

  it("with no REPORT_POST_URL, reporting is switched off and nothing is sent", async () => {
    const r = await onMerge({
      REPORT_POST_URL: "",
      REPORT_POST_SECRET: "",
      GITHUB_EVENT_PATH: eventFile(body("Adds a thing.")),
    });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("switched off");
  }, 30_000);

  it("re-running the same merge sends the same id, so the ledger finds it and changes nothing", () => {
    const recorded = JSON.parse(
      readFileSync(join(repoRoot, "scripts/reporting/__fixtures__/merged-event.json"), "utf8"),
    ) as Parameters<typeof buildReport>[0];
    expect(buildReport(recorded)).toEqual(buildReport(recorded));
    expect(buildReport(recorded)?.id).toBe("pr-42");
  });
});

describe("reporting: edge cases", () => {
  it("a body with Windows line endings parses the same", () => {
    const b = body("(<time>) Checks the 301 map.", "Time-Spent: 1h\n");
    expect(parsePr(b.replace(/\n/g, "\r\n"))).toEqual(parsePr(b));
  });

  it("a missing Changelog section is a problem", () => {
    expect(parsePr("## What a user can now do\nThings.\n").problems).toEqual([
      'The body has no "## Changelog" section.',
    ]);
  });

  it("a Section that is not in the list falls back to Reliability", () => {
    expect(parsePr("## Changelog\nFixes a thing.\n\nSection: Marketing magic\n").section).toBe(
      "Reliability",
    );
    expect(parsePr("## Changelog\nFixes a thing.\n").section).toBe("Reliability");
  });

  it("the stand-in answers ok:false and the script exits 1", async () => {
    const app = await standIn({ ok: false, error: "wrong secret" });
    const r = await onMerge({
      REPORT_POST_URL: app.url,
      REPORT_POST_SECRET: "x",
      GITHUB_EVENT_PATH: eventFile(body("Adds a thing.")),
    });
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("wrong secret");
  }, 30_000);

  it("a malformed Time-Spent trailer is a problem, and time is never guessed", () => {
    const parsed = parsePr(body("Adds a thing.", "Time-Spent: a while\n"));
    expect(parsed.minutes).toBe(0);
    expect(parsed.problems).toEqual([
      '"Time-Spent: a while" is not a duration like 1h30m, 45m, 2h or 1.5h.',
    ]);
  });
});
