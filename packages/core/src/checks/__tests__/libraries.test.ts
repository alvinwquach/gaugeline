import { join } from "node:path";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { SITES_DIR } from "../../../../fixtures/src/index.js";
import { staticSite } from "../../../../testkit/src/index.js";
import { createFetcher, FetchError, type Fetcher, type Transport } from "../../fetcher.js";
import { LIBRARY_SCRIPT_CAP } from "../../libraries/reader.js";
import { createLibraries, type Libraries, type ScriptReading } from "../../libraries/reader.js";
import { addLibraryChecks } from "../../libraries/registry.js";
import type { Detection } from "../../libraries/detect.js";
import type { CheckContext } from "../../model.js";
import { checkSite } from "../../site.js";
import { createPageRegistry } from "../index.js";
import { advisoriesFor } from "../../libraries/advisories.js";
import { describeFinding, LIBRARY_CHECKS, libraryWithAdvisory } from "../libraries.js";
import { page } from "./helpers.js";

const SHOP = "corner-pantry.example";
const SHOP_DIR = join(SITES_DIR, "old-theme-shop");

const jquery = (
  version: string | null,
  how: Detection["evidence"]["how"] = "banner",
): Detection => ({
  library: "jquery",
  name: "jQuery",
  version,
  evidence: { how, matched: version ?? "jquery.min.js" },
});

const found = (url: string, detections: Detection[], over: Partial<ScriptReading> = {}) =>
  ({ ok: true, url, detections, minified: false, truncated: false, ...over }) as ScriptReading;

function fake(readings: Record<string, ScriptReading>): Libraries {
  return {
    read: async (url) => readings[url] ?? { ok: false, url, reason: "gave no answer" },
    claim: () => true,
  };
}

function context(libraries?: Libraries) {
  const notes: { url: string; reason: string }[] = [];
  const ctx: CheckContext = {
    warn: () => undefined,
    couldNotCheck: (url, reason) => void notes.push({ url, reason }),
    ...(libraries ? { libraries } : {}),
  };
  return { ctx, notes };
}

const JQ = `https://${SHOP}/assets/js/jquery.min.js`;
const shopPage = (...scripts: string[]) => page({ finalUrl: `https://${SHOP}/`, scripts });

