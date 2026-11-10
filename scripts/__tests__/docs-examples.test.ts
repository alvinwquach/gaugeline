import {
  ASSERTION_CHECKS,
  EMAIL_PRESET,
  FRESHNESS_CHECKS,
  LISTING_CHECKS,
  SWITCH_CHECKS,
  createPageRegistry,
} from "../../packages/core/src/index.js";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  compare,
  extractExamples,
  normalise,
  parseCommand,
  runExample,
  type Example,
} from "../lib/docs-examples.js";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const bin = join(repoRoot, "packages/cli/dist/index.js");
const quickStart = readFileSync(join(repoRoot, "docs/quick-start.md"), "utf8");
const F = "```";
const page = (body: string) => `# Page\n\n${body}\n`;
const temps: string[] = [];
afterEach(() => {
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});

describe("extractExamples: unit", () => {
  it("finds a Terminal block followed by an Output block and records the line numbers", () => {
    const md = page(
      `<!-- fixture: clean -->\n${F}sh title=Terminal\n$ npx gaugeline shop.example\n${F}\n\n${F}text title=Output\nNothing to look at.\n${F}`,
    );
    expect(extractExamples(md, "docs/p.md")).toEqual([
      {
        file: "docs/p.md",
        line: 4,
        outputLine: 8,
        command: "npx gaugeline shop.example",
        fixture: "clean",
        expected: "Nothing to look at.",
        exit: 0,
      },
    ]);
  });

  it('a Terminal block whose first line is not "$ npx gaugeline" is ignored', () => {
    expect(extractExamples(page(`${F}sh title=Terminal\n$ pnpm install\n${F}`), "p.md")).toEqual(
      [],
    );
  });

  it("untested with a reason is skipped; untested with no reason is an error", () => {
    expect(
      extractExamples(
        page(`${F}sh title=Terminal untested="needs Docker"\n$ npx gaugeline x.example\n${F}`),
        "p.md",
      ),
    ).toEqual([]);
    expect(() =>
      extractExamples(
        page(`${F}sh title=Terminal untested\n$ npx gaugeline x.example\n${F}`),
        "p.md",
      ),
    ).toThrow(/p\.md:3: untested needs a reason/);
  });

  it("a Terminal block with no fixture comment is an error naming file and line", () => {
    expect(() =>
      extractExamples(page(`${F}sh title=Terminal\n$ npx gaugeline x.example\n${F}`), "docs/p.md"),
    ).toThrow("docs/p.md:3: this example has no <!-- fixture: name --> comment directly above it.");
  });

  it("an example with neither an Output block nor untested is an error", () => {
    expect(() =>
      extractExamples(
        page(`<!-- fixture: clean -->\n${F}sh title=Terminal\n$ npx gaugeline x.example\n${F}`),
        "p.md",
      ),
    ).toThrow(/no Output block/);
  });
});

describe("normalise: unit", () => {
  it("replaces the origin, the version, ANSI codes and absolute paths, and leaves everything else byte for byte", () => {
    const raw =
      "Gaugeline 0.0.2 checking http://127.0.0.1:4567/\n\u001b[31m✗\u001b[39m Title  \nReport written to /tmp/run-1/gaugeline-report.html\nKeep: 1 of 2 · (x)";
    expect(normalise(raw, "http://127.0.0.1:4567", "shop.example")).toBe(
      "Gaugeline X.Y.Z checking https://shop.example/\n✗ Title\nReport written to ./gaugeline-report.html\nKeep: 1 of 2 · (x)",
    );
    expect(
      normalise("see https://other.example/a/b and /tools", "http://127.0.0.1:1", "shop.example"),
    ).toBe("see https://other.example/a/b and /tools");
  });
});

describe("docs examples: integration", () => {
  it("the quick-start example runs against its fixture and matches the page", async () => {
    const [e] = extractExamples(quickStart, "docs/quick-start.md");
    expect(e?.fixture).toBe("quick-start");
    const r = await runExample(e as Example, bin);
    expect(compare(e as Example, r)).toBeNull();
  }, 30_000);

  it("change one word in a copy of the page: the runner exits 1 and the diff shows that line", () => {
    const dir = mkdtempSync(join(tmpdir(), "gaugeline-docs-ex-"));
    temps.push(dir);
    writeFileSync(
      join(dir, "quick-start.md"),
      quickStart.replace("1 to look at, 1 to fix first.", "1 to look at, 1 to fix soon."),
    );
    const r = spawnSync(
      process.execPath,
      [
        join(repoRoot, "node_modules/tsx/dist/cli.mjs"),
        join(repoRoot, "scripts/docs-examples.ts"),
        dir,
      ],
      {
        cwd: "/",
        encoding: "utf8",
      },
    );
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("-1 to look at, 1 to fix soon.");
    expect(r.stderr).toContain("+1 to look at, 1 to fix first.");
    expect(r.stderr).toMatch(/quick-start\.md:\d+ \(expected\)/);
  }, 60_000);

  it("an example with --json is compared as parsed JSON, key order ignored", async () => {
    // The sample counts are the run's own (G13a); what is under test is the key-order-free compare.
    const probe: Example = {
      file: "p.md",
      line: 1,
      outputLine: 2,
      command: "npx gaugeline shop.example --json",
      fixture: "quick-start",
      exit: 0,
      expected: "{}",
    };
    const ran = await runExample(probe, bin);
    const sampled = (JSON.parse(ran.stdout) as { sampled: unknown }).sampled;
    const e: Example = {
      file: "p.md",
      line: 1,
      outputLine: 2,
      command: "npx gaugeline shop.example --json",
      fixture: "quick-start",
      exit: 0,
      expected: JSON.stringify({
        // Without --dns the mail record checks are not run, and listed as such.
        failed: [...EMAIL_PRESET],
        // 0.1.0 runs every other check: all but canonical-elsewhere pass on this fixture.
        passed: createPageRegistry()
          .all()
          .map((c) => c.id)
          .filter(
            (id) =>
              id !== "canonical-elsewhere" &&
              !EMAIL_PRESET.includes(id) &&
              // Not run without a gaugeline.listings.json: neither passed nor failed.
              !LISTING_CHECKS.includes(id) &&
              // Likewise without data assertions in gaugeline.sources.json.
              !ASSERTION_CHECKS.includes(id) &&
              // And without gaugeline.switches.json.
              !SWITCH_CHECKS.includes(id) &&
              // And without gaugeline.freshness.json.
              !FRESHNESS_CHECKS.includes(id),
          ),
        startedAt: "2020-02-02T02:02:02.000Z",
        url: "https://shop.example/",
        schema: 2,
        couldNotCheck: [],
        sampled,
        findings: [
          {
            url: "https://shop.example/",
            title: "This page tells Google to show a different page",
            severity: "high",
            evidence:
              '<link rel="canonical" href="https://shop.example/tools"> on https://shop.example/ (differs by path)',
            checkId: "canonical-elsewhere",
          },
        ],
      }),
    };
    expect(compare(e, await runExample(e, bin))).toBeNull();
  }, 30_000);
});

