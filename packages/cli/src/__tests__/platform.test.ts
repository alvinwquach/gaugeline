// check-community: allow-email (invented addresses at reserved example domains, inside the stand-in for Stripe's responses)
import { resultSchema } from "@gaugeline/core";
import { providerTransport, type FakeProviders, type SeenRequest } from "@gaugeline/testkit";
import { describe, expect, it } from "vitest";
import { parseCliArgs } from "../args.js";
import { EXIT, main } from "../main.js";
import { runBin } from "./helpers/bin.js";

// Key-shaped values are put together at run time: GitHub push protection rejects literals.
const RK = ["rk", "live", "Tideline0123456789abcdef"].join("_");
const NOW = new Date("2026-11-10T12:00:00Z");
const DAY = 24 * 3600 * 1000;
const ENV = { STRIPE_API_KEY: RK };

const events = Array.from({ length: 14 }, (_, i) => ({
  type: "checkout.session.completed",
  at: new Date(NOW.getTime() - 6 * DAY + i * 3600 * 1000).toISOString(),
  pending: 1,
}));

async function platform(
  argv: string[],
  spec: FakeProviders,
  env: Record<string, string | undefined> = ENV,
  seen: SeenRequest[] = [],
) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await main(
    ["platform", ...argv],
    { stdout: { write: (s) => out.push(s) }, stderr: { write: (s) => err.push(s) }, env },
    {
      now: () => NOW,
      sleep: () => Promise.resolve(),
      fetcher: { transport: providerTransport(spec, seen), timeoutMs: 5000 },
    },
  );
  return { code, out: out.join(""), err: err.join("") };
}

describe("gaugeline platform --webhooks", () => {
  it("needs --webhooks, and takes no address", () => {
    expect(parseCliArgs(["platform", "--webhooks"])).toMatchObject({ kind: "platform" });
    for (const argv of [["platform"], ["platform", "example.com", "--webhooks"]])
      expect(parseCliArgs(argv)).toMatchObject({ kind: "error" });
  });

  it("an endpoint with 14 pending events, the oldest six days old: one high finding", async () => {
    const r = await platform(["--webhooks"], {
      endpoints: [
        { url: "https://hooks.tideline.example/stripe/whsec_abc" },
        { url: "https://old.tideline.example/hook", status: "disabled" },
      ],
      events,
    });
    expect(r.code).toBe(EXIT.ok);
    expect(r.out).toContain("Stripe webhook endpoints: 2 (1 enabled, 1 disabled)");
    expect(r.out).toContain(
      "Events read: 2026-10-11 to 2026-11-10 UTC (Stripe keeps events for 30 days)",
    );
    expect(r.out).toContain(
      "hooks.tideline.example: 14 events older than 1 hour not delivered, the oldest 6 days old.",
    );
    expect(r.out).toContain("old.tideline.example is disabled");
    expect(r.out).not.toContain("whsec_abc");
  });

  it("--ci exits 1 for a failing endpoint, 0 for a disabled one alone", async () => {
    const failing = await platform(["--webhooks", "--ci"], {
      endpoints: [{ url: "https://hooks.tideline.example/x" }],
      events,
    });
    expect(failing.code).toBe(EXIT.findings);
    const disabled = await platform(["--webhooks", "--ci"], {
      endpoints: [{ url: "https://old.tideline.example/x", status: "disabled" }],
    });
    expect(disabled.code).toBe(EXIT.ok);
  });

  it("--json is the result, validates, and holds no secret, no path and no address", async () => {
    const seen: SeenRequest[] = [];
    const r = await platform(
      ["--webhooks", "--json"],
      { endpoints: [{ url: "https://hooks.tideline.example/stripe/whsec_abc" }], events },
      ENV,
      seen,
    );
    const result = resultSchema.parse(JSON.parse(r.out));
    expect(result.findings).toHaveLength(1);
    expect(r.out).not.toContain("@");
    expect(r.out).not.toContain("whsec_abc");
    expect(r.out).not.toContain(RK);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((s) => s.method === "GET")).toBe(true);
  });

  it("a key that cannot read is exit 2 and says which permissions to set", async () => {
    const r = await platform(["--webhooks"], { stripeStatus: 403 });
    expect(r.code).toBe(EXIT.couldNotRun);
    expect(r.err).toContain("Webhook Endpoints");
    expect(r.err).not.toContain(RK);
  });

  it("no key is exit 2 naming STRIPE_API_KEY (built bin)", async () => {
    const r = await runBin(["platform", "--webhooks"], { STRIPE_API_KEY: "" });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("STRIPE_API_KEY");
  });
});
