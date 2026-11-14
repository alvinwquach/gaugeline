// check-community: allow-email (invented addresses at reserved example domains, matched by hash and never printed)
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { providerTransport, type FakeProviders } from "@gaugeline/testkit";
import { describe, expect, it } from "vitest";
import { EXIT, main } from "../main.js";

/**
 * docs/delivery.md shows `npx gaugeline delivery ...` and `npx gaugeline platform ...` and what they
 * print. The docs runner (pnpm docs:examples) points every example at a fixture site, and these
 * commands read Stripe and Resend, so this test runs the page's own commands against stand-ins for
 * the two (testkit's providerTransport, answering without a socket) and compares each Output block
 * with what the CLI prints: stdout first, then, when the block says so, stderr. The customers, the
 * addresses and the keys are invented.
 */
const page = readFileSync(
  fileURLToPath(new URL("../../../../docs/delivery.md", import.meta.url)),
  "utf8",
).replace(/\r\n/g, "\n");

const NOW = new Date("2026-11-10T12:00:00Z");
const KEYS = {
  STRIPE_API_KEY: ["rk", "live", "TidelineCoaching0123456789"].join("_"),
  RESEND_API_KEY: ["re", "TidelineCoaching0123456789"].join("_"),
};

const mate = (n: number) => `client${n}@tideline-coaching.example`;
const order = (n: number, at: string) => ({ at, email: mate(n) });
const mail = (n: number, at: string) => ({ at, to: [mate(n)] });

/** Tideline Coaching: 12 paid in a week, 9 receipts sent. Three clients got no email (5, 9 and 10). */
const TIDELINE: FakeProviders = {
  orders: [
    order(1, "2026-11-05T09:12:00Z"),
    order(2, "2026-11-05T18:40:00Z"),
    order(3, "2026-11-06T07:05:00Z"),
    order(4, "2026-11-06T12:30:00Z"),
    order(5, "2026-11-06T20:15:00Z"),
    order(6, "2026-11-07T10:00:00Z"),
    order(7, "2026-11-08T08:20:00Z"),
    order(8, "2026-11-08T11:45:00Z"),
    order(9, "2026-11-08T16:10:00Z"),
    order(10, "2026-11-08T21:30:00Z"),
    order(11, "2026-11-09T09:00:00Z"),
    order(12, "2026-11-09T15:25:00Z"),
  ],
  emails: [
    mail(1, "2026-11-05T09:12:30Z"),
    mail(2, "2026-11-05T18:40:30Z"),
    mail(3, "2026-11-06T07:05:30Z"),
    mail(4, "2026-11-06T12:30:30Z"),
    mail(6, "2026-11-07T10:00:30Z"),
    mail(7, "2026-11-08T08:20:30Z"),
    mail(8, "2026-11-08T11:45:30Z"),
    mail(11, "2026-11-09T09:00:30Z"),
    mail(12, "2026-11-09T15:25:30Z"),
  ],
};

/** Marlin Street Taproom: ticketed tasting nights. The live endpoint has been failing for six days. */
const TAPROOM: FakeProviders = {
  endpoints: [
    { url: "https://hooks.marlin-street-taproom.example/stripe/whsec-path-stays-private" },
    { url: "https://old-site.marlin-street-taproom.example/wp-json/stripe", status: "disabled" },
  ],
  events: Array.from({ length: 14 }, (_, i) => ({
    type: "checkout.session.completed",
    at: new Date(NOW.getTime() - 6 * 86_400_000 + i * 10 * 3_600_000).toISOString(),
    pending: 1,
  })),
};

/** Each command the page shows, with what it is run against. */
const SCENARIOS: Record<string, FakeProviders> = {
  "delivery --paid --sent --since 7d": TIDELINE,
  "delivery --paid --since 7d": TIDELINE,
  "platform --webhooks": TAPROOM,
};

function fences(): Array<{ info: string; body: string }> {
  const out: Array<{ info: string; body: string }> = [];
  const re = /^```(.*)\n([\s\S]*?)\n```$/gm;
  for (let m = re.exec(page); m; m = re.exec(page))
    out.push({ info: m[1] ?? "", body: m[2] ?? "" });
  return out;
}

/** Each `$ npx gaugeline delivery|platform ...` block with the Output block that follows it. */
function examples(): Array<{ command: string; expected: string }> {
  const all = fences();
  const out: Array<{ command: string; expected: string }> = [];
  all.forEach((f, i) => {
    const next = all[i + 1];
    if (!/title=Terminal/.test(f.info) || !/^\$ npx gaugeline (delivery|platform) /.test(f.body))
      return;
    if (!next || !/title="?Output/.test(next.info)) return;
    out.push({ command: f.body.replace(/^\$ npx gaugeline /, ""), expected: next.body });
  });
  return out;
}

describe("docs/delivery.md: the commands it shows", () => {
  it("has the examples it describes", () => {
    expect(examples().map((e) => e.command)).toEqual(Object.keys(SCENARIOS));
  });

  it("prints what the page says", async () => {
    for (const e of examples()) {
      const out: string[] = [];
      const err: string[] = [];
      const code = await main(
        e.command.split(/\s+/),
        {
          stdout: { write: (s) => out.push(s) },
          stderr: { write: (s) => err.push(s) },
          env: KEYS,
        },
        {
          now: () => NOW,
          sleep: () => Promise.resolve(),
          fetcher: { transport: providerTransport(SCENARIOS[e.command] ?? {}), timeoutMs: 5000 },
        },
      );
      expect(code, e.command).toBe(EXIT.ok);
      expect(err.join(""), e.command).toBe("");
      expect(out.join("").trimEnd(), e.command).toBe(e.expected);
    }
  });

  it("the page names the variables and flags the commands read", () => {
    for (const word of [
      "STRIPE_API_KEY",
      "RESEND_API_KEY",
      "--paid",
      "--sent",
      "--since",
      "--webhooks",
      "delivery-receipt-missing",
      "webhook-failing",
      "webhook-disabled",
    ])
      expect(page, word).toContain(word);
  });
});
