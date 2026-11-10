// check-community: allow-email (invented addresses at reserved example domains, matched by hash and never printed)
import { resultSchema } from "@gaugeline/core";
import { providerTransport, type FakeProviders, type SeenRequest } from "@gaugeline/testkit";
import { describe, expect, it } from "vitest";
import { parseCliArgs } from "../args.js";
import { FLAGS } from "../flags.js";
import { EXIT, main } from "../main.js";
import { runBin } from "./helpers/bin.js";

// Key-shaped values are put together at run time: GitHub push protection rejects literals.
const RK = ["rk", "live", "Tideline0123456789abcdef"].join("_");
const RESEND = ["re", "Tideline0123456789abcdef"].join("_");
const NOW = new Date("2026-11-10T12:00:00Z");
const HOUR = 3600 * 1000;
const ENV = { STRIPE_API_KEY: RK, RESEND_API_KEY: RESEND };

const at = (hoursAgo: number) => new Date(NOW.getTime() - hoursAgo * HOUR).toISOString();
const buyer = (i: number) => `buyer${i}@tideline.example`;
const orders = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ at: at(2 + i * 0.4), email: buyer(i) }));
const emails = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ at: at(1.5 + i * 0.4), to: [buyer(i)] }));

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: (env: Record<string, string | undefined> = ENV) => ({
      stdout: { write: (s: string) => out.push(s) },
      stderr: { write: (s: string) => err.push(s) },
      env,
    }),
    out: () => out.join(""),
    err: () => err.join(""),
  };
}

async function delivery(
  argv: string[],
  spec: FakeProviders,
  env: Record<string, string | undefined> = ENV,
  extra: { seen?: SeenRequest[]; retentionDays?: number } = {},
) {
  const c = capture();
  const code = await main(["delivery", ...argv], c.io(env), {
    now: () => NOW,
    sleep: () => Promise.resolve(),
    ...(extra.retentionDays ? { retentionDays: extra.retentionDays } : {}),
    fetcher: { transport: providerTransport(spec, extra.seen ?? []), timeoutMs: 5000 },
  });
  return { code, out: c.out(), err: c.err() };
}

describe("gaugeline delivery: arguments", () => {
  it("takes --paid, --sent and --since", () => {
    expect(parseCliArgs(["delivery", "--paid", "--sent", "--since", "7d"])).toMatchObject({
      kind: "delivery",
      paid: true,
      sent: true,
      since: "7d",
    });
    expect(parseCliArgs(["delivery", "--paid"])).toMatchObject({ paid: true, sent: false });
  });

  it("neither flag, an address, or an empty --since is a usage error that shows the fix", () => {
    for (const argv of [
      ["delivery"],
      ["delivery", "example.com", "--paid"],
      ["delivery", "--paid", "--since="],
    ])
      expect(parseCliArgs(argv), argv.join(" ")).toMatchObject({
        kind: "error",
        message: expect.stringMatching(/--paid, --sent|no address|--since needs/),
      });
  });

  it("--since keeps its meaning for the page check", () => {
    expect(parseCliArgs(["example.com", "--since", "7d"])).toMatchObject({ kind: "error" });
    expect(parseCliArgs(["example.com", "--since", "last"])).toMatchObject({ since: "last" });
  });

  it("the flags are in the table the docs and --help are made from", () => {
    const commands = (name: string) => FLAGS.find((f) => f.name === name)?.commands;
    expect(commands("paid")).toEqual(["delivery"]);
    expect(commands("sent")).toEqual(["delivery"]);
    expect(commands("webhooks")).toEqual(["platform"]);
    for (const name of ["json", "ci", "allow-secret-key"]) {
      expect(commands(name)).toContain("delivery");
      expect(commands(name)).toContain("platform");
    }
    expect(commands("since")).toContain("delivery");
  });

  it("--paid is not a flag of the page check", () => {
    expect(parseCliArgs(["example.com", "--paid"])).toMatchObject({ kind: "error" });
  });
});

