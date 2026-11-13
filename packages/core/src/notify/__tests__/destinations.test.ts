import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { startServer, type FixtureServer } from "../../__tests__/helpers/server.js";
import { checkDestination, sendWithRetry, RETRY_DELAYS_MS } from "../destinations.js";
import { postJson } from "../post.js";
import { parseSentryDsn, sentryAuthHeader, sentryEvent } from "../sentry.js";
import { slackChangesPayload, type ChangedFinding } from "../slack.js";

// Invented addresses (rule 12), built at run time so nothing key-shaped sits in the source.
const SLACK = [
  "https://hooks.slack.com/services",
  "T0NORTHGATE",
  "B0TIDEWATER",
  "x".repeat(24),
].join("/");
const DSN = `https://${"a".repeat(32)}@o4500000000000001.ingest.sentry.io/4500000000000002`;

const servers: FixtureServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

const finding = (over: Partial<ChangedFinding> = {}): ChangedFinding => ({
  checkId: "broken-links",
  severity: "high",
  title: "Broken link on the menu page",
  evidence: "/menu links to /drinks-2025 (404)",
  url: "https://tidewater-bar.test/menu",
  fingerprint: "0123456789abcdef",
  ...over,
});

describe("checkDestination: what may be saved and sent to", () => {
  it("accepts a Slack incoming webhook on hooks.slack.com and a Sentry DSN on an ingest host", () => {
    const s = checkDestination("slack", SLACK);
    expect(s).toMatchObject({ ok: true, host: "hooks.slack.com" });
    const d = checkDestination("sentry", DSN);
    expect(d).toMatchObject({ ok: true, host: "o4500000000000001.ingest.sentry.io" });
    // The address sent to carries no userinfo: the key travels in a header.
    expect(d.ok && d.endpoint).toBe(
      "https://o4500000000000001.ingest.sentry.io/api/4500000000000002/store/",
    );
    expect(checkDestination("sentry", DSN.replace(".ingest.", ".ingest.us."))).toMatchObject({
      ok: true,
    });
  });

  it.each([
    ["http, not https", SLACK.replace("https:", "http:")],
    ["a look-alike host", SLACK.replace("hooks.slack.com", "hooks.slack.com.evil.test")],
    ["another Slack host", SLACK.replace("hooks.slack.com", "slack.com")],
    ["userinfo", SLACK.replace("https://", "https://me:pw@")],
    ["a port", SLACK.replace("hooks.slack.com", "hooks.slack.com:8443")],
    ["an IP address", SLACK.replace("hooks.slack.com", "127.0.0.1")],
    ["a path that is not a webhook", "https://hooks.slack.com/api/chat.postMessage"],
    ["a query string", `${SLACK}?x=1`],
    ["not an address", "slack please"],
  ])("refuses a Slack address with %s", (_, url) => {
    const r = checkDestination("slack", url);
    expect(r.ok).toBe(false);
    // The reason never repeats the address: it is a secret.
    expect(JSON.stringify(r)).not.toContain("T0NORTHGATE");
  });

  it.each([
    ["a non-Sentry host", DSN.replace("ingest.sentry.io", "ingest.sentry.io.evil.test")],
    ["no key", DSN.replace(`${"a".repeat(32)}@`, "")],
    ["a secret key part", DSN.replace("@", ":secret@")],
    ["a project that is not a number", DSN.replace(/\/\d+$/, "/project")],
    ["http", DSN.replace("https:", "http:")],
  ])("refuses a Sentry DSN with %s", (_, dsn) => {
    expect(checkDestination("sentry", dsn).ok).toBe(false);
  });

  it("refuses GitHub for now: it needs a write token we do not hold (ADR-0010)", () => {
    expect(checkDestination("github" as never, "https://github.com/a/b")).toMatchObject({
      ok: false,
    });
  });
});

describe("Slack message wording", () => {
  it("names the site, each new finding with its evidence and link, and how many were fixed", () => {
    const p = slackChangesPayload(
      {
        site: "The Tidewater Bar",
        siteUrl: "https://tidewater-bar.test",
        opened: [finding()],
        closed: 2,
        stillOpen: 1,
      },
      "https://app.example/sites/a1",
    );
    const text = JSON.stringify(p.blocks);
    expect(p.text).toBe("Gaugeline: The Tidewater Bar has 1 new finding, 2 fixed");
    expect(text).toContain("*Fix this first:* Broken link on the menu page");
    expect(text).toContain("`/menu links to /drinks-2025 (404)`");
    expect(text).toContain("https://tidewater-bar.test/menu");
    expect(text).toContain("<https://app.example/sites/a1|Open in Gaugeline>");
    expect(text).toContain("1 still open");
  });

  it("only fixed: one line, no finding sections", () => {
    const p = slackChangesPayload({
      site: "Juniper Pop-up Kitchen",
      siteUrl: "https://juniper-popup.test",
      opened: [],
      closed: 1,
      stillOpen: 0,
    });
    expect(p.text).toBe("Gaugeline: Juniper Pop-up Kitchen has 1 fixed");
    expect(p.blocks).toHaveLength(1);
  });

  it("text from a site is data: no mentions, links or markup survive", () => {
    const p = slackChangesPayload({
      site: "Bar <!channel> *now*",
      siteUrl: "https://tidewater-bar.test",
      opened: [
        finding({
          title: "<!here> click <https://evil.test|here> *bold* _it_ ~s~",
          evidence: "`code` <@U123> @channel",
          url: "https://tidewater-bar.test/<!everyone>",
        }),
      ],
      closed: 0,
      stillOpen: 0,
    });
    const all = JSON.stringify(p);
    expect(all).not.toMatch(/<!(channel|here|everyone)>/);
    expect(all).not.toContain("<https://evil.test|");
    expect(all).not.toContain("<@U123>");
    expect(all).not.toContain("*bold*");
    expect(all).toContain("&lt;!here&gt;");
  });

  it("lists at most ten new findings, most urgent first, and says how many more", () => {
    const opened = Array.from({ length: 13 }, (_, i) =>
      finding({ title: `F${i}`, severity: i === 12 ? "high" : "low", fingerprint: `fp${i}` }),
    );
    const p = slackChangesPayload({
      site: "S",
      siteUrl: "https://s.test",
      opened,
      closed: 0,
      stillOpen: 0,
    });
    const text = JSON.stringify(p.blocks);
    expect(text.indexOf("F12")).toBeLessThan(text.indexOf("F0"));
    expect(text).toContain("and 3 more");
    expect(text).not.toContain("F10");
  });
});