describe("the library check: unit", () => {
  it("there is one, medium severity", () => {
    expect(LIBRARY_CHECKS.map((c) => [c.id, c.severity])).toEqual([
      ["library-with-advisory", "medium"],
    ]);
  });

  it("does nothing without --libraries: no finding, no note, no read", async () => {
    const { ctx, notes } = context();
    expect(await libraryWithAdvisory.run(shopPage(JQ), ctx)).toEqual([]);
    expect(notes).toEqual([]);
  });

  it("states library, version, the advisories and their fixed-in versions, as facts", async () => {
    const { ctx, notes } = context(fake({ [JQ]: found(JQ, [jquery("1.12.4")]) }));
    const out = await libraryWithAdvisory.run(shopPage(JQ), ctx);
    expect(out).toEqual([
      {
        checkId: "library-with-advisory",
        severity: "medium",
        title: "A JavaScript library the site serves has a published advisory",
        evidence:
          "jQuery 1.12.4 is served from https://corner-pantry.example/assets/js/jquery.min.js (version read from the file's banner comment). 4 advisories in Gaugeline's list name versions that include it: CVE-2020-11023 (cross-site scripting through HTML with option elements; fixed in 3.5.0), CVE-2020-11022 (cross-site scripting through htmlPrefilter; fixed in 3.5.0), CVE-2019-11358 (prototype pollution through extend; fixed in 3.4.0), CVE-2015-9251 (cross-site scripting in cross-domain Ajax requests; fixed in 3.0.0). The entries in Gaugeline's list have not been compared with the advisories' own pages in this release",
        url: `https://${SHOP}/`,
      },
    ]);
    expect(notes).toEqual([]);
  });

  it("says where the version was read from", async () => {
    const url = "https://code.jquery.com/jquery-1.12.4.min.js";
    const { ctx } = context(fake({ [url]: found(url, [jquery("1.12.4", "file-name")]) }));
    const [f] = await libraryWithAdvisory.run(shopPage(url), ctx);
    expect(f?.evidence).toContain(
      "is served from https://code.jquery.com/jquery-1.12.4.min.js (version read from the script's address)",
    );
  });

  it("is a finding for a third-party script as well as for the site's own", async () => {
    const url = "https://cdn.example-hosting.test/libs/jquery.js";
    const { ctx } = context(fake({ [url]: found(url, [jquery("2.2.4")]) }));
    expect(await libraryWithAdvisory.run(shopPage(url), ctx)).toHaveLength(1);
  });

  it("finds nothing for a version past every fix", async () => {
    const { ctx, notes } = context(fake({ [JQ]: found(JQ, [jquery("3.7.1")]) }));
    expect(await libraryWithAdvisory.run(shopPage(JQ), ctx)).toEqual([]);
    expect(notes).toEqual([]);
  });

  it("says when no fixed version is listed", async () => {
    const lodash: Detection = {
      library: "lodash",
      name: "Lodash",
      version: "4.17.15",
      evidence: { how: "version-string", matched: "4.17.15" },
    };
    const url = `https://${SHOP}/js/vendor.js`;
    const { ctx } = context(fake({ [url]: found(url, [lodash]) }));
    const [f] = await libraryWithAdvisory.run(shopPage(url), ctx);
    expect(f?.evidence).toContain("CVE-2020-8203");
    expect(f?.evidence).toContain("fixed in 4.17.19");
  });

  it("a library whose version is not there is could-not-check, never a pass or a finding", async () => {
    const { ctx, notes } = context(
      fake({ [JQ]: found(JQ, [jquery(null, "file-name")], { minified: true }) }),
    );
    expect(await libraryWithAdvisory.run(shopPage(JQ), ctx)).toEqual([]);
    expect(notes).toEqual([
      {
        url: `https://${SHOP}/`,
        reason:
          "jQuery is served from https://corner-pantry.example/assets/js/jquery.min.js, but neither the file nor its address says which version, so it was not compared with the advisories.",
      },
    ]);
  });

  it("minified files with no library name or version are one could-not-check line, naming a few", async () => {
    const urls = ["a", "b", "c", "d"].map((n) => `https://${SHOP}/js/${n}.min.js`);
    const readings = Object.fromEntries(urls.map((u) => [u, found(u, [], { minified: true })]));
    const { ctx, notes } = context(fake(readings));
    expect(await libraryWithAdvisory.run(shopPage(...urls), ctx)).toEqual([]);
    expect(notes).toEqual([
      {
        url: `https://${SHOP}/`,
        reason:
          "4 minified JavaScript files carry no library name or version (a.min.js, b.min.js, c.min.js and 1 more), so what they contain was not compared with the advisories.",
      },
    ]);
  });

  it("readable code with no library in it is not mentioned", async () => {
    const url = `https://${SHOP}/js/site.js`;
    const { ctx, notes } = context(fake({ [url]: found(url, []) }));
    expect(await libraryWithAdvisory.run(shopPage(url), ctx)).toEqual([]);
    expect(notes).toEqual([]);
  });

  it("a script that could not be read is could-not-check with the reason", async () => {
    const url = `https://${SHOP}/js/gone.js`;
    const { ctx, notes } = context(
      fake({ [url]: { ok: false, url, reason: "answered 404" } as ScriptReading }),
    );
    await libraryWithAdvisory.run(shopPage(url), ctx);
    expect(notes).toEqual([
      {
        url: `https://${SHOP}/`,
        reason: `The script https://${SHOP}/js/gone.js answered 404, so it was not compared with the advisories.`,
      },
    ]);
  });

  it("a file longer than the size read says only its start was searched", async () => {
    const { ctx, notes } = context(
      fake({ [JQ]: found(JQ, [jquery("3.7.1")], { truncated: true }) }),
    );
    await libraryWithAdvisory.run(shopPage(JQ), ctx);
    expect(notes[0]?.reason).toBe(
      `The script https://${SHOP}/assets/js/jquery.min.js is longer than Gaugeline reads, so only its start was searched.`,
    );
  });

  it("reads at most the cap of scripts for one page, each once, and says how many were left", async () => {
    const urls = Array.from(
      { length: LIBRARY_SCRIPT_CAP + 3 },
      (_, i) => `https://${SHOP}/js/${i}.js`,
    );
    const read: string[] = [];
    const libraries: Libraries = {
      read: async (u) => {
        read.push(u);
        return found(u, []);
      },
      claim: () => true,
    };
    const { ctx, notes } = context(libraries);
    await libraryWithAdvisory.run(shopPage(...urls, urls[0] as string), ctx);
    expect(read).toEqual(urls.slice(0, LIBRARY_SCRIPT_CAP));
    expect(notes).toEqual([
      {
        url: `https://${SHOP}/`,
        reason: `3 JavaScript files were not read: at most ${LIBRARY_SCRIPT_CAP} are read for one page.`,
      },
    ]);
  });

  it("never reads an address that is not http or https", async () => {
    const read: string[] = [];
    const { ctx } = context({
      read: async (u) => {
        read.push(u);
        return found(u, []);
      },
      claim: () => true,
    });
    await libraryWithAdvisory.run(
      shopPage("data:text/javascript,1", "javascript:void(0)", "ftp://x.test/a.js"),
      ctx,
    );
    expect(read).toEqual([]);
  });

  it("escapes what a script address could carry into a report", async () => {
    const url = `https://${SHOP}/js/a\u202Eb.js`;
    const { ctx, notes } = context(
      fake({ [url]: { ok: false, url, reason: "answered 404" } as ScriptReading }),
    );
    await libraryWithAdvisory.run(shopPage(url), ctx);
    expect(notes[0]?.reason).toContain("a%E2%80%AEb.js");
    expect(notes[0]?.reason).not.toContain("\u202E");
  });

  it("leaves the query string of a script address out, because it may hold a key", async () => {
    const url = `https://${SHOP}/assets/js/jquery.min.js?key=do-not-print`;
    const { ctx } = context(fake({ [url]: found(url, [jquery("1.12.4")]) }));
    const [f] = await libraryWithAdvisory.run(shopPage(url), ctx);
    expect(JSON.stringify(f)).not.toContain("do-not-print");
  });
});

