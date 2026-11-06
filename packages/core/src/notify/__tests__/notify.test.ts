import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { startServer, type FixtureServer } from "../../__tests__/helpers/server.js";
import { createFetcher } from "../../fetcher.js";
import type { Finding } from "../../model.js";
import { buildResult, type Result } from "../../result.js";
import { discordPayload, slackPayload, webhookPayload, SLACK_SECTION_MAX } from "../payloads.js";
import { postJson, safeTarget } from "../post.js";
import { CHANNELS, notifyAll, resolveTargets, shouldNotify } from "../index.js";

const servers: FixtureServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

const f = (severity: Finding["severity"], i = 0, evidence = "e"): Finding => ({
  checkId: `check-${i}`,
  severity,
  title: `Finding ${i}`,
  evidence,
  url: "https://shop.example/",
});
const run = (findings: Finding[]): Result =>
  buildResult({
    url: "https://shop.example/",
    startedAt: new Date(0),
    findings,
    passed: ["noindex"],
    failed: [],
  });
const clean = run([]);
const mediumOnly = run([f("medium")]);
const high = run([f("high"), f("low", 1)]);

describe("notify: unit", () => {
  it("Slack: the ten most urgent findings, and how many more", () => {
    const many = run(Array.from({ length: 14 }, (_, i) => f(i < 2 ? "high" : "medium", i)));
    const p = slackPayload(many, "https://reports.example/r/1");
    const text = JSON.stringify(p);
    expect(text).toContain("Finding 0");
    expect(text).toContain("Finding 9");
    expect(text).not.toContain("Finding 10");
    expect(text).toContain("and 4 more");
    expect(text).toContain("https://reports.example/r/1");
    expect(p).toMatchSnapshot();
  });

  it("Slack: a payload over the size limit is trimmed, not rejected", () => {
    const p = slackPayload(run([f("high", 0, "x".repeat(10_000))]));
    for (const b of p.blocks)
      if (b.text) expect(b.text.text.length).toBeLessThanOrEqual(SLACK_SECTION_MAX);
    expect(JSON.stringify(p)).toContain("…");
  });

  it("Discord: an embed coloured by the worst finding", () => {
    expect(discordPayload(high).embeds[0]?.color).toBe(0xb42318);
    expect(discordPayload(mediumOnly).embeds[0]?.color).toBe(0xb54708);
    expect(discordPayload(clean).embeds[0]?.color).toBe(0x039855);
    expect(discordPayload(high)).toMatchSnapshot();
  });

  it("webhook: every finding as JSON, the same shape --json prints", () => {
    expect(webhookPayload(high)).toEqual(high);
  });

  it.each([
    ["any", [false, true, true]],
    ["high", [false, false, true]],
    ["always", [true, true, true]],
  ] as const)("--notify-on %s: clean, medium only, high", (mode, want) => {
    expect([clean, mediumOnly, high].map((r) => shouldNotify(r, mode))).toEqual(want);
  });

  it("a flag wins over the environment variable for the same channel", () => {
    const env = {
      GAUGELINE_SLACK_WEBHOOK: "https://hooks.example/env",
      GAUGELINE_WEBHOOK: "https://hooks.example/w",
    };
    const t = resolveTargets({ slack: "https://hooks.example/flag" }, env);
    expect(t).toEqual([
      { channel: "slack", url: "https://hooks.example/flag" },
      { channel: "webhook", url: "https://hooks.example/w" },
    ]);
    expect(CHANNELS.map((c) => c.id)).toEqual(["slack", "discord", "webhook"]);
  });

  it("a webhook address in an error is replaced with its host only", () => {
    expect(safeTarget("https://hooks.slack.com/services/T000/B000/SECRETPATH")).toBe(
      "hooks.slack.com",
    );
    expect(safeTarget("not a url")).toBe("the webhook");
  });
});

describe("notify: integration (a fixture server as the receiver)", () => {
  const receiver =
    (status: number, got: { path: string; body: string }[]) =>
    (req: IncomingMessage, res: ServerResponse) => {
      let body = "";
      req.on("data", (c: Buffer) => (body += c.toString()));
      req.on("end", () => {
        got.push({ path: req.url ?? "", body });
        res.writeHead(status).end();
      });
    };

  it("one channel returns 500: the other two still deliver", async () => {
    const got: { path: string; body: string }[] = [];
    const ok = await startServer({}, receiver(200, got));
    const bad = await startServer({}, receiver(500, got));
    servers.push(ok, bad);
    const results = await notifyAll(high, [
      { channel: "slack", url: `${ok.origin}/slack/T1/B1/secret` },
      { channel: "discord", url: `${bad.origin}/api/webhooks/1/secret` },
      { channel: "webhook", url: `${ok.origin}/hook/secret` },
    ]);
    expect(results.map((r) => [r.channel, r.ok])).toEqual([
      ["slack", true],
      ["discord", false],
      ["webhook", true],
    ]);
    expect(results[1]?.error).toBe("127.0.0.1 answered 500");
    expect(JSON.stringify(results)).not.toContain("secret");
    expect(
      got.filter((g) => g.path.startsWith("/hook")).map((g) => JSON.parse(g.body).schema),
    ).toEqual([2]);
  });

  it("this module is the single place POST is allowed: the read-only fetcher still refuses it", async () => {
    const fetcher = createFetcher({ allowPrivate: true });
    expect(() => fetcher.get("http://127.0.0.1:9/", { method: "POST" as never })).toThrow(
      "Gaugeline is read-only: refusing to send a POST request.",
    );
  });

  it("a webhook that never answers times out and the send reports it", async () => {
    const hang = await startServer({}, () => undefined);
    servers.push(hang);
    const started = Date.now();
    const r = await postJson(`${hang.origin}/never`, { a: 1 }, { timeoutMs: 300 });
    expect(r).toEqual({ ok: false, error: "127.0.0.1 did not answer within 0.3 seconds" });
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});