describe("docs examples: promise test", () => {
  it("every example makes only GET and HEAD requests to its fixture, at most 5 at once", async () => {
    const [e] = extractExamples(quickStart, "docs/quick-start.md");
    const r = await runExample(e as Example, bin);
    expect([...r.methods.keys()].every((m) => m === "GET" || m === "HEAD")).toBe(true);
    expect(r.maxConcurrent).toBeLessThanOrEqual(5);
  }, 30_000);

  it("no example output contains the value of any GAUGELINE_ environment variable set for the run", async () => {
    const [e] = extractExamples(quickStart, "docs/quick-start.md");
    const r = await runExample(e as Example, bin, { GAUGELINE_TEST_SECRET: "MARKER_EXAMPLE_5a1b" });
    expect(r.stdout + r.stderr).not.toContain("MARKER_EXAMPLE_5a1b");
  }, 30_000);
});

describe("docs examples: edge cases", () => {
  it("an environment variable prefix is parsed into the child environment and pointed at a local sink", async () => {
    expect(
      parseCommand(
        "GAUGELINE_SLACK_WEBHOOK=https://hooks.slack.example/T0 npx gaugeline shop.example --ci",
      ),
    ).toEqual({
      env: { GAUGELINE_SLACK_WEBHOOK: "https://hooks.slack.example/T0" },
      address: "shop.example",
      args: ["--ci"],
    });
    const e: Example = {
      file: "p.md",
      line: 1,
      outputLine: 2,
      command: "GAUGELINE_SLACK_WEBHOOK=https://hooks.slack.example/T0 npx gaugeline shop.example",
      fixture: "quick-start",
      exit: 0,
      expected: "",
    };
    const r = await runExample(e, bin);
    expect(r.env.GAUGELINE_SLACK_WEBHOOK).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/sink$/);
  }, 30_000);

  it("two Terminal blocks before one Output block is an error: the pairing is ambiguous", () => {
    const md = page(
      `<!-- fixture: clean -->\n${F}sh title=Terminal\n$ npx gaugeline a.example\n${F}\n\n<!-- fixture: clean -->\n${F}sh title=Terminal\n$ npx gaugeline b.example\n${F}\n\n${F}text title=Output\nx\n${F}`,
    );
    expect(() => extractExamples(md, "p.md")).toThrow(
      /two Terminal blocks come before one Output block/,
    );
  });

  it("an expected exit code other than 0 is declared with <!-- exit: 1 --> and asserted", async () => {
    const md = page(
      `<!-- fixture: quick-start -->\n<!-- exit: 1 -->\n${F}sh title=Terminal\n$ npx gaugeline shop.example --ci\n${F}\n\n${F}text title=Output\n✗ This page tells Google to show a different page\n    <link rel="canonical" href="https://shop.example/tools"> on https://shop.example/ (differs by path)\n? 4 checks could not run: email-spf-missing, email-spf-multiple, email-dmarc-missing, email-dmarc-none\n    Mail records are read from DNS only with --dns. Rerun with --dns to check them.\n\n1 to look at, 1 to fix first.\n${F}`,
    );
    const [e] = extractExamples(md, "p.md");
    expect(e?.exit).toBe(1);
    expect(compare(e as Example, await runExample(e as Example, bin))).toBeNull();
    expect(compare({ ...(e as Example), exit: 0 }, await runExample(e as Example, bin))).toMatch(
      /expected exit 0, got 1/,
    );
  }, 30_000);

  it("a page with CRLF line endings extracts the same examples", () => {
    expect(extractExamples(quickStart.replace(/\n/g, "\r\n"), "q.md")).toEqual(
      extractExamples(quickStart, "q.md"),
    );
  });

  it("a fixture that does not exist is an error that lists the available fixture names", async () => {
    const e: Example = {
      file: "p.md",
      line: 3,
      outputLine: 4,
      command: "npx gaugeline shop.example",
      fixture: "no-such-fixture",
      exit: 0,
      expected: "",
    };
    await expect(runExample(e, bin)).rejects.toThrow(
      /no fixture "no-such-fixture"\. Available: .*clean.*quick-start/,
    );
  });
});
