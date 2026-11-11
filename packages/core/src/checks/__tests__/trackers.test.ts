import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SITES_DIR } from "../../../../fixtures/src/index.js";
import { staticSite } from "../../../../testkit/src/index.js";
import { createFetcher, type Transport } from "../../fetcher.js";
import type { CheckContext } from "../../model.js";
import { checkSite } from "../../site.js";
import { createPageRegistry } from "../index.js";
import type { Tracker } from "../../trackers/fingerprints.js";
import { addTrackerChecks } from "../../trackers/registry.js";
import { createTrackers, type ContainerRead, type Trackers } from "../../trackers/reader.js";
import { TRACKER_CHECKS, trackerInTagManager, trackerOnSensitivePage } from "../trackers.js";
import { answer, bookingPage, containerHost } from "../../trackers/__tests__/world.js";
import { page } from "./helpers.js";

const CLINIC = "meadowlark.example";
const CLINIC_DIR = join(SITES_DIR, "clinic-trackers");

const meta: Tracker = {
  kind: "meta-pixel",
  label: "Meta pixel",
  group: "advertising",
  ids: ["123456789012345"],
  how: "script",
};

function fakeTrackers(
  containers: Record<string, ContainerRead> = {},
  sensitivePaths?: string[],
): Trackers {
  return {
    config: sensitivePaths ? { sensitivePaths } : {},
    container: async (id) => containers[id] ?? { ok: false, id, reason: `${id} gave no answer.` },
  };
}

function context(trackers?: Trackers) {
  const notes: { url: string; reason: string }[] = [];
  const ctx: CheckContext = {
    warn: () => undefined,
    couldNotCheck: (url, reason) => void notes.push({ url, reason }),
    ...(trackers ? { trackers } : {}),
  };
  return { ctx, notes };
}

const formPage = (over: Parameters<typeof page>[0] = {}) =>
  page({
    finalUrl: `https://${CLINIC}/intake`,
    forms: [
      {
        action: "https://intake.carelink-forms.example/submit",
        method: "post",
        hiddenFields: [],
        fieldNames: ["full_name"],
        position: 0,
      },
    ],
    scriptTags: [{ inline: "fbq('init', '123456789012345');", position: 1 }],
    ...over,
  });