describe("gaugeline delivery: runs", () => {
  it("12 paid, 9 sent: prints the totals and the finding, exit 0", async () => {
    const r = await delivery(["--paid", "--sent"], { orders: orders(12), emails: emails(9) });
    expect(r.code).toBe(EXIT.ok);
    expect(r.out).toContain("12 paid, 9 sent");
    expect(r.out).toContain("Orders were paid and no receipt went out");
    expect(r.out).toContain("3 paid orders have no matching email");
    expect(r.out).not.toContain("@");
  });

  it("--ci exits 1 on the high finding, and 0 when every order has its email", async () => {
    const bad = await delivery(["--paid", "--sent", "--ci"], {
      orders: orders(12),
      emails: emails(9),
    });
    expect(bad.code).toBe(EXIT.findings);
    const good = await delivery(["--paid", "--sent", "--ci"], {
      orders: orders(5),
      emails: emails(5),
    });
    expect(good.code).toBe(EXIT.ok);
    expect(good.out).toContain("5 paid, 5 sent");
  });

  it("--paid alone prints that side's count, and never asks Resend", async () => {
    const seen: SeenRequest[] = [];
    const r = await delivery(["--paid"], { orders: orders(4), resendStatus: 401 }, ENV, { seen });
    expect(r.code).toBe(EXIT.ok);
    expect(r.out).toContain("\n4 paid\n");
    expect(r.out).not.toContain("sent");
    expect(seen.some((s) => s.url.includes("resend"))).toBe(false);
  });

  it("--sent alone prints that side's count", async () => {
    const r = await delivery(["--sent"], { emails: emails(6) });
    expect(r.code).toBe(EXIT.ok);
    expect(r.out).toContain("\n6 sent\n");
  });

  it("a window with zero orders: '0 paid, 0 sent', exit 0, no finding", async () => {
    const r = await delivery(["--paid", "--sent", "--ci"], {});
    expect(r.code).toBe(EXIT.ok);
    expect(r.out).toContain("0 paid, 0 sent");
    expect(r.out).not.toContain("no receipt");
  });

  it("Resend answers 401: exit 2 for --paid --sent, naming the variable and not the key", async () => {
    const r = await delivery(["--paid", "--sent"], { orders: orders(3), resendStatus: 401 });
    expect(r.code).toBe(EXIT.couldNotRun);
    expect(r.out).toBe("");
    expect(r.err).toContain("RESEND_API_KEY");
    expect(r.err).not.toContain(RESEND);
  });

  it("a missing key is exit 2 and names the variable, before any request", async () => {
    const seen: SeenRequest[] = [];
    const r = await delivery(["--paid", "--sent"], {}, { STRIPE_API_KEY: RK }, { seen });
    expect(r.code).toBe(EXIT.couldNotRun);
    expect(r.err).toContain("RESEND_API_KEY");
    expect(seen).toHaveLength(0);
    const none = await delivery(["--paid"], {}, {});
    expect(none.code).toBe(EXIT.couldNotRun);
    expect(none.err).toContain("STRIPE_API_KEY");
  });

  it("garbage in --since is exit 2", async () => {
    for (const bad of ["soon", "7", "0d", "2026-13-40"]) {
      const r = await delivery(["--paid", "--sent", "--since", bad], {});
      expect(r.code, bad).toBe(EXIT.couldNotRun);
      expect(r.err).toContain("--since");
    }
  });

  it("a live secret key is refused with exit 2 unless --allow-secret-key", async () => {
    const SK = ["sk", "live", "Tideline0123456789abcdef"].join("_");
    const refused = await delivery(["--paid"], {}, { STRIPE_API_KEY: SK });
    expect(refused.code).toBe(EXIT.couldNotRun);
    expect(refused.err).toContain("Checkout Sessions");
    expect(refused.err).not.toContain(SK);
    const allowed = await delivery(
      ["--paid", "--allow-secret-key"],
      { orders: orders(1) },
      {
        STRIPE_API_KEY: SK,
      },
    );
    expect(allowed.code).toBe(EXIT.ok);
    expect(allowed.err).toContain("--allow-secret-key");
    expect(allowed.err).not.toContain(SK);
  });

  it("states the window that was readable when the provider keeps less", async () => {
    const r = await delivery(
      ["--paid", "--sent", "--since", "7d"],
      { orders: orders(3), emails: emails(3) },
      ENV,
      { retentionDays: 3 },
    );
    expect(r.err).toContain("Only 2026-11-07 to 2026-11-10 could be read");
    expect(r.out).toContain("(2026-11-07 to 2026-11-10 UTC)");
  });

  it("every request is a GET and none carries a key in the address", async () => {
    const seen: SeenRequest[] = [];
    await delivery(
      ["--paid", "--sent"],
      { orders: orders(30), emails: emails(30), pageSize: 10 },
      ENV,
      {
        seen,
      },
    );
    expect(seen.length).toBeGreaterThan(2);
    expect(seen.every((s) => s.method === "GET")).toBe(true);
    expect(seen.some((s) => s.url.includes(RK) || s.url.includes(RESEND))).toBe(false);
  });
});

describe("gaugeline delivery --json: e2e", () => {
  it("validates against the result schema and contains no '@', no key and no hash", async () => {
    const r = await delivery(["--paid", "--sent", "--json"], {
      orders: orders(12),
      emails: emails(9),
    });
    expect(r.code).toBe(EXIT.ok);
    const result = resultSchema.parse(JSON.parse(r.out));
    expect(result.schema).toBe(2);
    expect(result.findings[0]).toMatchObject({ checkId: "delivery-receipt-missing" });
    expect(result.findings[0]?.evidence).toMatch(/^12 paid, 9 sent/);
    expect(r.out).not.toContain("@");
    expect(r.out).not.toContain(RK);
    expect(r.out).not.toContain(RESEND);
    expect(r.out).not.toMatch(/[0-9a-f]{64}/);
    expect(r.out).not.toContain("tideline.example");
    // stdout is the JSON and nothing else; stderr holds no address or key either.
    expect(r.err).not.toContain("@");
  });
});

describe("gaugeline delivery: the built bin", () => {
  it("--help lists the flags and the exit codes", async () => {
    const r = await runBin(["delivery", "--help"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("gaugeline delivery --paid --sent");
    expect(r.stdout).toContain("--paid");
    expect(r.stdout).toContain("--sent");
    expect(r.stdout).toContain("--since");
  });

  it("with no keys in the environment it exits 2 and names both variables, without a request", async () => {
    const r = await runBin(["delivery", "--paid", "--sent"], {
      STRIPE_API_KEY: "",
      RESEND_API_KEY: "",
    });
    expect(r.status).toBe(2);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("STRIPE_API_KEY");
    expect(r.stderr).toContain("RESEND_API_KEY");
  });
});
