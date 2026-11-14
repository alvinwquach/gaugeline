import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import {
  emptyBlocked,
  resultSchema,
  type A11yRead,
  type RenderRequest,
  type RenderedPage,
  type Renderer,
  type Transport,
} from "@gaugeline/core";
import { describe, expect, it } from "vitest";
import { SITES_DIR } from "../../../fixtures/src/index.js";
import { staticSite } from "../../../testkit/src/index.js";
import { EXIT, main } from "../main.js";

/**
 * The rendered accessibility checks (N16), in memory: the invented Corner Pantry shop answers from its fixture
 * folder and the browser is a stand-in that answers with invented facts (the real browser is in
 * packages/renderer/src/__tests__/a11y.e2e.test.ts).
 */
const HOST = "corner-pantry.example";
const HOME = `https://${HOST}/`;
const IDS = [
  "a11y-contrast",
  "a11y-focus-order",
  "a11y-landmarks",
  "a11y-names-roles",
  "a11y-reduced-motion",
];

const FACTS: A11yRead = {
  text: [
    {
      tag: "p",
      text: "Jam, bread and tea",
      fg: [204, 204, 204, 1],
      bg: [255, 255, 255],
      px: 16,
      bold: false,
    },
    {
      tag: "p",
      text: "Open every day",
      fg: [0, 0, 0, 1],
      bg: [255, 255, 255],
      px: 16,
      bold: false,
    },
  ],
  textOmitted: 0,
  focusables: [
    { tag: "a", role: "link", name: "Order", tabindex: 2, x: 0, y: 300 },
    { tag: "a", role: "link", name: "Menu", tabindex: null, x: 0, y: 10 },
    { tag: "button", role: "button", name: "", tabindex: null, x: 0, y: 40 },
  ],
  unreachable: [],
  landmarks: [{ role: "navigation", name: "" }],
  motion: { animations: 2, endless: 1, reducedMotionRule: false, unreadableSheets: 0 },
};

function fakeRenderer(log: RenderRequest[], a11y: A11yRead | undefined = FACTS): Renderer {
  return {
    name: "playwright",
    availability: () =>
      Promise.resolve({ kind: "available", detail: "Chromium at /fake (system)" }),
    render: (request) => {
      log.push(request);
      const page: RenderedPage = {
        kind: "rendered",
        finalUrl: HOME,
        status: 200,
        title: "Corner Pantry" as never,
        requests: [],
        blocked: emptyBlocked(),
        totals: { requests: 1, bytes: 1 },
        truncated: [],
        ...(request.expose?.a11y && a11y ? { a11y } : {}),
      };
      return Promise.resolve(page);
    },
    close: () => Promise.resolve(),
  };
}

async function run(argv: string[], a11y?: A11yRead) {
  const log: RenderRequest[] = [];
  const others: Transport = () =>
    Promise.resolve({ status: 404, headers: {}, body: Readable.from([Buffer.from("not found")]) });
  const site = staticSite(HOST, join(SITES_DIR, "old-theme-shop"), others);
  const out: string[] = [];
  const err: string[] = [];
  const code = await main(
    argv,
    {
      stdout: { write: (s) => out.push(s) },
      stderr: { write: (s) => err.push(s) },
      env: { NO_COLOR: "1" },
    },
    {
      cwd: mkdtempSync(join(tmpdir(), "gaugeline-a11y-")),
      fetcher: { transport: site },
      renderer: () => fakeRenderer(log, a11y),
    } as never,
  );
  return { code, out: out.join(""), err: err.join(""), log };
}

const ours = (text: string) => {
  const result = resultSchema.parse(JSON.parse(text));
  return {
    findings: result.findings.filter((f) => IDS.includes(f.checkId)),
    couldNotCheck: result.couldNotCheck.filter((c) => IDS.includes(c.id)),
  };
};