describe("the library check: the invented shop on an old theme (integration)", () => {
  interface Seen {
    method: string;
    url: string;
  }

  function transport(seen: Seen[], third?: Transport): Transport {
    const others: Transport =
      third ??
      ((_u, req) =>
        Promise.resolve({
          status: 404,
          headers: { "content-type": "text/plain" },
          body: Readable.from(req.method === "HEAD" ? [] : [Buffer.from("not found")]),
        }));
    const site = staticSite(SHOP, SHOP_DIR, others);
    return (url, req) => {
      seen.push({ method: req.method, url: url.href });
      return site(url, req);
    };
  }

  async function runOn(off = false, third?: Transport) {
    const seen: Seen[] = [];
    const fetcher = createFetcher({ transport: transport(seen, third), timeoutMs: 5000 });
    const registry = off ? createPageRegistry() : addLibraryChecks(createPageRegistry());
    const { result } = await checkSite({
      address: `https://${SHOP}/`,
      fetcher,
      registry,
      only: LIBRARY_CHECKS.map((c) => c.id).filter((id) => registry.has(id)),
      ...(off ? {} : { libraries: createLibraries(fetcher) }),
    });
    return { result, seen };
  }

  it("finds the one vulnerable library of three, and lists the others as not a finding", async () => {
    const { result } = await runOn();
    expect(result.findings.map((f) => [f.checkId, f.severity])).toEqual([
      ["library-with-advisory", "medium"],
    ]);
    const evidence = result.findings[0]?.evidence ?? "";
    expect(evidence).toContain(
      "jQuery 1.12.4 is served from https://corner-pantry.example/assets/js/jquery.min.js",
    );
    expect(evidence).toContain("CVE-2020-11023");
    expect(evidence).not.toContain("Moment");
    expect(evidence).not.toContain("Lodash");
    expect(result.passed).not.toContain("library-with-advisory");
  });

  it("lists the Bootstrap file with no version and the minified theme as could-not-check", async () => {
    const { result } = await runOn();
    expect(result.couldNotCheck.map((c) => c.reason)).toEqual([
      `Bootstrap is served from https://${SHOP}/assets/js/bootstrap.min.js, but neither the file nor its address says which version, so it was not compared with the advisories.`,
      "1 minified JavaScript file carries no library name or version (theme.min.js), so what it contains was not compared with the advisories.",
    ]);
    expect(result.couldNotCheck.every((c) => c.id === "library-with-advisory")).toBe(true);
  });

  it("asks only for the scripts the page names, once each, with GET", async () => {
    const { seen } = await runOn();
    const js = seen.filter((s) => s.url.endsWith(".js"));
    expect(js.map((s) => s.url).sort()).toEqual(
      ["jquery", "moment", "lodash", "bootstrap", "theme"]
        .map((n) => `https://${SHOP}/assets/js/${n}.min.js`)
        .sort(),
    );
    expect(js.every((s) => s.method === "GET")).toBe(true);
    expect(seen.every((s) => s.method === "GET" || s.method === "HEAD")).toBe(true);
  });

  it("is not in a run without --libraries: no finding and no request for a script", async () => {
    const { result, seen } = await runOn(true);
    expect(result.findings).toEqual([]);
    expect(seen.some((s) => s.url.endsWith(".js"))).toBe(false);
  });

  it("gives the same findings on a second run", async () => {
    const a = await runOn();
    const b = await runOn();
    expect(b.result.findings).toEqual(a.result.findings);
    expect(b.result.couldNotCheck).toEqual(a.result.couldNotCheck);
  });

  it("no script text beyond the version reaches the result", async () => {
    const { result } = await runOn();
    const text = JSON.stringify(result);
    for (const word of ["Foundation", 'corner-pantry"', "pantryOpens", "pantryTools", "pantryTab"])
      expect(text).not.toContain(word);
  });
});

