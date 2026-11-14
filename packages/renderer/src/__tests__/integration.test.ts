import { createNetworkTransport, createEgressGate, type GateRequest } from "@gaugeline/core";
import { startFixture, type Fixture } from "@gaugeline/fixtures";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * The egress gate over the real transport, against the invented bakery on a loopback socket. No
 * browser: each request a page would make is handed to the gate by hand. `allowPrivate` and `target`
 * are what the CLI passes for `--allow-private` (the address typed is trusted, nothing else is).
 */

let site: Fixture;
beforeAll(async () => {
  site = await startFixture("renderer-edges");
});
afterAll(async () => {
  await site.close();
});

const gate = (limits = {}) =>
  createEgressGate({
    transport: createNetworkTransport({ allowPrivate: true, target: site.origin }),
    limits,
  });
const at = (path: string, extra: Partial<GateRequest> = {}): GateRequest => ({
  url: `${site.origin}${path}`,
  method: "GET",
  kind: "document",
  frame: "main",
  ...extra,
});

describe("the egress gate against a real site on loopback", () => {
  it("serves the page and records the final address and status", async () => {
    const g = gate();
    const answer = await g.handle(at("/"));
    expect(answer).toMatchObject({ action: "fulfill", status: 200 });
    expect(g.state).toMatchObject({ status: 200, finalUrl: `${site.origin}/` });
    if (answer.action === "fulfill") expect(answer.body.toString()).toContain("Quillfeather");
  });

  it("answers a redirect one hop at a time and ends on the page it leads to", async () => {
    const g = gate();
    const first = await g.handle(at("/ok-redirect"));
    expect(first).toMatchObject({ action: "fulfill", status: 200 });
    expect(g.state.redirectPending).toBe(true);
    await g.handle(at("/about.html"));
    expect(g.state).toMatchObject({ status: 200, finalUrl: `${site.origin}/about.html` });
    expect(g.state.redirectPending).toBeUndefined();
  });

  it("refuses a redirect to a metadata address: it is asked for, and refused, without a socket", async () => {
    const g = gate();
    const first = await g.handle(at("/to-private"));
    expect(first).toMatchObject({ action: "fulfill" });
    // The browser comes back for the Location, and the transport's own refusal stops it.
    const next = await g.handle(at("", { url: "http://169.254.169.254/latest/meta-data/" }));
    expect(next).toEqual({ action: "abort", reason: "address" });
    expect(g.state.mainBlock).toBe("address");
  });

  it("refuses another port on the loopback address: only the address typed is trusted", async () => {
    const g = gate();
    expect(await g.handle(at("", { url: "http://127.0.0.1:1/" }))).toEqual({
      action: "abort",
      reason: "address",
    });
  });

  it("refuses private addresses a subresource names", async () => {
    const g = gate();
    for (const url of ["http://10.0.0.5/pixel.png", "http://[::1]:9/x", "http://192.168.1.1/"])
      expect(await g.handle(at("", { url, kind: "image" }))).toEqual({
        action: "abort",
        reason: "address",
      });
  });

  it("stops an infinite redirect at the cap", async () => {
    const g = gate({ redirects: 4 });
    const answers = [];
    for (let i = 0; i < 8; i++) answers.push((await g.handle(at("/loop"))).action);
    expect(answers.slice(0, 4)).toEqual(["fulfill", "fulfill", "fulfill", "fulfill"]);
    expect(answers[4]).toBe("abort");
    expect(g.state.capped).toBe("redirects");
  });

  it("stops a huge page at the size cap, reading no more than the cap", async () => {
    const g = gate({ responseBytes: 500_000 });
    expect(await g.handle(at("/huge"))).toEqual({ action: "abort", reason: "cap" });
    expect(g.state.capped).toBe("bytes");
    expect(g.state.bytes).toBe(0);
  });

  it("never sends a POST, a PUT or a DELETE: the site sees none", async () => {
    const g = gate();
    for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"])
      expect(await g.handle(at("/collect", { method, kind: "fetch" }))).toEqual({
        action: "abort",
        reason: "method",
      });
    await g.handle(at("/about.html"));
    expect([...site.methods.keys()].sort()).toEqual(["GET"]);
  });

  it("never reaches an analytics host", async () => {
    const g = gate();
    const before = site.total;
    for (const url of [
      "https://www.google-analytics.com/g/collect?v=2",
      "https://www.googletagmanager.com/gtag/js?id=G-QUILL00001",
      "https://px.ads.linkedin.com/collect/?pid=1",
    ])
      expect(await g.handle(at("", { url, kind: "script" }))).toEqual({
        action: "abort",
        reason: "analytics",
      });
    expect(site.total).toBe(before);
    expect(g.state.blocked.analytics).toBe(3);
  });
});
