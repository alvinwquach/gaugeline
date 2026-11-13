import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import type { Transport } from "../../fetcher.js";
import { createEgressGate, type GateRequest } from "../gate.js";
import { isThirdParty } from "../third-party.js";

/**
 * The refusal a load asks for itself (PERF-02): judged on a request's address and on every redirect hop, before the
 * transport is asked, counted as a block and towards the request cap, and able only to add refusals.
 */
const PAGE = "https://shop.example/";
const get = (url: string, kind = "script"): GateRequest => ({
  url,
  method: "GET",
  kind,
  frame: "main",
});

function world(table: Record<string, { status?: number; location?: string }>) {
  const asked: string[] = [];
  const transport: Transport = (url) => {
    asked.push(url.href);
    const hit = table[url.href] ?? {};
    const headers: Record<string, string> = hit.location
      ? { location: hit.location }
      : { "content-type": "application/javascript" };
    return Promise.resolve({
      status: hit.status ?? 200,
      headers,
      body: Readable.from([Buffer.from("x")]),
    });
  };
  return { transport, asked };
}
const refuseThirdScripts = (target: string, req: GateRequest) =>
  req.kind === "script" && isThirdParty(target, PAGE);

describe("the gate's own refusal", () => {
  it("refuses a script the callback names before the transport is asked, and counts it as variant", async () => {
    const w = world({});
    const gate = createEgressGate({ transport: w.transport, refuse: refuseThirdScripts });
    expect(await gate.handle(get("https://cdn.example.test/chat.js"))).toEqual({
      action: "abort",
      reason: "variant",
    });
    expect(w.asked).toEqual([]);
    expect(gate.state.blocked.variant).toBe(1);
    expect(gate.state.requests).toEqual([
      expect.objectContaining({
        url: "https://cdn.example.test/chat.js",
        verdict: "blocked",
        reason: "variant",
      }),
    ]);
  });

  it("lets what it does not name go through every other rule, as before", async () => {
    const w = world({});
    const gate = createEgressGate({ transport: w.transport, refuse: refuseThirdScripts });
    expect((await gate.handle(get("https://shop.example/app.js"))).action).toBe("fulfill");
    expect((await gate.handle(get("https://cdn.example.test/logo.png", "image"))).action).toBe(
      "fulfill",
    );
    expect(w.asked).toEqual(["https://shop.example/app.js", "https://cdn.example.test/logo.png"]);
    // Other rules still apply to what it lets through.
    expect(
      await gate.handle({ ...get("https://shop.example/a.js"), method: "POST" }),
    ).toMatchObject({ reason: "method" });
    expect(await gate.handle(get("ftp://shop.example/a.js"))).toMatchObject({ reason: "scheme" });
  });

  it("refuses a first-party script that redirects to another site, and never asks the other site", async () => {
    const w = world({
      "https://shop.example/old.js": { status: 302, location: "https://cdn.example.test/new.js" },
    });
    const gate = createEgressGate({ transport: w.transport, refuse: refuseThirdScripts });
    expect(await gate.handle(get("https://shop.example/old.js"))).toEqual({
      action: "abort",
      reason: "variant",
    });
    expect(w.asked).toEqual(["https://shop.example/old.js"]);
    expect(gate.state.blocked.variant).toBe(1);
  });

  it("follows a redirect that stays on the site, and one to a subdomain", async () => {
    const w = world({
      "https://shop.example/a.js": { status: 301, location: "https://cdn.shop.example/b.js" },
    });
    const gate = createEgressGate({ transport: w.transport, refuse: refuseThirdScripts });
    expect((await gate.handle(get("https://shop.example/a.js"))).action).toBe("fulfill");
    expect(w.asked).toEqual(["https://shop.example/a.js", "https://cdn.shop.example/b.js"]);
  });

  it("counts a refused request towards the request cap", async () => {
    const w = world({});
    const gate = createEgressGate({
      transport: w.transport,
      limits: { requests: 2 },
      refuse: refuseThirdScripts,
    });
    await gate.handle(get("https://a.example.test/1.js"));
    await gate.handle(get("https://a.example.test/2.js"));
    expect(gate.state.capped).toBeUndefined();
    await gate.handle(get("https://a.example.test/3.js"));
    expect(gate.state.capped).toBe("requests");
  });

  it("does nothing without the option: a third-party script is asked for like any request", async () => {
    const w = world({});
    const gate = createEgressGate({ transport: w.transport });
    expect((await gate.handle(get("https://cdn.example.test/chat.js"))).action).toBe("fulfill");
    expect(gate.state.blocked.variant).toBe(0);
  });

  it("fails closed: a callback that throws refuses the request, and nothing is asked", async () => {
    const w = world({});
    const gate = createEgressGate({
      transport: w.transport,
      refuse: () => {
        throw new Error("boom");
      },
    });
    expect(await gate.handle(get("https://shop.example/app.js"))).toEqual({
      action: "abort",
      reason: "variant",
    });
    expect(w.asked).toEqual([]);
  });

  it("fails closed on a redirect hop too", async () => {
    const w = world({
      "https://shop.example/a.js": { status: 302, location: "https://shop.example/b.js" },
    });
    let calls = 0;
    const gate = createEgressGate({
      transport: w.transport,
      refuse: () => {
        calls += 1;
        if (calls > 1) throw new Error("boom");
        return false;
      },
    });
    expect(await gate.handle(get("https://shop.example/a.js"))).toEqual({
      action: "abort",
      reason: "variant",
    });
    expect(w.asked).toEqual(["https://shop.example/a.js"]);
  });
});