describe("the tracker checks: unit", () => {
  it("there are two, low severity, in the order the docs list them", () => {
    expect(TRACKER_CHECKS.map((c) => [c.id, c.severity])).toEqual([
      ["tracker-on-sensitive-page", "low"],
      ["tracker-in-tag-manager", "low"],
    ]);
  });

  it.each(TRACKER_CHECKS.map((c) => [c.id, c] as const))(
    "%s does nothing without --trackers",
    async (_id, check) => {
      const { ctx, notes } = context();
      expect(await check.run(formPage(), ctx)).toEqual([]);
      expect(notes).toEqual([]);
    },
  );

  it("names the tracker, its id, the page and why the page counts, as facts", async () => {
    const { ctx } = context(fakeTrackers());
    const found = await trackerOnSensitivePage.run(formPage(), ctx);
    expect(found).toEqual([
      {
        checkId: "tracker-on-sensitive-page",
        severity: "low",
        title: "Trackers load on a page with a form or a listed path",
        evidence:
          "Meta pixel (id 123456789012345) loads on /intake, a page with a form that sends to intake.carelink-forms.example",
        url: `https://${CLINIC}/intake`,
      },
    ]);
  });

  it("finds nothing on a page with no form and no listed path, even with a pixel on it", async () => {
    const { ctx } = context(fakeTrackers());
    const blog = formPage({ finalUrl: `https://${CLINIC}/blog`, forms: [] });
    expect(await trackerOnSensitivePage.run(blog, ctx)).toEqual([]);
  });

  it("finds nothing on a page with a form and no tracker", async () => {
    const { ctx } = context(fakeTrackers());
    expect(await trackerOnSensitivePage.run(formPage({ scriptTags: [] }), ctx)).toEqual([]);
  });

  it("a listed path makes a page without a form count", async () => {
    const { ctx } = context(fakeTrackers({}, ["/conditions/*"]));
    const p = formPage({ finalUrl: `https://${CLINIC}/conditions/asthma`, forms: [] });
    const found = await trackerOnSensitivePage.run(p, ctx);
    expect(found.map((f) => f.evidence)).toEqual([
      "Meta pixel (id 123456789012345) loads on /conditions/asthma, a page listed in gaugeline.trackers.json (/conditions/*)",
    ]);
  });

  it("says 'is in the HTML of' for a tag only the noscript fallback carries, and omits an id the code does not carry", async () => {
    const { ctx } = context(fakeTrackers());
    const noscript = formPage({
      scriptTags: [{ src: "https://connect.facebook.net/en_US/fbevents.js", position: 1 }],
    });
    const found = await trackerOnSensitivePage.run(noscript, ctx);
    expect(found[0]?.evidence.startsWith("Meta pixel loads on /intake")).toBe(true);
    const onlyHtml = formPage({
      scriptTags: [],
      hops: [
        {
          url: `https://${CLINIC}/intake`,
          status: 200,
          headers: {},
          ms: 1,
          body: '<noscript><img src="https://www.facebook.com/tr?id=123456789012345"></noscript>',
        },
      ],
    });
    expect((await trackerOnSensitivePage.run(onlyHtml, ctx))[0]?.evidence).toMatch(
      /^Meta pixel \(id 123456789012345\) is in the HTML of \/intake, /,
    );
  });

  it("never says anything about legality", async () => {
    const { ctx } = context(fakeTrackers());
    const all = [
      ...(await trackerOnSensitivePage.run(formPage(), ctx)),
      ...TRACKER_CHECKS.flatMap((c) => [c.title, c.what, c.why, c.fix, c.tech, c.done]),
    ]
      .map((x) => (typeof x === "string" ? x : `${x.title} ${x.evidence}`))
      .join("\n");
    expect(all).not.toMatch(/illegal|unlawful|violat|non-?complian|HIPAA|GDPR|breach/i);
    expect(all).toMatch(/own counsel/);
  });
});

describe("tracker-in-tag-manager: unit", () => {
  const gtmPage = (over: Parameters<typeof page>[0] = {}) =>
    formPage({
      scriptTags: [{ src: "https://www.googletagmanager.com/gtm.js?id=GTM-ABC1234", position: 1 }],
      ...over,
    });

  it("lists what the container holds and says it does not know whether a tag fires here", async () => {
    const trackers = fakeTrackers({
      "GTM-ABC1234": { ok: true, id: "GTM-ABC1234", trackers: [meta], truncated: false },
    });
    const { ctx, notes } = context(trackers);
    const found = await trackerInTagManager.run(gtmPage(), ctx);
    expect(found.map((f) => f.evidence)).toEqual([
      "Tag Manager container GTM-ABC1234 holds Meta pixel (id 123456789012345); it loads on /intake, a page with a form that sends to intake.carelink-forms.example. Whether it fires there depends on the container's triggers, which Gaugeline does not run",
    ]);
    expect(notes).toEqual([]);
  });

  it("a container that cannot be read is could-not-check with the reason, not a pass", async () => {
    const { ctx, notes } = context(
      fakeTrackers({
        "GTM-ABC1234": { ok: false, id: "GTM-ABC1234", reason: "GTM-ABC1234 answered 404." },
      }),
    );
    expect(await trackerInTagManager.run(gtmPage(), ctx)).toEqual([]);
    expect(notes).toEqual([
      {
        url: `https://${CLINIC}/intake`,
        reason: "The Tag Manager container GTM-ABC1234 answered 404. What it holds was not listed.",
      },
    ]);
  });

  it("a container longer than the read cap is listed, with a note that the list may be short", async () => {
    const { ctx, notes } = context(
      fakeTrackers({
        "GTM-ABC1234": { ok: true, id: "GTM-ABC1234", trackers: [meta], truncated: true },
      }),
    );
    expect(await trackerInTagManager.run(gtmPage(), ctx)).toHaveLength(1);
    expect(notes[0]?.reason).toMatch(/longer than Gaugeline reads/);
  });

  it("reads at most three containers, and notes the rest", async () => {
    const ids = ["GTM-AAA1111", "GTM-BBB2222", "GTM-CCC3333", "GTM-DDD4444"];
    const reads = Object.fromEntries(
      ids.map((id) => [id, { ok: true, id, trackers: [], truncated: false } as ContainerRead]),
    );
    const asked: string[] = [];
    const trackers: Trackers = {
      config: {},
      container: async (id) => {
        asked.push(id);
        return reads[id] as ContainerRead;
      },
    };
    const { ctx, notes } = context(trackers);
    const p = gtmPage({
      scriptTags: ids.map((id, position) => ({
        src: `https://www.googletagmanager.com/gtm.js?id=${id}`,
        position,
      })),
    });
    await trackerInTagManager.run(p, ctx);
    expect(asked).toEqual(ids.slice(0, 3));
    expect(notes.map((n) => n.reason)).toEqual([
      "GTM-DDD4444 was not read: at most 3 Tag Manager containers are read for one page.",
    ]);
  });

  it("reads no container for a page that does not count, or that loads none", async () => {
    const asked: string[] = [];
    const trackers: Trackers = {
      config: {},
      container: async (id) => {
        asked.push(id);
        return { ok: true, id, trackers: [], truncated: false };
      },
    };
    const { ctx } = context(trackers);
    await trackerInTagManager.run(gtmPage({ forms: [] }), ctx);
    await trackerInTagManager.run(formPage(), ctx);
    expect(asked).toEqual([]);
  });
});

