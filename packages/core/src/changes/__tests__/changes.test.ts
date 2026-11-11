import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { createSanityAdapter } from "../../adapters/sanity.js";
import { createFetcher, type Transport } from "../../fetcher.js";
import { buildSnapshot } from "../../snapshot.js";
import { attribute } from "../attribute.js";
import { changesConfigSchema } from "../config.js";
import { newFindings, parseSince, pruneRuns, runId } from "../history.js";
import { buildPageRecord, diffRecords } from "../record.js";
import { buildChanges, formatChanges, warrantyNote } from "../report.js";
import { createChangeSources } from "../sources.js";
import type { ChangeLabel, Deploy, PageRecord, Revision, RunRecord, SourceRead } from "../types.js";

const html = (body: string, head = "<title>Events</title>") =>
  `<html><head>${head}</head><body><header><nav><a href="/menu">Menu</a></nav></header><main>${body}</main><footer>Open 5pm</footer></body></html>`;
const pageOf = (body: string, head?: string) =>
  buildPageRecord(
    buildSnapshot([
      {
        url: "https://harbourbar.example/events",
        status: 200,
        headers: { "content-type": "text/html" },
        body: html(body, head),
        ms: 1,
      },
    ]),
  );

const before = pageOf('<h1>Events</h1><p>Quiz night</p><a href="/book">Book a table</a>');

