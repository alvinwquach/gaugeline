import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { readSanityRevisions } from "../../adapters/sanity-revisions-read.js";
import { AdapterCouldNotCheck } from "../../adapters/types.js";
import { ConfigError } from "../../errors.js";
import { createFetcher, type Transport } from "../../fetcher.js";
import { buildSnapshot } from "../../snapshot.js";
import { attribute } from "../attribute.js";
import { readDeploys } from "../deploys.js";
import { buildPageRecord } from "../record.js";
import { buildChanges, formatChanges, type ChangeSources } from "../report.js";
import { isRunRecord, type PageRecord, type RunRecord } from "../types.js";

const SECRET = ["tok", "en-review-only"].join("");
const ESC = String.fromCharCode(27);
const reply = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  Promise.resolve({
    status,
    headers: { "content-type": "application/json", ...headers },
    body: Readable.from([Buffer.from(typeof body === "string" ? body : JSON.stringify(body))]),
  });

const page: PageRecord = { mainHash: "a".repeat(16), links: [], types: [], scripts: [] };
const run = (id: string, at: string, extra: Partial<RunRecord> = {}): RunRecord => ({
  schema: 1,
  id,
  takenAt: at,
  pages: { "/events": page },
  findings: [],
  ...extra,
});
const none: ChangeSources = {
  revisions: () => Promise.resolve({ state: "not-configured" }),
  deploys: () => Promise.resolve({ state: "not-configured" }),
};

describe("a stored run is checked before it is trusted (review 1, 6)", () => {
  it("accepts a well-formed run", () => {
    expect(isRunRecord(run("r-20261101T100000Z", "2026-11-01T10:00:00.000Z"))).toBe(true);
  });
  it.each([
    ["a traversal id", { id: "../../../precious/data" }],
    ["an id that is not a run id", { id: "evil" }],
    ["another schema", { schema: 2 }],
    ["findings missing", { findings: undefined }],
    ["findings not an array", { findings: "x" }],
    ["pages missing", { pages: undefined }],
    ["a page with no hash", { pages: { "/a": { links: [], types: [], scripts: [] } } }],
    [
      "a page with links that are not a list",
      { pages: { "/a": { mainHash: "x", links: 1, types: [], scripts: [] } } },
    ],
    [
      "a finding with a very long title",
      { findings: [{ checkId: "a", path: "/", title: "x".repeat(5000) }] },
    ],
    ["a time that is not a time", { takenAt: "yesterday" }],
  ])("refuses %s", (_n, patch) => {
    expect(
      isRunRecord({ ...run("r-20261101T100000Z", "2026-11-01T10:00:00.000Z"), ...patch }),
    ).toBe(false);
  });
});

describe("--since that matches nothing is not a pass (review 2)", () => {
  const runs = [
    run("r-20261101T100000Z", "2026-11-01T10:00:00.000Z"),
    run("r-20261103T100000Z", "2026-11-03T10:00:00.000Z"),
  ];
  it("an unknown run id is a config error naming where history starts", async () => {
    await expect(
      buildChanges({
        site: "h",
        runs,
        since: { kind: "run", id: "r-20260101T000000Z" },
        sources: none,
      }),
    ).rejects.toThrow(/r-20260101T000000Z is not stored; history kept from 1 Nov 2026/);
    await expect(
      buildChanges({
        site: "h",
        runs,
        since: { kind: "run", id: "r-20260101T000000Z" },
        sources: none,
      }),
    ).rejects.toBeInstanceOf(ConfigError);
  });
  it("a date newer than every run says so, not 'no new findings'", async () => {
    const report = await buildChanges({
      site: "h",
      runs,
      since: { kind: "date", at: "2026-12-01T00:00:00.000Z" },
      sources: none,
    });
    const text = formatChanges(report);
    expect(text).toContain("latest stored run is from 3 Nov 2026");
    expect(text).not.toContain("No new findings");
  });
});