// ---- integration: the invented clinic, answered in memory ------------------------------------

interface Seen {
  method: string;
  url: string;
}

function clinicTransport(seen: Seen[], container?: { status: number; body?: string }): Transport {
  const site = staticSite(CLINIC, CLINIC_DIR, containerHost(container));
  return (url, req) => {
    seen.push({ method: req.method, url: url.href });
    if (url.hostname === CLINIC && url.pathname === "/book")
      return answer(
        200,
        "text/html; charset=utf-8",
        bookingPage("Book a visit | Meadowlark", `https://${CLINIC}`),
        req.method,
      );
    return site(url, req);
  };
}

async function runOn(
  path: string,
  opts: {
    sensitivePaths?: string[];
    container?: { status: number; body?: string };
    off?: boolean;
  } = {},
) {
  const seen: Seen[] = [];
  const fetcher = createFetcher({
    transport: clinicTransport(seen, opts.container),
    timeoutMs: 5000,
  });
  const registry = opts.off ? createPageRegistry() : addTrackerChecks(createPageRegistry());
  const { result } = await checkSite({
    address: `https://${CLINIC}${path}`,
    fetcher,
    registry,
    only: TRACKER_CHECKS.map((c) => c.id).filter((id) => registry.has(id)),
    ...(opts.off
      ? {}
      : {
          trackers: createTrackers(
            opts.sensitivePaths ? { sensitivePaths: opts.sensitivePaths } : {},
            fetcher,
          ),
        }),
  });
  return { result, seen };
}

const summary = (r: Awaited<ReturnType<typeof runOn>>["result"]) =>
  r.findings.map((f) => [f.checkId, f.evidence]);