describe("snapshot diff: unit", () => {
  it("title changed", () => {
    const now = pageOf(
      '<h1>Events</h1><p>Quiz night</p><a href="/book">Book a table</a>',
      "<title>Whats on</title>",
    );
    expect(diffRecords(before, now)).toEqual([
      { field: "title", detail: 'title changed from "Events" to "Whats on"' },
    ]);
  });
  it("a button link removed from the main content", () => {
    const now = pageOf("<h1>Events</h1><p>Quiz night</p>");
    const d = diffRecords(before, now);
    expect(d.map((c) => c.field)).toEqual(["content", "links"]);
    expect(d[1]?.detail).toBe("link removed: /book");
  });
  it("a structured data type dropped", () => {
    const withLd = pageOf(
      "<h1>Events</h1>",
      `<title>Events</title><script type="application/ld+json">{"@type":"Event","name":"Quiz"}</script>`,
    );
    const without = pageOf("<h1>Events</h1>");
    expect(diffRecords(withLd, without)).toEqual([
      { field: "structured data", detail: "structured data type removed: Event" },
    ]);
  });
  it("an unchanged page, and a menu or footer edit, are no change", () => {
    expect(
      diffRecords(
        before,
        pageOf('<h1>Events</h1><p>Quiz night</p><a href="/book">Book a table</a>'),
      ),
    ).toEqual([]);
  });
  it("keeps a hash and paths, never the page text", () => {
    const json = JSON.stringify(before);
    expect(json).not.toContain("Quiz night");
    expect(before.mainHash).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe("attribution table: unit", () => {
  const after = "2026-10-03T10:00:00.000Z";
  const upTo = "2026-10-03T16:00:00.000Z";
  const rev = { documentId: "events-page", time: "2026-10-03T14:00:00.000Z", editor: "Sam Ortiz" };
  const dep = { id: "dpl_2", createdAt: "2026-10-03T12:00:00.000Z", commit: "bbbbbbb1111" };
  const old = { id: "dpl_1", createdAt: "2026-10-01T12:00:00.000Z", commit: "aaaaaaa0000" };
  const rows: [string, SourceRead<Revision>, SourceRead<Deploy>, ChangeLabel][] = [
    [
      "revision only",
      { state: "read", items: [rev] },
      { state: "read", items: [] },
      "content-edit",
    ],
    [
      "deploy only",
      { state: "read", items: [] },
      { state: "read", items: [old, dep] },
      "code-deploy",
    ],
    ["both", { state: "read", items: [rev] }, { state: "read", items: [old, dep] }, "both"],
    ["neither", { state: "read", items: [] }, { state: "read", items: [old] }, "unknown"],
  ];
  it.each(rows)("%s", (_n, revisions, deploys, label) => {
    const a = attribute({ after, upTo, revisions, deploys });
    expect(a.label).toBe(label);
  });
  it("a deploy's commit range runs from the deploy live at the earlier run", () => {
    const a = attribute({
      after,
      upTo,
      revisions: { state: "read", items: [] },
      deploys: { state: "read", items: [old, dep] },
    });
    expect(a.commitRange).toBe("aaaaaaa..bbbbbbb");
  });
  it("an edit outside the window does not count", () => {
    const a = attribute({
      after,
      upTo,
      revisions: { state: "read", items: [{ ...rev, time: "2026-10-04T00:00:00.000Z" }] },
      deploys: { state: "not-configured" },
    });
    expect(a.label).toBe("unknown");
  });
  it("a source that could not be read never rules the other kind out", () => {
    const a = attribute({
      after,
      upTo,
      revisions: { state: "could-not-check", reason: "Sanity refused the token" },
      deploys: { state: "read", items: [dep] },
    });
    expect(a.label).toBe("unknown");
    expect(a.reasons.join(" ")).toContain("Sanity refused the token");
    expect(a.reasons.join(" ")).toContain("not ruled out");
  });
  it("nothing configured at all is unknown with that reason", () => {
    const a = attribute({
      after,
      upTo,
      revisions: { state: "not-configured" },
      deploys: { state: "not-configured" },
    });
    expect(a.label).toBe("unknown");
    expect(a.reasons[0]).toContain("gaugeline.changes.json");
  });
});

describe("warranty wording: unit", () => {
  const w = { ends: "2026-11-30", covers: "bugs in what was built" };
  it("inside, on the last day and after", () => {
    expect(warrantyNote(w, "2026-10-03T10:00:00Z")).toContain("inside the warranty period");
    expect(warrantyNote(w, "2026-11-30T23:00:00Z")).toContain("inside the warranty period");
    expect(warrantyNote(w, "2026-12-01T00:00:00Z")).toContain("after the warranty period");
  });
  it("says nothing about price", () => {
    for (const at of ["2026-10-03T10:00:00Z", "2026-12-05T10:00:00Z"])
      expect(warrantyNote(w, at)).not.toMatch(
        /[$£€]|\bprice|\bcost|\bbill|\bfee|\bcharge|\d+\.\d{2}\b/i,
      );
  });
});

describe("history: unit and edge cases", () => {
  const run = (
    id: string,
    at: string,
    findings: string[],
    pages: Record<string, PageRecord> = { "/events": before },
  ): RunRecord => ({
    schema: 1,
    id,
    takenAt: at,
    pages,
    findings: findings.map((checkId) => ({ checkId, path: "/events", title: checkId })),
  });
  const r1 = run("r-20261001T100000Z", "2026-10-01T10:00:00.000Z", []);
  const r2 = run("r-20261003T100000Z", "2026-10-03T10:00:00.000Z", ["order-button-missing"]);
  const r3 = run("r-20261005T100000Z", "2026-10-05T10:00:00.000Z", ["order-button-missing"]);

  it("a finding that persisted is compared at its first appearance, not the latest run", () => {
    const [a] = newFindings([r3, r1, r2], { kind: "date", at: "2026-10-02T00:00:00.000Z" });
    expect(a?.first.id).toBe(r2.id);
    expect(a?.before?.id).toBe(r1.id);
  });
  it("by default only findings new in the latest run", () => {
    expect(newFindings([r1, r2, r3])).toEqual([]);
    expect(newFindings([r1, r2])).toHaveLength(1);
  });
  it("--since a run id", () => {
    expect(newFindings([r1, r2, r3], { kind: "run", id: r1.id })).toHaveLength(1);
    expect(newFindings([r1, r2, r3], { kind: "run", id: r2.id })).toEqual([]);
  });
  it("parseSince and runId", () => {
    expect(parseSince("2026-10-03")).toEqual({ kind: "date", at: "2026-10-03T00:00:00.000Z" });
    expect(parseSince("r-20261003T100000Z")).toEqual({ kind: "run", id: "r-20261003T100000Z" });
    expect(parseSince("last week")).toBeUndefined();
    expect(runId(new Date("2026-10-03T10:00:00Z"))).toBe("r-20261003T100000Z");
  });
  it("prunes runs older than the retention", () => {
    const { kept, dropped, cutoff } = pruneRuns([r1, r2, r3], new Date("2026-12-31T00:00:00Z"), 90);
    expect(dropped.map((r) => r.id)).toEqual([r1.id]);
    expect(kept.map((r) => r.id)).toEqual([r2.id, r3.id]);
    expect(cutoff).toBe("2026-10-02T00:00:00.000Z");
  });
  it("first run of a site: no history, nothing listed", async () => {
    const report = await buildChanges({ site: "harbourbar.example", runs: [r2], sources: none });
    expect(report.items).toEqual([]);
    expect(report.noHistory).toBe(1);
    expect(formatChanges(report)).toContain("no earlier run");
  });
  it("snapshot pruned past retention: changed before the date, history not kept", async () => {
    const report = await buildChanges({
      site: "harbourbar.example",
      runs: [r2],
      sources: none,
      prunedBefore: "2026-10-02T00:00:00.000Z",
    });
    expect(report.items[0]?.sentence).toBe("Changed before 2 Oct 2026, history not kept.");
  });
});

const none = {
  revisions: () => Promise.resolve({ state: "not-configured" as const }),
  deploys: () => Promise.resolve({ state: "not-configured" as const }),
};

// Recorded answers, invented: Harbour Bar's events page, edited by an owner two hours before the run.
const ndjson = (rows: unknown[]) =>
  Promise.resolve({
    status: 200,
    headers: { "content-type": "application/x-ndjson" },
    body: Readable.from([Buffer.from(rows.map((r) => JSON.stringify(r)).join("\n"))]),
  });
const jsonBody = (body: unknown) =>
  Promise.resolve({
    status: 200,
    headers: { "content-type": "application/json" },
    body: Readable.from([Buffer.from(JSON.stringify(body))]),
  });
const seen: string[] = [];
const world =
  (opts: { editorName?: boolean } = {}): Transport =>
  (url, req) => {
    seen.push(`${req.method} ${url.href}`);
    if (url.pathname.includes("/data/history/"))
      return ndjson([
        {
          id: "tx1",
          timestamp: "2026-10-03T08:00:00.000Z",
          author: "u1",
          documentIDs: ["events-page"],
        },
        {
          id: "tx0",
          timestamp: "2026-10-02T08:00:00.000Z",
          author: "u1",
          documentIDs: ["events-page"],
        },
      ]);
    if (url.pathname.includes("/users/"))
      return jsonBody(
        opts.editorName === false
          ? [{ id: "u1" }]
          : [{ id: "u1", displayName: "Sam Ortiz", email: "sam@harbourbar.example" }],
      );
    if (url.host === "api.vercel.com")
      return jsonBody({
        deployments: [
          {
            uid: "dpl_2",
            created: Date.parse("2026-10-03T09:00:00Z"),
            meta: { githubCommitSha: "bbbbbbb1111" },
          },
          {
            uid: "dpl_1",
            created: Date.parse("2026-09-20T09:00:00Z"),
            meta: { githubCommitSha: "aaaaaaa0000" },
          },
        ],
      });
    return Promise.resolve({ status: 404, headers: {}, body: Readable.from([Buffer.from("{}")]) });
  };
const SECRET = ["tok", "en-for-tests-only"].join("");
const env = {
  SANITY_PROJECT_ID: "harbour1",
  SANITY_DATASET: "production",
  SANITY_TOKEN: SECRET,
  VERCEL_TOKEN: SECRET,
};

const prevPage = pageOf('<h1>Events</h1><a href="/book">Book a table</a>');
const nowPage = pageOf("<h1>Events</h1>");
const runsOf = (): RunRecord[] => [
  {
    schema: 1,
    id: "r-20261001T100000Z",
    takenAt: "2026-10-01T10:00:00.000Z",
    pages: { "/events": prevPage },
    findings: [],
  },
  {
    schema: 1,
    id: "r-20261003T100000Z",
    takenAt: "2026-10-03T10:00:00.000Z",
    pages: { "/events": nowPage },
    findings: [
      { checkId: "order-button-missing", path: "/events", title: "The booking button is missing" },
    ],
  },
];

describe("integration over recorded responses", () => {
  const fetcher = () => createFetcher({ transport: world(), timeoutMs: 5000 });

  it("a Sanity edit two hours before the run where the button first goes missing: content-edit by name", async () => {
    seen.length = 0;
    const f = fetcher();
    const adapter = createSanityAdapter({ env, fetcher: f, sleep: () => Promise.resolve() });
    const sources = createChangeSources({
      config: { documents: { "/events": "events-page" } },
      env,
      fetcher: f,
      adapter,
    });
    const report = await buildChanges({ site: "harbourbar.example", runs: runsOf(), sources });
    const item = report.items[0]!;
    expect(item.label).toBe("content-edit");
    expect(item.sentence).toBe(
      "Changed by a content edit on 3 Oct 2026 by Sam Ortiz (document events-page).",
    );
    expect(item.fields.map((x) => x.detail)).toContain("link removed: /book");
    expect(seen.every((s) => s.startsWith("GET "))).toBe(true);
    expect(JSON.stringify(report)).not.toContain('harbourbar.example"'.concat("sam@"));
    expect(JSON.stringify(report)).not.toContain("sam@harbourbar.example");
    expect(JSON.stringify(report)).not.toContain(SECRET);
    expect(seen.join("\n")).not.toContain(SECRET);
  });

  it("a Vercel deploy between the runs and no content revision: code-deploy with the commit range", async () => {
    const f = createFetcher({
      transport: (u, r) => (u.pathname.includes("/data/history/") ? ndjson([]) : world()(u, r)),
      timeoutMs: 5000,
    });
    const adapter = createSanityAdapter({ env, fetcher: f, sleep: () => Promise.resolve() });
    const sources = createChangeSources({
      config: {
        documents: { "/events": "events-page" },
        deploys: { provider: "vercel", projectId: "prj_harbour" },
      },
      env,
      fetcher: f,
      adapter,
    });
    const report = await buildChanges({ site: "harbourbar.example", runs: runsOf(), sources });
    const item = report.items[0]!;
    expect(item.label).toBe("code-deploy");
    expect(item.attribution.commitRange).toBe("aaaaaaa..bbbbbbb");
    expect(item.sentence).toContain("deploy dpl_2, commits aaaaaaa..bbbbbbb");
  });

  it("an edit and a deploy together: both, and the sentence does not pick one", async () => {
    const f = fetcher();
    const adapter = createSanityAdapter({ env, fetcher: f, sleep: () => Promise.resolve() });
    const sources = createChangeSources({
      config: {
        documents: { "/events": "events-page" },
        deploys: { provider: "vercel", projectId: "prj_harbour" },
      },
      env,
      fetcher: f,
      adapter,
    });
    const item = (await buildChanges({ site: "h", runs: runsOf(), sources })).items[0]!;
    expect(item.label).toBe("both");
    expect(item.sentence).toContain("do not show which one");
    expect(item.sentence).not.toMatch(/fault|blame/i);
  });

  it("an adapter without revisions(): unknown, and the reason names the CMS", async () => {
    const f = fetcher();
    const real = createSanityAdapter({ env, fetcher: f });
    const { revisions: _omit, ...without } = real;
    const sources = createChangeSources({
      config: { documents: { "/events": "events-page" } },
      env,
      fetcher: f,
      adapter: without,
    });
    const item = (await buildChanges({ site: "h", runs: runsOf(), sources })).items[0]!;
    expect(item.label).toBe("unknown");
    expect(item.sentence).toContain("Sanity");
  });

  it("an editor name the API does not give is 'an editor', never inferred", async () => {
    const f = createFetcher({ transport: world({ editorName: false }), timeoutMs: 5000 });
    const adapter = createSanityAdapter({ env, fetcher: f });
    const sources = createChangeSources({
      config: { documents: { "/events": "events-page" } },
      env,
      fetcher: f,
      adapter,
    });
    const item = (await buildChanges({ site: "h", runs: runsOf(), sources })).items[0]!;
    expect(item.sentence).toContain("by an editor");
  });

  it("no Sanity token: could-not-check, not a pass", async () => {
    const f = fetcher();
    const noTok = { SANITY_PROJECT_ID: "harbour1" };
    const adapter = createSanityAdapter({ env: noTok, fetcher: f });
    const sources = createChangeSources({
      config: { documents: { "/events": "events-page" } },
      env: noTok,
      fetcher: f,
      adapter,
    });
    const item = (await buildChanges({ site: "h", runs: runsOf(), sources })).items[0]!;
    expect(item.label).toBe("unknown");
    expect(item.sentence).toContain("SANITY_TOKEN is not set");
  });

  it("the warranty note rides along, and the config schema refuses an unknown key", async () => {
    const item = (
      await buildChanges({
        site: "h",
        runs: runsOf(),
        sources: none,
        warranty: { ends: "2026-10-31" },
      })
    ).items[0]!;
    expect(item.warranty).toContain("inside the warranty period");
    expect(changesConfigSchema.safeParse({ warrenty: {} }).success).toBe(false);
    expect(changesConfigSchema.safeParse({ warranty: { ends: "31 Oct" } }).success).toBe(false);
  });
});