describe("the script reader: unit", () => {
  const body = (text: string) => ({
    status: 200,
    headers: {},
    body: Readable.from([Buffer.from(text)]),
  });

  function readerWith(files: Record<string, { status: number; text: string }>) {
    const asked: string[] = [];
    const transport: Transport = (url) => {
      asked.push(url.href);
      const f = files[url.href];
      return Promise.resolve(
        f ? { ...body(f.text), status: f.status } : { ...body("nope"), status: 404 },
      );
    };
    return { libraries: createLibraries(createFetcher({ transport, timeoutMs: 5000 })), asked };
  }

  it("reads a third-party script from another host the same way as one of the site's own", async () => {
    const url = "https://cdnjs.cloudflare.com/ajax/libs/jquery/1.12.4/jquery.min.js";
    const { libraries } = readerWith({ [url]: { status: 200, text: "!function(){}();" } });
    const r = await libraries.read(url);
    expect(r).toMatchObject({ ok: true, detections: [{ library: "jquery", version: "1.12.4" }] });
  });

  it("reads one address once, however many pages name it", async () => {
    const url = "https://x.test/jquery-3.5.1.min.js";
    const { libraries, asked } = readerWith({ [url]: { status: 200, text: "" } });
    await Promise.all([libraries.read(url), libraries.read(url)]);
    await libraries.read(url);
    expect(asked).toEqual([url]);
  });

  it("an answer that is not 2xx is a reason, not a throw", async () => {
    const { libraries } = readerWith({});
    expect(await libraries.read("https://x.test/gone.js")).toEqual({
      ok: false,
      url: "https://x.test/gone.js",
      reason: "answered 404",
    });
  });

  it("a request that fails is a reason", async () => {
    const libraries = createLibraries(
      createFetcher({ transport: () => Promise.reject(new Error("boom")), timeoutMs: 2000 }),
    );
    const r = await libraries.read("https://x.test/a.js");
    expect(r.ok).toBe(false);
  });

  it("searches only the first MAX of a long file and says it was cut", async () => {
    const url = "https://x.test/big.js";
    const filler = "a".repeat(2 * 1024 * 1024 + 10);
    const { libraries } = readerWith({
      [url]: { status: 200, text: `${filler}\n/*! jQuery v1.12.4 */` },
    });
    expect(await libraries.read(url)).toMatchObject({ ok: true, detections: [], truncated: true });
  });
});

describe("the library check: wording about the list", () => {
  const jq = jquery("1.12.4");

  it("says the list has not been compared with the advisories' own pages while an entry is unverified", () => {
    const text = describeFinding(
      jq,
      "https://x.test/jquery.min.js",
      advisoriesFor("jquery", "1.12.4"),
    );
    expect(text).toContain("advisories in Gaugeline's list name versions that include it");
    expect(text).toContain(
      "The entries in Gaugeline's list have not been compared with the advisories' own pages in this release",
    );
    expect(text).not.toContain("published advisories");
  });

  it("leaves the sentence out when every matched entry is verified", () => {
    const matches = advisoriesFor("jquery", "1.12.4").map((m) => ({
      ...m,
      advisory: { ...m.advisory, verified: true },
    }));
    expect(describeFinding(jq, "https://x.test/jquery.min.js", matches)).not.toContain(
      "have not been compared",
    );
  });

  it("says no fixed version is listed when there is none, and counts one advisory in the singular", () => {
    const [one] = advisoriesFor("jquery", "1.12.4");
    const text = describeFinding(jq, "https://x.test/jquery.min.js", [
      { advisory: (one as NonNullable<typeof one>).advisory, fixedIn: null },
    ]);
    expect(text).toContain("1 advisory in Gaugeline's list names versions that include it");
    expect(text).toContain("no fixed version listed");
  });
});