describe("gaugeline check --renderer playwright: the accessibility checks, end to end (in memory)", () => {
  it("reports faint text, a positive tabindex, an unnamed button, no main landmark and motion with no rule", async () => {
    const r = await run([HOST, "--renderer", "playwright", "--json", "--no-open", "--quiet"]);
    expect(r.code).toBe(EXIT.ok);
    const got = ours(r.out);
    expect(got.findings.map((f) => [f.checkId, f.severity]).sort()).toEqual([
      ["a11y-contrast", "medium"],
      ["a11y-focus-order", "medium"],
      ["a11y-landmarks", "medium"],
      ["a11y-names-roles", "medium"],
      ["a11y-reduced-motion", "medium"],
    ]);
    const by = Object.fromEntries(got.findings.map((f) => [f.checkId, f.evidence]));
    expect(by["a11y-contrast"]).toBe(
      '1 text element falls short of WCAG contrast: "Jam, bread and tea" at 1.60:1 (needs 4.5:1, #cccccc on #ffffff)',
    );
    expect(by["a11y-focus-order"]).toBe(
      'Positive tabindex values reorder keyboard focus: tabindex 2 on "Order".',
    );
    expect(by["a11y-names-roles"]).toBe(
      "1 control the keyboard reaches has no accessible name: <button>.",
    );
  });

  it("asks the renderer once, for the accessibility facts and nothing else, and never a plain render", async () => {
    const r = await run([HOST, "--renderer", "playwright", "--json", "--no-open", "--quiet"]);
    expect(r.log.map((q) => q.expose)).toEqual([{ a11y: true, text: false, links: false }]);
  });

  it("is not in the run without --renderer: no check, no could-not-check line, nothing rendered", async () => {
    const r = await run([HOST, "--json", "--no-open", "--quiet"]);
    expect(ours(r.out)).toEqual({ findings: [], couldNotCheck: [] });
    expect(r.log).toEqual([]);
  });

  it("a medium finding never fails --ci, and a page with good facts has none", async () => {
    const r = await run([
      HOST,
      "--renderer",
      "playwright",
      "--ci",
      "--json",
      "--no-open",
      "--quiet",
    ]);
    expect(r.code).toBe(EXIT.ok);
    const good: A11yRead = {
      text: [FACTS.text[1]!],
      textOmitted: 0,
      focusables: [{ tag: "a", role: "link", name: "Menu", tabindex: null, x: 0, y: 10 }],
      unreachable: [],
      landmarks: [{ role: "main", name: "" }],
      motion: { animations: 0, endless: 0, reducedMotionRule: false, unreadableSheets: 0 },
    };
    const clean = await run(
      [HOST, "--renderer", "playwright", "--json", "--no-open", "--quiet"],
      good,
    );
    expect(ours(clean.out)).toEqual({ findings: [], couldNotCheck: [] });
  });

  it("says could not check, five times, when the browser gives no facts", async () => {
    const log: RenderRequest[] = [];
    const out: string[] = [];
    const others: Transport = () =>
      Promise.resolve({ status: 404, headers: {}, body: Readable.from([Buffer.from("x")]) });
    await main(
      [HOST, "--renderer", "playwright", "--json", "--no-open", "--quiet"],
      {
        stdout: { write: (s) => out.push(s) },
        stderr: { write: () => true },
        env: { NO_COLOR: "1" },
      },
      {
        cwd: mkdtempSync(join(tmpdir(), "gaugeline-a11y-")),
        fetcher: { transport: staticSite(HOST, join(SITES_DIR, "old-theme-shop"), others) },
        renderer: () => ({
          ...fakeRenderer(log),
          render: () => Promise.resolve({ kind: "could-not-check", reason: "no browser" } as never),
        }),
      } as never,
    );
    const got = ours(out.join(""));
    expect(got.findings).toEqual([]);
    expect(got.couldNotCheck.map((c) => c.id).sort()).toEqual(IDS);
  });
});

const page = readFileSync(
  fileURLToPath(new URL("../../../../docs/guides/rendered-accessibility.md", import.meta.url)),
  "utf8",
).replace(/\r\n/g, "\n");
const block = (title: string): string[] =>
  (
    new RegExp('```[a-z]* title="?' + title + '[^"\\n]*"?\\n([\\s\\S]*?)\\n```').exec(page)?.[1] ??
    ""
  )
    .split("\n")
    .filter((l) => l !== "");

describe("docs/guides/rendered-accessibility.md: the command it shows", () => {
  it("prints the lines the page shows (the browser is a stand-in with the page's invented facts)", async () => {
    const r = await run([HOST, "--renderer", "playwright", "--no-open"]);
    const printed = r.out.split("\n");
    const shown = block("Output");
    expect(shown.length).toBeGreaterThan(5);
    for (const line of shown) expect(printed, line).toContain(line);
  });

  it("names the five checks and the flag", () => {
    for (const id of IDS) expect(page).toContain(id);
    expect(page).toContain("--renderer playwright");
  });
});