describe("a source that was not asked is never reported as 'nothing recorded' (review 4)", () => {
  const base = { after: "2026-11-01T10:00:00.000Z", upTo: "2026-11-03T10:00:00.000Z" };
  it("unknown with nothing configured says what was not checked", () => {
    const a = attribute({
      ...base,
      revisions: { state: "not-configured" },
      deploys: { state: "not-configured" },
    });
    const text = a.reasons.join("; ");
    expect(text).toContain("content edits were not checked");
    expect(text).toContain("deploys were not checked");
    expect(text).not.toMatch(/no content revision|no deploy is recorded/);
  });
  it("unknown after both were read says nothing was recorded", () => {
    const a = attribute({
      ...base,
      revisions: { state: "read", items: [] },
      deploys: { state: "read", items: [] },
    });
    expect(a.reasons.join("; ")).toMatch(/no content edit is recorded.*no deploy is recorded/);
  });
  it("a deploy with revisions never asked is code-deploy only with a note that edits were not checked", () => {
    const a = attribute({
      ...base,
      revisions: { state: "not-configured" },
      deploys: { state: "read", items: [{ id: "d1", createdAt: "2026-11-02T10:00:00.000Z" }] },
    });
    expect(a.notChecked.join(" ")).toContain("content edits were not checked");
  });
});

describe("page records keep no credentials or query strings (review 8)", () => {
  it("strips userinfo, query and fragment from links and the canonical", () => {
    const rec = buildPageRecord(
      buildSnapshot([
        {
          url: "https://harbourbar.example/events",
          status: 200,
          headers: { "content-type": "text/html" },
          body: `<html><head><link rel="canonical" href="https://harbourbar.example/events?utm=a#top"></head><body><main><a href="https://${["user:pw", "partner.example"].join("@")}/x?token=abc#f">a</a><a href="/book?session=123">b</a></main></body></html>`,
          ms: 1,
        },
      ]),
    );
    expect(rec.links).toEqual(["/book", "https://partner.example/x"]);
    expect(rec.canonical).toBe("https://harbourbar.example/events");
    expect(JSON.stringify(rec)).not.toMatch(/user:pw|token=abc|session=123/);
  });
});

describe("text from a collaborator is printed safely (review 11)", () => {
  it("an editor name with control characters is escaped in the report", async () => {
    const runs = [
      run("r-20261101T100000Z", "2026-11-01T10:00:00.000Z"),
      run("r-20261103T100000Z", "2026-11-03T10:00:00.000Z", {
        pages: { "/events": { ...page, mainHash: "b".repeat(16) } },
        findings: [{ checkId: "page-lost-content", path: "/events", title: "x" }],
      }),
    ];
    const sources: ChangeSources = {
      revisions: () =>
        Promise.resolve({
          state: "read",
          items: [
            {
              documentId: "events-page",
              time: "2026-11-02T10:00:00.000Z",
              editor: `Sam${ESC}[31m Ortiz`,
            },
          ],
        }),
      deploys: () => Promise.resolve({ state: "not-configured" }),
    };
    const out = formatChanges(await buildChanges({ site: "h", runs, sources }));
    expect(out).not.toContain(ESC);
    expect(out).toContain("\\u{1B}");
  });
  it("the Sanity reader escapes the name when it reads it", async () => {
    const t: Transport = (url) =>
      url.pathname.includes("/users/")
        ? reply(200, [{ id: "u1", displayName: `Sam${ESC}[31m` }])
        : reply(200, JSON.stringify({ timestamp: "2026-11-02T10:00:00.000Z", author: "u1" }));
    const env = { SANITY_PROJECT_ID: "harbour1", SANITY_TOKEN: SECRET };
    const got = await readSanityRevisions(
      env,
      createFetcher({ transport: t }),
      "events-page",
      "2026-11-01T00:00:00.000Z",
    );
    expect(got[0]?.editor).not.toContain(ESC);
  });
});

describe("off-page findings are named, not silently dropped (review 7)", () => {
  it("the report says how many findings were on pages that are not compared", async () => {
    const runs = [
      run("r-20261101T100000Z", "2026-11-01T10:00:00.000Z"),
      run("r-20261103T100000Z", "2026-11-03T10:00:00.000Z", { offPage: 3 }),
    ];
    const report = await buildChanges({ site: "h", runs, sources: none });
    expect(report.offPage).toBe(3);
    expect(formatChanges(report)).toContain("3 findings on other pages are not compared");
  });
});

const sanityEnv = {
  SANITY_PROJECT_ID: "harbour1",
  SANITY_DATASET: "production",
  SANITY_TOKEN: SECRET,
};
const SINCE = "2026-11-01T00:00:00.000Z";