describe("trackers on sensitive pages: the invented clinic (integration)", () => {
  it("finds the pixel, analytics and session replay on the intake page", async () => {
    const { result } = await runOn("/intake");
    expect(summary(result)).toEqual([
      [
        "tracker-on-sensitive-page",
        "Meta pixel (id 123456789012345) loads on /intake, a page with a form that sends to intake.carelink-forms.example",
      ],
      [
        "tracker-on-sensitive-page",
        "Google Analytics 4 (id G-MEAD0W4K1Z) loads on /intake, a page with a form that sends to intake.carelink-forms.example",
      ],
      [
        "tracker-on-sensitive-page",
        "Hotjar session replay (id 3400001) loads on /intake, a page with a form that sends to intake.carelink-forms.example",
      ],
    ]);
    expect(result.findings.every((f) => f.severity === "low")).toBe(true);
    expect(result.couldNotCheck).toEqual([]);
  });

  it("finds nothing on the blog, which has no form and no tracker", async () => {
    const { result } = await runOn("/blog");
    expect(result.findings).toEqual([]);
    expect(result.passed).toEqual(expect.arrayContaining(["tracker-on-sensitive-page"]));
  });

  it("finds nothing on the home page: Google Analytics is there, but it has no form", async () => {
    expect((await runOn("/")).result.findings).toEqual([]);
  });

  it("a page about a condition counts only when the settings list it", async () => {
    expect((await runOn("/conditions/asthma")).result.findings).toEqual([]);
    const listed = await runOn("/conditions/asthma", { sensitivePaths: ["/conditions/*"] });
    expect(summary(listed.result)).toEqual([
      [
        "tracker-on-sensitive-page",
        "LinkedIn Insight Tag (id 5100001) loads on /conditions/asthma, a page listed in gaugeline.trackers.json (/conditions/*)",
      ],
    ]);
  });

  it("reads a Tag Manager container once, with GET, and lists what it holds", async () => {
    const { result, seen } = await runOn("/book");
    expect(summary(result)).toEqual([
      [
        "tracker-on-sensitive-page",
        "Google Tag Manager container (id GTM-ABC1234) loads on /book, a page with a form",
      ],
      [
        "tracker-in-tag-manager",
        "Tag Manager container GTM-ABC1234 holds Meta pixel (id 123456789012345); it loads on /book, a page with a form. Whether it fires there depends on the container's triggers, which Gaugeline does not run",
      ],
      [
        "tracker-in-tag-manager",
        "Tag Manager container GTM-ABC1234 holds Google Analytics 4 (id G-MEAD0W4K1Z); it loads on /book, a page with a form. Whether it fires there depends on the container's triggers, which Gaugeline does not run",
      ],
    ]);
    const containerGets = seen.filter((s) => s.url.startsWith("https://www.googletagmanager.com/"));
    expect(containerGets).toEqual([
      { method: "GET", url: "https://www.googletagmanager.com/gtm.js?id=GTM-ABC1234" },
    ]);
  });

  it("a container that answers 404 is could-not-check, and the page's own trackers are still listed", async () => {
    const { result } = await runOn("/book", { container: { status: 404 } });
    expect(result.findings.map((f) => f.checkId)).toEqual(["tracker-on-sensitive-page"]);
    expect(result.couldNotCheck).toEqual([
      {
        id: "tracker-in-tag-manager",
        reason: "The Tag Manager container GTM-ABC1234 answered 404. What it holds was not listed.",
        url: `https://${CLINIC}/book`,
      },
    ]);
  });

  it("never reads a container for a page that does not count", async () => {
    const { seen } = await runOn("/blog");
    expect(seen.some((s) => s.url.includes("googletagmanager"))).toBe(false);
  });

  it("is not in a run without --trackers: no finding, and no request to a tag manager", async () => {
    const { result, seen } = await runOn("/book", { off: true });
    expect(result.findings).toEqual([]);
    expect(seen.some((s) => s.url.includes("googletagmanager"))).toBe(false);
  });

  it("only ever sends GET or HEAD, and finds the same on a second run", async () => {
    const a = await runOn("/intake");
    const b = await runOn("/intake");
    expect(a.seen.every((s) => s.method === "GET" || s.method === "HEAD")).toBe(true);
    expect(summary(b.result)).toEqual(summary(a.result));
  });

  it("no form field name or value, and no text of the page, reaches a finding", async () => {
    const { result } = await runOn("/intake");
    const text = JSON.stringify(result);
    for (const word of ["full_name", "date_of_birth", "reason", "nurse", "Meadowlark"])
      expect(text).not.toContain(word);
  });
});