describe("Sentry: one finding, one issue", () => {
  it("parses a DSN into the store endpoint and the public key", () => {
    expect(parseSentryDsn(DSN)).toEqual({
      host: "o4500000000000001.ingest.sentry.io",
      projectId: "4500000000000002",
      publicKey: "a".repeat(32),
    });
    expect(sentryAuthHeader("a".repeat(32))).toBe(
      `Sentry sentry_version=7, sentry_client=gaugeline/1, sentry_key=${"a".repeat(32)}`,
    );
  });

  it("groups by the finding's fingerprint, so the same finding on another night is the same issue", () => {
    const a = sentryEvent(finding(), "The Tidewater Bar", new Date("2026-11-10T03:01:00Z"));
    const b = sentryEvent(finding(), "The Tidewater Bar", new Date("2026-11-12T03:01:00Z"));
    expect(a.fingerprint).toEqual(["gaugeline", "0123456789abcdef"]);
    expect(b.fingerprint).toEqual(a.fingerprint);
    expect(a.event_id).not.toBe(b.event_id);
    expect(a.event_id).toMatch(/^[0-9a-f]{32}$/);
    expect(a).toMatchObject({
      level: "error",
      logger: "gaugeline",
      message: { formatted: "Broken link on the menu page" },
      tags: { check: "broken-links", site: "The Tidewater Bar" },
      extra: {
        evidence: "/menu links to /drinks-2025 (404)",
        url: "https://tidewater-bar.test/menu",
      },
    });
    expect(sentryEvent(finding({ severity: "low" }), "S", new Date()).level).toBe("info");
  });

  it("page text is cleaned of control and direction characters", () => {
    const rlo = String.fromCharCode(0x202e);
    const bell = String.fromCharCode(7);
    const e = sentryEvent(finding({ title: `a${rlo}b${bell}c` }), "S", new Date());
    expect(e.message.formatted).not.toContain(rlo);
    expect(e.message.formatted).not.toContain(bell);
  });
});

describe("sending: the address guard and retries", () => {
  it("publicOnly refuses an address in a private range before connecting", async () => {
    let hits = 0;
    const s = await startServer({}, (_q: IncomingMessage, res: ServerResponse) => {
      hits += 1;
      res.end("ok");
    });
    servers.push(s);
    const r = await postJson(`${s.origin}/hook`, { text: "x" }, { publicOnly: true });
    expect(r.ok).toBe(false);
    expect(r.error).toBe("127.0.0.1 is not a public address: nothing was sent");
    expect(hits).toBe(0);
  });

  it("retries a failed send with backoff, then reports the last answer", async () => {
    const waits: number[] = [];
    let calls = 0;
    const r = await sendWithRetry(
      async () => {
        calls += 1;
        return { ok: false, status: 503, error: "hooks.slack.com answered 503" };
      },
      { sleep: async (ms) => void waits.push(ms) },
    );
    expect(calls).toBe(RETRY_DELAYS_MS.length + 1);
    expect(waits).toEqual([...RETRY_DELAYS_MS]);
    expect(r).toMatchObject({ ok: false, status: 503, attempts: 3 });
  });

  it("does not retry an answer that will not change (a revoked webhook)", async () => {
    let calls = 0;
    const r = await sendWithRetry(
      async () => {
        calls += 1;
        return { ok: false, status: 404, error: "hooks.slack.com answered 404" };
      },
      { sleep: async () => {} },
    );
    expect(calls).toBe(1);
    expect(r).toMatchObject({ ok: false, status: 404, attempts: 1, permanent: true });
  });

  it("stops retrying once one attempt succeeds", async () => {
    let calls = 0;
    const r = await sendWithRetry(
      async () => (++calls < 2 ? { ok: false, error: "timeout" } : { ok: true, status: 200 }),
      { sleep: async () => {} },
    );
    expect(r).toMatchObject({ ok: true, attempts: 2 });
  });
});
