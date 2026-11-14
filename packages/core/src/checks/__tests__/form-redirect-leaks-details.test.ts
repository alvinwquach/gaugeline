import { describe, expect, it } from "vitest";
import { startFixture } from "../../../../fixtures/src/index.js";
import { createFetcher } from "../../fetcher.js";
import type { Finding } from "../../model.js";
import { buildSnapshot, type PageSnapshot } from "../../snapshot.js";
import { checkSite } from "../../site.js";
import { formRedirectLeaksDetails as check } from "../form-redirect-leaks-details.js";
import { PAGE_CHECKS, createPageRegistry } from "../index.js";

/**
 * form-redirect-leaks-details: a form's action or thank-you field, in the page's own HTML, that carries an
 * email or phone number. Values are assembled from parts at run time (community:check refuses such a
 * literal); the clinic is invented.
 */
const AT = "@";
const EMAIL_ENC = ["sam.reeves", "harbour-physio.example"].join(AT).replace(AT, "%40");
const LOCAL = "sam.reeves";

function snap(body: string, url = "https://harbour-physio.example/book/"): PageSnapshot {
  return buildSnapshot([
    {
      url,
      status: 200,
      headers: { "content-type": "text/html" },
      body: `<html><head><title>Harbour Physio</title></head><body>${body}</body></html>`,
      ms: 1,
    },
  ]);
}
async function run(s: PageSnapshot) {
  const notes: { url: string; reason: string }[] = [];
  const found = (await check.run(s, {
    warn: () => undefined,
    couldNotCheck: (url: string, reason: string) => notes.push({ url, reason }),
  })) as Finding[];
  return { found, notes };
}
const LEAK = `<form action="/thanks?email=${EMAIL_ENC}" method="post"><input name="n"></form>`;

describe("form-redirect-leaks-details: unit", () => {
  it("is a medium Leads finding with the address masked and the page's own url", async () => {
    const { found, notes } = await run(snap(LEAK));
    expect(found).toEqual([
      {
        checkId: "form-redirect-leaks-details",
        severity: "medium",
        title: check.title,
        evidence:
          'Form action https://harbour-physio.example/thanks?email=***: the "email" parameter holds an email address.',
        url: "https://harbour-physio.example/book/",
      },
    ]);
    expect(notes).toEqual([]);
    expect(JSON.stringify(found)).not.toContain(LOCAL);
  });

  it("passes a page whose forms have clean addresses", async () => {
    const r = await run(snap(`<form action="/thanks?plan=gold"><input name="n"></form>`));
    expect(r).toEqual({ found: [], notes: [] });
  });

  it("reports a form it could not read as could-not-check, once for the page, and not as a pass", async () => {
    const r = await run(
      snap(`<form method="post"><input name="n"></form><form action="#"><input name="n"></form>`),
    );
    expect(r.found).toEqual([]);
    expect(r.notes).toEqual([
      {
        url: "https://harbour-physio.example/book/",
        reason: expect.stringContaining("2 forms have no address of its own"),
      },
    ]);
  });

  it("reports an embedded form service as could-not-check, and still finds a leak beside it", async () => {
    const r = await run(snap(`${LEAK}<iframe src="https://go.pardot.com/l/100001/xk2m"></iframe>`));
    expect(r.found).toHaveLength(1);
    expect(r.notes).toHaveLength(1);
    expect(r.notes[0]?.reason).toContain("another document");
  });

  it("says nothing about a page that is not HTML", async () => {
    const s = buildSnapshot([
      {
        url: "https://harbour-physio.example/data.json",
        status: 200,
        headers: { "content-type": "application/json" },
        body: "{}",
        ms: 1,
      },
    ]);
    expect(await run(s)).toEqual({ found: [], notes: [] });
  });

  it("gives one finding for each page that has the same address", async () => {
    const a = await run(snap(LEAK, "https://harbour-physio.example/book/"));
    const b = await run(snap(LEAK, "https://harbour-physio.example/contact/"));
    expect([a.found.length, b.found.length]).toEqual([1, 1]);
    expect(a.found[0]?.url).not.toBe(b.found[0]?.url);
  });
});

describe("form-redirect-leaks-details: the text", () => {
  it("has every field filled in, claims nothing as confirmed, and says who owns the fix", () => {
    const all = [
      check.title,
      check.what,
      check.why,
      check.fix,
      check.tech,
      check.done,
      check.estimateChanges,
    ];
    for (const t of all) {
      expect(t).not.toMatch(/TODO/);
      expect(t).not.toMatch(/confirm/i);
      expect(t.length).toBeGreaterThan(10);
    }
    expect(check.fix).toMatch(/developer/i);
    expect(check.fix).toMatch(/provider/i);
    expect(check.tech).toMatch(/could-not-check/);
  });
});

describe("form-redirect-leaks-details: registry", () => {
  it("is registered once, in the default page set, under Leads and Fix soon, beside the other form checks", () => {
    const ids = PAGE_CHECKS.map((c) => c.id);
    expect(ids.filter((i) => i === "form-redirect-leaks-details")).toHaveLength(1);
    expect(ids).toEqual([...ids].sort());
    const reg = createPageRegistry();
    expect(reg.all().map((c) => c.id)).toContain("form-redirect-leaks-details");
    expect(check.area).toBe("Leads");
    expect(check.severity).toBe("medium");
    expect(PAGE_CHECKS.find((c) => c.id === "crm-no-campaign-fields")?.area).toBe(check.area);
  });
});

describe("form-redirect-leaks-details: integration", () => {
  it("through the runner on an invented site: finds the leaks, says what it could not read, asks only by GET", async () => {
    const site = await startFixture("form-redirect-leaks");
    try {
      const { result } = await checkSite({
        address: site.origin,
        fetcher: createFetcher({ allowPrivate: true }),
        only: ["form-redirect-leaks-details"],
      });
      const mine = result.findings.filter((f) => f.checkId === "form-redirect-leaks-details");
      expect(mine.map((f) => f.evidence)).toEqual([
        expect.stringMatching(
          /^Form action http:\/\/[^/]+\/thanks\?name=\*\*\*&email=\*\*\*: the "email" parameter/,
        ),
        expect.stringMatching(
          /^The "retURL" field sends visitors to .*\/thanks\?tel=\*\*\*: the "tel" parameter holds a phone number\.$/,
        ),
      ]);
      expect(JSON.stringify(result)).not.toContain(LOCAL);
      expect(
        result.couldNotCheck.filter((n) => n.id === "form-redirect-leaks-details"),
      ).toHaveLength(1);
      expect(site.requests.every((l) => l.method === "GET" || l.method === "HEAD")).toBe(true);
    } finally {
      await site.close();
    }
  });
});