describe("the library check: once per script per run", () => {
  function onePageWorld() {
    const asked: string[] = [];
    const transport: Transport = (url) => {
      asked.push(url.href);
      return Promise.resolve({
        status: 200,
        headers: {},
        body: Readable.from([
          Buffer.from("/*! jQuery v1.12.4 | (c) jQuery Foundation | jquery.org/license */"),
        ]),
      });
    };
    return { libraries: createLibraries(createFetcher({ transport, timeoutMs: 5000 })), asked };
  }

  it("a script two pages name is reported on the first and left out of the second", async () => {
    const { libraries, asked } = onePageWorld();
    const first = context(libraries);
    const second = context(libraries);
    const a = await libraryWithAdvisory.run(shopPage(JQ), first.ctx);
    const b = await libraryWithAdvisory.run(
      page({ finalUrl: `https://${SHOP}/menu`, scripts: [JQ] }),
      second.ctx,
    );
    expect(a).toHaveLength(1);
    expect(b).toEqual([]);
    expect(second.notes).toEqual([]);
    expect(asked).toEqual([JQ]);
  });

  it("a could-not-check note is given once too", async () => {
    const url = `https://${SHOP}/js/gone.js`;
    const libraries = createLibraries(
      createFetcher({
        transport: () => Promise.resolve({ status: 404, headers: {}, body: Readable.from([]) }),
        timeoutMs: 5000,
      }),
    );
    const first = context(libraries);
    const second = context(libraries);
    await libraryWithAdvisory.run(shopPage(url), first.ctx);
    await libraryWithAdvisory.run(
      page({ finalUrl: `https://${SHOP}/menu`, scripts: [url] }),
      second.ctx,
    );
    expect(first.notes).toHaveLength(1);
    expect(second.notes).toEqual([]);
  });
});

describe("the script reader: refused addresses and the size read", () => {
  const throwing = (error: unknown): Fetcher =>
    ({ get: () => Promise.reject(error) }) as unknown as Fetcher;

  it("a redirect to a private address is 'refused (private address)', not 'answered 0'", async () => {
    const url = "https://x.test/a.js";
    const err = new FetchError("private-address-refused", "x.test resolves to 10.0.0.1.", url, [
      { url, status: 302, headers: {}, ms: 1 },
      {
        url: "http://10.0.0.1/a.js",
        status: 0,
        headers: {},
        ms: 0,
        error: "private-address-refused",
      },
    ]);
    expect(await createLibraries(throwing(err)).read(url)).toEqual({
      ok: false,
      url,
      reason: "refused (private address)",
    });
  });

  it("a last hop that was refused and not requested is the same reason", async () => {
    const url = "https://x.test/a.js";
    const fetcher = {
      get: async () => [
        {
          url: "http://10.0.0.1/a.js",
          status: 0,
          headers: {},
          ms: 0,
          error: "private-address-refused",
        },
      ],
    } as unknown as Fetcher;
    expect(await createLibraries(fetcher).read(url)).toMatchObject({
      ok: false,
      reason: "refused (private address)",
    });
  });

  it("asks the fetcher to stop at the size it searches, so a large file is not read whole", async () => {
    const seen: unknown[] = [];
    const fetcher = {
      get: async (_u: string, opts: unknown) => {
        seen.push(opts);
        return [
          {
            url: "https://x.test/a.js",
            status: 200,
            headers: {},
            ms: 1,
            body: "",
            truncated: true,
          },
        ];
      },
    } as unknown as Fetcher;
    const r = await createLibraries(fetcher).read("https://x.test/a.js", "https://shop.example/");
    expect(seen).toEqual([{ maxBytes: 2 * 1024 * 1024 }]);
    expect(r).toMatchObject({ ok: true, truncated: true });
  });

  it("asks for a script on the page's own site as the secret check does, so it is not asked for twice", async () => {
    const seen: unknown[] = [];
    const fetcher = {
      get: async (_u: string, opts: unknown) => {
        seen.push(opts);
        return [{ url: "https://shop.example/a.js", status: 200, headers: {}, ms: 1, body: "" }];
      },
    } as unknown as Fetcher;
    await createLibraries(fetcher).read("https://shop.example/a.js", "https://www.shop.example/");
    expect(seen).toEqual([undefined]);
  });
});