describe("Sanity history fails safe (review 3, 14)", () => {
  const ask = (t: Transport) =>
    readSanityRevisions(sanityEnv, createFetcher({ transport: t }), "events-page", SINCE);
  it("100 transactions may be a cut-off list: could-not-check", async () => {
    const rows = Array.from({ length: 100 }, (_, i) =>
      JSON.stringify({
        timestamp: `2026-11-02T10:${String(i % 60).padStart(2, "0")}:00.000Z`,
        author: "u1",
      }),
    ).join("\n");
    await expect(ask(() => reply(200, rows))).rejects.toThrow(/more than 100 .*may be missing/);
  });
  it.each([401, 403, 429])(
    "HTTP %i is could-not-check and never shows the token",
    async (status) => {
      const err = await ask(() => reply(status, {}, { "retry-after": "30" })).catch(
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(AdapterCouldNotCheck);
      expect((err as Error).message).not.toContain(SECRET);
    },
  );
  it("a redirect to another origin is followed without the token", async () => {
    const seen: { host: string; auth: string | undefined }[] = [];
    const t: Transport = (url, req) => {
      seen.push({ host: url.host, auth: req.headers.authorization });
      return url.host === "evil.example"
        ? reply(200, "")
        : reply(302, "", { location: "https://evil.example/steal" });
    };
    await ask(t).catch(() => undefined);
    expect(seen.find((s) => s.host === "evil.example")?.auth).toBeUndefined();
  });
});

describe("deployment lists fail safe (review 3, 5, 14)", () => {
  const vercel = { provider: "vercel", projectId: "prj_harbour" } as const;
  const netlify = { provider: "netlify", siteId: "harbour-bar" } as const;
  const env = { VERCEL_TOKEN: SECRET, NETLIFY_TOKEN: SECRET };
  const f = (t: Transport) => createFetcher({ transport: t });
  const v = (state: string | undefined, uid: string) => ({
    uid,
    created: Date.parse("2026-11-02T10:00:00Z"),
    target: "production",
    ...(state ? { state } : {}),
    meta: { githubCommitSha: "abcdef1234567" },
  });

  it("only ready production deployments count (Vercel)", async () => {
    const got = await readDeploys(
      vercel,
      env,
      f(() =>
        reply(200, {
          deployments: [
            v("READY", "ok"),
            v("ERROR", "bad"),
            v("CANCELED", "c"),
            v("BUILDING", "b"),
            v(undefined, "nostate"),
          ],
        }),
      ),
      SINCE,
    );
    expect(got).toMatchObject({ state: "read" });
    expect(got.state === "read" && got.items.map((d) => d.id)).toEqual(["ok"]);
  });
  it("only ready production deploys count (Netlify), and a missing context is not production", async () => {
    const rows = [
      {
        id: "ok",
        created_at: "2026-11-02T10:00:00Z",
        state: "ready",
        context: "production",
        commit_ref: "abc1234",
      },
      {
        id: "preview",
        created_at: "2026-11-02T10:00:00Z",
        state: "ready",
        context: "deploy-preview",
      },
      { id: "nocontext", created_at: "2026-11-02T10:00:00Z", state: "ready" },
      { id: "failed", created_at: "2026-11-02T10:00:00Z", state: "error", context: "production" },
    ];
    const got = await readDeploys(
      netlify,
      env,
      f(() => reply(200, rows)),
      SINCE,
    );
    expect(got.state === "read" && got.items.map((d) => d.id)).toEqual(["ok"]);
  });
  it("a full page whose oldest deployment is newer than the window start may be missing records", async () => {
    const rows = Array.from({ length: 100 }, (_, i) => ({
      ...v("READY", `d${i}`),
      created: Date.parse("2026-11-02T10:00:00Z") + i,
    }));
    const got = await readDeploys(
      vercel,
      env,
      f(() => reply(200, { deployments: rows })),
      SINCE,
    );
    expect(got).toMatchObject({ state: "could-not-check" });
    expect(got.state === "could-not-check" && got.reason).toMatch(/more than 100.*may be missing/);
  });
  it("a full page that reaches back before the window start is complete enough", async () => {
    const rows = Array.from({ length: 100 }, (_, i) => ({
      ...v("READY", `d${i}`),
      created: Date.parse("2026-10-01T10:00:00Z") + i,
    }));
    expect(
      (
        await readDeploys(
          vercel,
          env,
          f(() => reply(200, { deployments: rows })),
          SINCE,
        )
      ).state,
    ).toBe("read");
  });
  it.each([401, 403, 429])(
    "HTTP %i is could-not-check and never shows the token",
    async (status) => {
      for (const cfg of [vercel, netlify]) {
        const got = await readDeploys(
          cfg,
          env,
          f(() => reply(status, {}, { "retry-after": "30" })),
          SINCE,
        );
        expect(got.state).toBe("could-not-check");
        expect(JSON.stringify(got)).not.toContain(SECRET);
      }
    },
  );
  it("a redirect to another origin is followed without the token", async () => {
    const seen: { host: string; auth: string | undefined }[] = [];
    const t: Transport = (url, req) => {
      seen.push({ host: url.host, auth: req.headers.authorization });
      return url.host === "evil.example"
        ? reply(200, { deployments: [] })
        : reply(302, "", { location: "https://evil.example/x" });
    };
    await readDeploys(vercel, env, f(t), SINCE);
    expect(seen.find((s) => s.host === "evil.example")?.auth).toBeUndefined();
  });
});

describe("'history not kept' is only said when it is true (re-review M1)", () => {
  const edit = (path: string): PageRecord => ({
    ...page,
    mainHash: path === "/book" ? "c".repeat(16) : page.mainHash,
  });
  it("a page first read after the prune marker is 'no earlier run', not 'history not kept'", async () => {
    const runs = [
      run("r-20261101T100000Z", "2026-11-01T10:00:00.000Z"),
      run("r-20261103T100000Z", "2026-11-03T10:00:00.000Z", {
        pages: { "/book": edit("/book") },
        findings: [{ checkId: "viewport", path: "/book", title: "x" }],
      }),
    ];
    const report = await buildChanges({
      site: "h",
      runs,
      sources: none,
      prunedBefore: "2026-10-01T00:00:00.000Z",
    });
    expect(report.items).toEqual([]);
    expect(report.noHistory).toBe(1);
    expect(formatChanges(report)).not.toContain("history not kept");
  });
  it("the earliest kept run is where history may have been cut", async () => {
    const runs = [
      run("r-20261101T100000Z", "2026-11-01T10:00:00.000Z", {
        findings: [{ checkId: "viewport", path: "/events", title: "x" }],
      }),
      run("r-20261103T100000Z", "2026-11-03T10:00:00.000Z", {
        findings: [{ checkId: "viewport", path: "/events", title: "x" }],
      }),
    ];
    const report = await buildChanges({
      site: "h",
      runs,
      since: { kind: "date", at: "2026-10-01T00:00:00.000Z" },
      sources: none,
      prunedBefore: "2026-10-01T00:00:00.000Z",
    });
    expect(report.items[0]?.sentence).toBe("Changed before 1 Oct 2026, history not kept.");
  });
});

describe("a path is a path, never a property name (re-review L2)", () => {
  it.each(["constructor", "toString", "__proto__", "no-slash"])(
    "isRunRecord refuses a finding or page path of %s",
    (path) => {
      const r = run("r-20261101T100000Z", "2026-11-01T10:00:00.000Z");
      expect(isRunRecord({ ...r, findings: [{ checkId: "a", path, title: "t" }] })).toBe(false);
      expect(
        isRunRecord(
          JSON.parse(
            `{"schema":1,"id":"r-20261101T100000Z","takenAt":"2026-11-01T10:00:00.000Z","pages":{"${path}":{"mainHash":"x","links":[],"types":[],"scripts":[]}},"findings":[]}`,
          ),
        ),
      ).toBe(false);
    },
  );
  it("even a record that skipped validation does not crash on such a path", async () => {
    const runs = [
      run("r-20261101T100000Z", "2026-11-01T10:00:00.000Z"),
      run("r-20261103T100000Z", "2026-11-03T10:00:00.000Z", {
        findings: [{ checkId: "a", path: "constructor", title: "t" }],
      }),
    ];
    const report = await buildChanges({ site: "h", runs, sources: none });
    expect(report.items).toEqual([]);
    expect(report.noHistory).toBe(1);
  });
});
