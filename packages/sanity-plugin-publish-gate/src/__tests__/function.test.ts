import { describe, expect, it, vi } from "vitest";
import { checkDocument, gateHandler, type GateOutcome } from "../function.js";
import {
  SITE,
  barSite,
  downSite,
  hasHiddenCharacters,
  memorySite,
  type MemoryPage,
} from "./helpers.js";

const now = () => new Date("2026-11-12T10:00:00Z");
const pages = { page: "/{slug}", product: "/shop/{slug}", siteSettings: null } as const;

function world(menuBody: string, extra: Record<string, MemoryPage> = {}) {
  const seen: { method: string; url: string }[] = [];
  const transport = memorySite(barSite(menuBody, extra), seen);
  const reported: GateOutcome[] = [];
  const options = {
    site: SITE,
    pages,
    transport,
    now,
    report: (entry: GateOutcome) => void reported.push(entry),
  };
  return { options, seen, reported };
}

const menuDoc = { _id: "menu-page", _type: "page", slug: { current: "menu" } };

describe("the post-publish Function", () => {
  it("a write through the API that broke a page becomes a finding that names the link", async () => {
    const { options, reported } = world('<a href="/menu/old-cocktails">Old cocktails</a>');
    const outcome = await checkDocument(menuDoc, options);
    expect(outcome.status).toBe("slipped");
    if (outcome.status !== "slipped") return;
    expect(outcome.url).toBe(`${SITE}/menu`);
    expect(outcome.findings.map((f) => f.id)).toContain("broken-links");
    expect(outcome.findings.find((f) => f.id === "broken-links")?.evidence).toContain(
      "/menu/old-cocktails",
    );
    // The sink is the only place anything is recorded.
    await gateHandler(options)({ event: { data: menuDoc } });
    expect(reported).toHaveLength(1);
    expect(reported[0]).toMatchObject({ status: "slipped", documentId: "menu-page", type: "page" });
  });

  it("a page that is right records nothing", async () => {
    const { options, reported } = world('<a href="/">Back to the bar</a>');
    expect((await checkDocument(menuDoc, options)).status).toBe("clean");
    await gateHandler(options)({ event: { data: menuDoc } });
    expect(reported).toEqual([]);
  });

  it("a document that renders to no page is not gated and nothing is requested", async () => {
    const { options, seen, reported } = world("<p>x</p>");
    const outcome = await checkDocument({ _id: "settings", _type: "siteSettings" }, options);
    expect(outcome).toMatchObject({ status: "not-gated", type: "siteSettings" });
    expect(seen).toEqual([]);
    expect(reported).toEqual([]);
  });

  it("a draft is not a publish: not gated", async () => {
    const { options, seen } = world("<p>x</p>");
    const outcome = await checkDocument({ ...menuDoc, _id: "drafts.menu-page" }, options);
    expect(outcome.status).toBe("not-gated");
    expect(seen).toEqual([]);
  });

  it("when the site is down the Function records that it could not check, and does not throw", async () => {
    const { options, reported } = world("<p>x</p>");
    const down = { ...options, transport: downSite };
    expect(await checkDocument(menuDoc, down)).toMatchObject({
      status: "could-not-check",
      url: `${SITE}/menu`,
    });
    await expect(gateHandler(down)({ event: { data: menuDoc } })).resolves.toBeUndefined();
    expect(reported).toHaveLength(1);
    expect(reported[0]).toMatchObject({ status: "could-not-check", documentId: "menu-page" });
  });

  it("a slug that cannot be trusted is recorded as could-not-check and no request is made", async () => {
    const { options, seen } = world("<p>x</p>");
    const outcome = await checkDocument({ _id: "p", _type: "page", slug: "../admin" }, options);
    expect(outcome).toMatchObject({
      status: "could-not-check",
      reason: expect.stringContaining("slug"),
    });
    expect(seen).toEqual([]);
  });

  it("a release version is not published: not gated, nothing requested", async () => {
    const { options, seen } = world("<p>x</p>");
    const outcome = await checkDocument({ ...menuDoc, _id: "versions.rAutumn.menu-page" }, options);
    expect(outcome.status).toBe("not-gated");
    expect(seen).toEqual([]);
  });

  it("a document typed with a hidden character is not gated as the page type it imitates", async () => {
    const { options, seen } = world("<p>x</p>");
    const outcome = await checkDocument({ ...menuDoc, _type: "\u202epage" }, options);
    expect(outcome.status).toBe("not-gated");
    expect(seen).toEqual([]);
  });

  it("an id with a hidden character in front of drafts. or versions. is still a draft", async () => {
    const { options, seen } = world("<p>x</p>");
    for (const id of [
      "\u200bdrafts.menu-page",
      "\ufeffversions.r.menu-page",
      "\u202edrafts.menu-page",
    ]) {
      const outcome = await checkDocument({ ...menuDoc, _id: id }, options);
      expect(outcome.status, id).toBe("not-gated");
    }
    expect(seen).toEqual([]);
  });

  it("an envelope with no event is could-not-check, not a TypeError", async () => {
    const { options, reported } = world("<p>x</p>");
    const handler = gateHandler(options) as (e: unknown) => Promise<void>;
    for (const envelope of [{}, undefined, null, { event: null }]) await handler(envelope);
    expect(reported).toHaveLength(4);
    expect(reported.every((r) => r.status === "could-not-check")).toBe(true);
  });

  it("an id that carries control or bidi characters is cleaned before it reaches a report sink", async () => {
    const { options, reported } = world("<p>x</p>");
    const documentId = `a\u001bb\u202ec${"y".repeat(5000)}`;
    await gateHandler(options)({
      event: { data: { _id: documentId, _type: "page", slug: "../x" } },
    });
    expect(reported).toHaveLength(1);
    expect(hasHiddenCharacters(reported[0]?.documentId ?? "")).toBe(false);
    expect(reported[0]?.documentId.length).toBeLessThanOrEqual(200);
  });

  it("an event with no document in it is could-not-check, not an exception", async () => {
    const { options } = world("<p>x</p>");
    for (const data of [undefined, null, "text", 42, [], {}]) {
      expect((await checkDocument(data, options)).status, JSON.stringify(data)).toBe(
        "could-not-check",
      );
    }
  });

  it("two deliveries of the same publish at once agree and do not interfere", async () => {
    const { options } = world('<a href="/gone">Gone</a>');
    const [a, b] = await Promise.all([
      checkDocument(menuDoc, options),
      checkDocument(menuDoc, options),
    ]);
    expect(a.status).toBe("slipped");
    expect(b).toEqual(a);
  });

  it("waits settleMs before it reads the page, so a rebuild can finish", async () => {
    const { options } = world('<a href="/">Home</a>');
    const order: string[] = [];
    const wait = vi.fn(async (ms: number) => void order.push(`wait ${ms}`));
    const transport = memorySite(barSite('<a href="/">Home</a>'));
    const spy: typeof transport = (url, req) => {
      order.push(`get ${url.pathname}`);
      return transport(url, req);
    };
    await checkDocument(menuDoc, { ...options, transport: spy, settleMs: 4000, wait });
    expect(order[0]).toBe("wait 4000");
    expect(order[1]).toBe("get /menu");
  });

  it("the Function's own token never reaches the output, the sink or the log", async () => {
    const token = ["sk", "live", "abcdef123456"].join("_");
    const { options } = world('<a href="/gone">Gone</a>');
    const lines: string[] = [];
    const log = vi
      .spyOn(console, "log")
      .mockImplementation((...args: unknown[]) => void lines.push(args.join(" ")));
    try {
      const sink: GateOutcome[] = [];
      const envelope = {
        event: { data: menuDoc },
        context: { clientOptions: { token, projectId: "abc123", dataset: "production" } },
      };
      await gateHandler({ ...options, report: (e) => void sink.push(e) })(envelope);
      await gateHandler({ site: options.site, pages, transport: options.transport, now })(envelope);
      expect(JSON.stringify(sink)).not.toContain(token);
      expect(lines.length).toBe(1);
      expect(lines.join("\n")).not.toContain(token);
      expect(lines[0]).not.toContain("abc123");
    } finally {
      log.mockRestore();
    }
  });

  it("without a sink it writes one JSON line per problem to the Function's log", async () => {
    const { options } = world('<a href="/gone">Gone</a>');
    const lines: string[] = [];
    const log = vi
      .spyOn(console, "log")
      .mockImplementation((...args: unknown[]) => void lines.push(args.join(" ")));
    try {
      await gateHandler({ site: SITE, pages, transport: options.transport, now })({
        event: { data: menuDoc },
      });
    } finally {
      log.mockRestore();
    }
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? "")).toMatchObject({
      gaugeline: "publish-gate",
      status: "slipped",
    });
  });

  it("never sends anything but GET and HEAD", async () => {
    const { options, seen } = world('<a href="/gone">Gone</a>');
    await gateHandler(options)({ event: { data: menuDoc } });
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((s) => s.method === "GET" || s.method === "HEAD")).toBe(true);
  });
});
