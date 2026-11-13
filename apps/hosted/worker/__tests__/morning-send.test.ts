// check-community: allow-email (invented addresses on the reserved .test domain, for the mail sink)
/**
 * The morning email against a real Postgres: who is mailed, once a day, only when something changed, and
 * a failing send retried without ever sending twice. The mail service is a sink (a function that records
 * the message); one test sends through core's real notifier to a local server to check what leaves.
 * The worker connects as the app's login and works as service_role, so the column grants are exercised.
 */
import { createServer, type Server } from "node:http";
import { buildResult, postEmail } from "@gaugeline/core";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { appLogin } from "../../app/api/__tests__/app-login.js";
import {
  freshDatabase,
  HAS_DATABASE,
  ORG_A,
  ORG_B,
  seed,
  SITE_A1,
  SITE_A2,
  SITE_B1,
  type Sql,
  type TestDatabase,
  USER_A_CLIENT,
  USER_A_MEMBER,
  USER_A_OWNER,
  USER_B_OWNER,
  USER_BOTH,
} from "../../db/__tests__/harness.js";
import { verifyToken } from "../../lib/email/token.js";
import { type Sender, sendMorningEmails, type MorningDeps } from "../email/send.js";
import { runWorker, type SiteToCheck } from "../worker.js";
import { morningFromEnv } from "../email/send.js";

const SECRET = "s".repeat(40);
const KEY = ["re", "_test_", "0123456789abcdef"].join("");
const NOW = new Date("2026-11-12T07:10:00Z"); // 07:10 in London (GMT), 02:10 in Toronto
const min = (m: number) => new Date(NOW.getTime() + m * 60_000);

interface Sent {
  to: string;
  subject: string;
  text: string;
  html: string;
}

/** A mail service sink: records what it is given, and answers as told. */
function sink(answer: () => { ok: boolean; status?: number } | "throw" = () => ({ ok: true })) {
  const sent: Sent[] = [];
  const send: Sender = async ({ to, mail }) => {
    const a = answer();
    if (a === "throw") throw new Error(`boom for ${to} with ${KEY}`);
    if (a.ok) sent.push({ to, ...mail });
    return { ...a, ...(a.ok ? {} : { error: `mail.example.test answered ${a.status}` }) };
  };
  return { sent, send };
}

/**
 * The same connection, with one transaction held back. `step` is which transaction of a pass (1 = the
 * recipients, 2 = the plan, 3 = the claim). `hold(n)` runs before that transaction opens; `at` counts how
 * many passes got there. Each pass needs its own wrapper, because the count is per pass.
 */
function gate(sql: Sql, step: number, hold: (n: number) => Promise<void> | void): { sql: Sql } {
  let begins = 0;
  const wrapped = new Proxy(sql, {
    get(target, prop) {
      if (prop === "begin") {
        return async (...args: unknown[]) => {
          begins += 1;
          if (begins === step) await hold(begins);
          return (target.begin as (...a: unknown[]) => unknown)(...args);
        };
      }
      const value = Reflect.get(target, prop, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { sql: wrapped as Sql };
}

/** A barrier for `parties` callers: it opens when all have arrived (or after two seconds, so a test fails rather than hangs). */
function barrier(parties: number) {
  let arrived = 0;
  let open!: () => void;
  const opened = new Promise<void>((r) => (open = r));
  const timer = setTimeout(open, 2000);
  return {
    get arrived() {
      return arrived;
    },
    async wait() {
      arrived += 1;
      if (arrived >= parties) {
        clearTimeout(timer);
        open();
      }
      await opened;
    },
  };
}

describe.skipIf(!HAS_DATABASE)("the morning email", () => {
  let db: TestDatabase;
  let owner: Sql;
  let app: Awaited<ReturnType<typeof appLogin>>;
  let n = 0;

  beforeAll(async () => {
    db = await freshDatabase();
    owner = db.sql;
    await seed(owner);
    app = await appLogin(owner);
  });
  afterAll(async () => {
    await app?.drop();
    await db?.drop();
  });
  beforeEach(async () => {
    await owner`delete from public.email_sends`;
    await owner`delete from public.email_preferences`;
    await owner`delete from public.run_changes`;
    await owner`delete from public.runs where id not in (select run_id from public.findings)`;
  });

  const deps = (s: { send: Sender }, over: Partial<MorningDeps> = {}): MorningDeps => ({
    sql: app.sql,
    send: s.send,
    dashboardUrl: "https://dashboard.example.test/",
    tokenSecret: SECRET,
    ...over,
  });

  /** A person's address and setting (confirmed unless said otherwise). */
  async function person(
    orgId: string,
    userId: string,
    over: {
      email?: string | null;
      frequency?: string | null;
      confirmed?: boolean;
      bounced?: boolean;
      timezone?: string;
    } = {},
  ) {
    const email = over.email === undefined ? `u${++n}@mail.example.test` : over.email;
    await owner`insert into public.email_preferences (org_id, user_id, email, email_confirmed_at, frequency, bounced_at, timezone)
      values (${orgId}, ${userId}, ${email}, ${email && over.confirmed !== false ? new Date(NOW.getTime() - 86_400_000 * 5) : null},
        ${over.frequency ?? null}, ${over.bounced ? new Date(NOW.getTime() - 3600_000) : null}, ${over.timezone ?? null})`;
    return email;
  }

  /** A run that changed: `opened` findings (title, severity) and `closed` fixed ones, created at `at`. */
  async function changed(
    orgId: string,
    siteId: string,
    opened: [string, "high" | "medium" | "low"][],
    closed = 0,
    at: Date = min(-240),
  ) {
    const run = (
      await owner`insert into public.runs (org_id, site_id, started_at, finished_at)
      values (${orgId}, ${siteId}, ${at}, ${at}) returning id`
    )[0]!.id as string;
    const fps: string[] = [];
    for (const [title, severity] of opened) {
      const fp = (++n).toString(16).padStart(16, "0");
      fps.push(fp);
      await owner`insert into public.findings (org_id, site_id, run_id, check_id, severity, title, evidence, url, fingerprint)
        values (${orgId}, ${siteId}, ${run}, 'broken-links', ${severity}, ${title}, 'SECRET-EVIDENCE-LINE 404', 'https://tidewater-bar.test/menu', ${fp})`;
    }
    await owner`insert into public.run_changes (org_id, site_id, run_id, opened, still_open, closed, opened_fingerprints, closed_fingerprints, created_at)
      values (${orgId}, ${siteId}, ${run}, ${opened.length}, 0, ${closed}, ${fps}, ${Array.from({ length: closed }, (_, i) => `f${i}`.padEnd(16, "0"))}, ${at})`;
  }
  const rows = () =>
    owner`select user_id, local_date::text as day, status, attempts, last_error, retry_after, covers_from, covers_to
      from public.email_sends order by user_id`;

  it("a quiet night sends nothing and writes nothing", async () => {
    await person(ORG_A, USER_A_OWNER);
    const s = sink();
    expect(await sendMorningEmails(deps(s), NOW)).toEqual({ sent: 0, failed: 0 });
    expect(s.sent).toEqual([]);
    expect(await rows()).toEqual([]);
  });

  it("one new finding: one email to the owner with that finding as the subject, and a signed link", async () => {
    const to = await person(ORG_A, USER_A_OWNER);
    await changed(ORG_A, SITE_A1, [["Broken link on the menu page", "high"]]);
    const s = sink();
    expect(await sendMorningEmails(deps(s), NOW)).toEqual({ sent: 1, failed: 0 });
    expect(s.sent).toHaveLength(1);
    expect(s.sent[0]!.to).toBe(to);
    expect(s.sent[0]!.subject).toBe("New: Broken link on the menu page (The Tidewater Bar)");
    expect(s.sent[0]!.text).toContain("The Tidewater Bar: 1 new problem (1 to fix first).");
    expect(s.sent[0]!.text).not.toContain("SECRET-EVIDENCE-LINE");
    const link = /https:\/\/dashboard\.example\.test\/email\/preferences\?t=(\S+)/.exec(
      s.sent[0]!.text,
    )!;
    expect(verifyToken(SECRET, decodeURIComponent(link[1]!), NOW)).toEqual({
      ok: true,
      orgId: ORG_A,
      userId: USER_A_OWNER,
    });
    expect(await rows()).toMatchObject([{ status: "sent", attempts: 1, day: "2026-11-12" }]);
  });

  it("who is mailed: owners and admins by default, members only after they opt in, a client viewer never", async () => {
    const owner1 = await person(ORG_A, USER_A_OWNER);
    await person(ORG_A, USER_A_MEMBER); // a member who never chose: off
    await person(ORG_A, USER_A_CLIENT, { frequency: "every_change" }); // a client viewer who asked: still no
    const both = await person(ORG_A, USER_BOTH, { frequency: "every_change" }); // a member who opted in
    await changed(ORG_A, SITE_A1, [["Broken link on the menu page", "medium"]]);
    const s = sink();
    await sendMorningEmails(deps(s), NOW);
    expect(s.sent.map((m) => m.to).sort()).toEqual([owner1, both].sort());
  });

  it("fix first: a person who asked for it hears only about a new high-severity finding", async () => {
    const a = await person(ORG_A, USER_A_OWNER, { frequency: "fix_first" });
    await changed(ORG_A, SITE_A1, [["No canonical address", "low"]], 2);
    const s = sink();
    await sendMorningEmails(deps(s), NOW);
    expect(s.sent).toEqual([]);
    await changed(ORG_A, SITE_A2, [["Menu page returns 404", "high"]]);
    await sendMorningEmails(deps(s), NOW);
    expect(s.sent.map((m) => m.to)).toEqual([a]);
    expect(s.sent[0]!.text).not.toContain("The Tidewater Bar");
    expect(s.sent[0]!.text).toContain("Juniper Pop-up Kitchen");
  });

  it("a person who turned it off, or has no address, an unconfirmed one or a bounced one, gets nothing", async () => {
    await person(ORG_A, USER_A_OWNER, { frequency: "off" });
    await person(ORG_A, USER_A_MEMBER, { frequency: "every_change", email: null });
    await person(ORG_A, USER_BOTH, { frequency: "every_change", confirmed: false });
    await person(ORG_B, USER_B_OWNER, { bounced: true });
    await changed(ORG_A, SITE_A1, [["Broken link", "high"]]);
    await changed(ORG_B, SITE_B1, [["Broken link", "high"]]);
    const s = sink();
    await sendMorningEmails(deps(s), min(300)); // 12:10 UTC: morning in Toronto too
    expect(s.sent).toEqual([]);
    expect(await rows()).toEqual([]);
  });

  it("three sites changed in one night: one email, not three", async () => {
    await person(ORG_A, USER_A_OWNER);
    await changed(ORG_A, SITE_A1, [["Broken link on the menu page", "high"]]);
    await changed(ORG_A, SITE_A2, [["Booking page is slow", "medium"]], 1);
    await changed(ORG_A, SITE_A2, [["Missing alt text", "low"]], 0, min(-200));
    const s = sink();
    await sendMorningEmails(deps(s), NOW);
    expect(s.sent).toHaveLength(1);
    expect(s.sent[0]!.subject).toBe("3 new problems on 2 sites, 1 fixed");
    expect(s.sent[0]!.text.match(/^(The Tidewater Bar|Juniper Pop-up Kitchen):/gm)).toHaveLength(2);
  });

  it("a person in two organisations gets two emails, each with only that organisation's news", async () => {
    // Their own time zone (UTC) rules, so one morning covers both organisations' sites.
    const to = await person(ORG_A, USER_BOTH, {
      frequency: "every_change",
      email: "both@mail.example.test",
      timezone: "UTC",
    });
    await person(ORG_B, USER_BOTH, { email: "both@mail.example.test", timezone: "UTC" });
    await changed(ORG_A, SITE_A1, [["Broken link on the menu page", "high"]]);
    await changed(ORG_B, SITE_B1, [["No canonical address", "medium"]]);
    const s = sink();
    await sendMorningEmails(deps(s), NOW);
    expect(s.sent).toHaveLength(2);
    const a = s.sent.find((m) => m.text.includes("Tidewater"))!;
    const b = s.sent.find((m) => m.text.includes("Maple Street"))!;
    expect(a.to).toBe(to);
    expect(a.text).not.toContain("Maple Street");
    expect(b.text).not.toContain("Tidewater");
    expect(a.text).not.toContain("Brightfield");
    expect(b.text).not.toContain("Northgate");
  });

  it("7:00 is the organisation's morning: Toronto's is at 12:00 UTC, not 07:00", async () => {
    await person(ORG_B, USER_B_OWNER);
    await changed(
      ORG_B,
      SITE_B1,
      [["No canonical address", "medium"]],
      0,
      new Date("2026-11-11T20:00:00Z"),
    );
    const s = sink();
    await sendMorningEmails(deps(s), NOW); // 02:10 in Toronto
    expect(s.sent).toEqual([]);
    await sendMorningEmails(deps(s), min(300)); // 07:10 in Toronto
    expect(s.sent).toHaveLength(1);
    // A person's own time zone wins over the sites'.
    await owner`update public.email_preferences set timezone = 'Asia/Kolkata' where org_id = ${ORG_B}`;
    await owner`delete from public.email_sends`;
    await sendMorningEmails(deps(s), NOW); // 12:40 in Kolkata: past 11:00
    expect(s.sent).toHaveLength(1);
    await sendMorningEmails(deps(s), new Date("2026-11-12T02:00:00Z")); // 07:30 in Kolkata
    expect(s.sent).toHaveLength(2);
  });

  it("sent once a day: running again, a restart, and two workers at once never send a second copy", async () => {
    await person(ORG_A, USER_A_OWNER);
    await person(ORG_A, USER_BOTH, { frequency: "every_change" });
    await changed(ORG_A, SITE_A1, [["Broken link on the menu page", "high"]]);
    const s = sink();
    await Promise.all([
      sendMorningEmails(deps(s), NOW),
      sendMorningEmails(deps(s), NOW),
      sendMorningEmails(deps(s), min(1)),
    ]);
    await sendMorningEmails(deps(s), min(30));
    await changed(ORG_A, SITE_A2, [["Menu page returns 404", "high"]], 0, min(10));
    await sendMorningEmails(deps(s), min(60)); // later the same morning: still the same day
    expect(s.sent).toHaveLength(2);
    expect(await rows()).toHaveLength(2);
  });

  it("two workers that both planned before either claimed: exactly one sends (the claim decides, not the plan)", async () => {
    await person(ORG_A, USER_A_OWNER);
    await changed(ORG_A, SITE_A1, [["Broken link on the menu page", "high"]]);
    const s = sink();
    // Three passes; each is held at its third transaction (the claim) until all three have finished
    // planning, so every one of them saw "no row yet" and holds a plan. Only the claim can stop a repeat.
    const gateAtClaim = barrier(3);
    const passes = [0, 1, 2].map(() =>
      sendMorningEmails(
        deps(
          s,
          gate(app.sql, 3, () => gateAtClaim.wait()),
        ),
        NOW,
      ),
    );
    const reports = await Promise.all(passes);
    expect(gateAtClaim.arrived).toBe(3); // the interleave really happened: all planned before any claimed
    expect(s.sent).toHaveLength(1);
    expect(reports.reduce((n, r) => n + r.sent, 0)).toBe(1);
    expect(await rows()).toMatchObject([{ status: "sent", attempts: 1 }]);
  });

  it("two workers retrying the same failed row after planning together: exactly one retry is sent", async () => {
    await person(ORG_A, USER_A_OWNER);
    await changed(ORG_A, SITE_A1, [["Broken link on the menu page", "high"]]);
    const failing = sink(() => ({ ok: false, status: 503 }));
    await sendMorningEmails(deps(failing), NOW);
    expect(await rows()).toMatchObject([{ status: "failed", attempts: 1 }]);
    const s = sink();
    const gateAtClaim = barrier(2);
    await Promise.all(
      [0, 1].map(() =>
        sendMorningEmails(
          deps(
            s,
            gate(app.sql, 3, () => gateAtClaim.wait()),
          ),
          min(15),
        ),
      ),
    );
    expect(gateAtClaim.arrived).toBe(2);
    expect(s.sent).toHaveLength(1);
    expect(await rows()).toMatchObject([{ status: "sent", attempts: 2 }]);
  });

  it("what the failure paths log: a code or an error's name, never its words, and never the key", async () => {
    await person(ORG_A, USER_A_OWNER);
    await changed(ORG_A, SITE_A1, [["Broken link on the menu page", "high"]]);
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => {}),
    );
    try {
      // (1) The database throws something whose message carries the key (the outer catch).
      const broken = gate(app.sql, 2, () => {
        throw new Error(`connection string postgres://worker:${KEY}@db.example.test failed`);
      });
      const s = sink();
      expect(await sendMorningEmails(deps(s, broken), NOW)).toEqual({ sent: 0, failed: 0 });
      expect(s.sent).toEqual([]);
      // (2) The mail service answers 503 with the key in its words, and (3) the send throws with it.
      const words = sink(() => ({ ok: false, status: 503 }));
      const loud: Sender = async (req) => ({
        ...(await words.send(req)),
        error: `provider said: bad key ${KEY}`,
      });
      await sendMorningEmails(deps({ send: loud }), NOW);
      expect(await rows()).toMatchObject([{ status: "failed", last_error: "provider-busy" }]);
      await sendMorningEmails(deps(sink(() => "throw")), min(15));
      expect(await rows()).toMatchObject([{ status: "failed", last_error: "send-threw" }]);
      const logged = spies.flatMap((spy) => spy.mock.calls).map((c) => c.map(String).join(" "));
      expect(logged).toEqual(["morning email: Error for one recipient"]);
      expect(logged.join("\n")).not.toContain(KEY);
      expect(logged.join("\n")).not.toContain("connection string");
      expect(JSON.stringify(await owner`select * from public.email_sends`)).not.toContain(KEY);
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });

  it("the next morning reports only what changed since the last email", async () => {
    await person(ORG_A, USER_A_OWNER);
    await changed(ORG_A, SITE_A1, [["Broken link on the menu page", "high"]]);
    const s = sink();
    await sendMorningEmails(deps(s), NOW);
    const day = 86_400_000;
    await sendMorningEmails(deps(s), new Date(NOW.getTime() + day)); // nothing new: no email
    expect(s.sent).toHaveLength(1);
    await changed(
      ORG_A,
      SITE_A2,
      [["Menu page returns 404", "high"]],
      0,
      new Date(NOW.getTime() + day - 3_600_000),
    );
    await sendMorningEmails(deps(s), new Date(NOW.getTime() + day));
    expect(s.sent).toHaveLength(2);
    expect(s.sent[1]!.subject).toBe("New: Menu page returns 404 (Juniper Pop-up Kitchen)");
    expect(s.sent[1]!.text).not.toContain("Tidewater");
  });

  it("a send that fails is retried later, once it works it is not sent again, and three failures stop", async () => {
    await person(ORG_A, USER_A_OWNER);
    await changed(ORG_A, SITE_A1, [["Broken link on the menu page", "high"]]);
    let answer: { ok: boolean; status?: number } | "throw" = { ok: false, status: 503 };
    const s = sink(() => answer);
    expect(await sendMorningEmails(deps(s), NOW)).toEqual({ sent: 0, failed: 1 });
    expect(await rows()).toMatchObject([
      { status: "failed", attempts: 1, last_error: "provider-busy" },
    ]);
    await sendMorningEmails(deps(s), min(2)); // too soon: no second attempt yet
    expect((await rows())[0]).toMatchObject({ attempts: 1 });
    answer = "throw";
    await sendMorningEmails(deps(s), min(15));
    expect(await rows()).toMatchObject([
      { status: "failed", attempts: 2, last_error: "send-threw" },
    ]);
    // The error text of a thrown send (it carried the key) is not what the log keeps.
    expect(JSON.stringify(await owner`select * from public.email_sends`)).not.toContain(KEY);
    answer = { ok: true };
    expect(await sendMorningEmails(deps(s), min(40))).toEqual({ sent: 1, failed: 0 });
    expect(await rows()).toMatchObject([{ status: "sent", attempts: 3, last_error: null }]);
    await sendMorningEmails(deps(s), min(80));
    expect(s.sent).toHaveLength(1);
    // Three failures in a row and it gives up for the day.
    await owner`delete from public.email_sends`;
    answer = { ok: false, status: 503 };
    for (const m of [0, 15, 40, 90, 200]) await sendMorningEmails(deps(s), min(m));
    expect(await rows()).toMatchObject([{ status: "failed", attempts: 3 }]);
  });

  it("a refusal from the mail service (a bad address) is not retried", async () => {
    await person(ORG_A, USER_A_OWNER);
    await changed(ORG_A, SITE_A1, [["Broken link on the menu page", "high"]]);
    const s = sink(() => ({ ok: false, status: 422 }));
    await sendMorningEmails(deps(s), NOW);
    await sendMorningEmails(deps(s), min(60));
    expect(await rows()).toMatchObject([
      { status: "failed", attempts: 1, last_error: "rejected", retry_after: null },
    ]);
  });

  it("a worker that died after claiming leaves a row that is never sent again", async () => {
    await person(ORG_A, USER_A_OWNER);
    await changed(ORG_A, SITE_A1, [["Broken link on the menu page", "high"]]);
    await owner`insert into public.email_sends (org_id, user_id, local_date, covers_from, covers_to)
      values (${ORG_A}, ${USER_A_OWNER}, '2026-11-12', ${min(-1440)}, ${min(-2)})`;
    const s = sink();
    await sendMorningEmails(deps(s), min(120));
    expect(s.sent).toEqual([]);
    expect(await rows()).toMatchObject([{ status: "sending" }]);
  });

  it("does not change on the days clocks change (London, 29 March and 25 October 2026)", async () => {
    await person(ORG_A, USER_A_OWNER);
    const s = sink();
    const iso = (d: string) => new Date(d);
    // Spring forward: 07:00 BST is 06:00 UTC.
    await changed(
      ORG_A,
      SITE_A1,
      [["Broken link on the menu page", "high"]],
      0,
      iso("2026-03-29T02:00:00Z"),
    );
    await sendMorningEmails(deps(s), iso("2026-03-29T05:59:00Z"));
    expect(s.sent).toHaveLength(0);
    await sendMorningEmails(deps(s), iso("2026-03-29T06:00:00Z"));
    await sendMorningEmails(deps(s), iso("2026-03-29T06:15:00Z"));
    expect(s.sent).toHaveLength(1);
    // Fall back: 07:00 GMT is 07:00 UTC; 06:30 UTC is 06:30 and too early.
    await changed(
      ORG_A,
      SITE_A2,
      [["Menu page returns 404", "high"]],
      0,
      iso("2026-10-25T02:00:00Z"),
    );
    await sendMorningEmails(deps(s), iso("2026-10-25T06:30:00Z"));
    expect(s.sent).toHaveLength(1);
    await sendMorningEmails(deps(s), iso("2026-10-25T07:00:00Z"));
    await sendMorningEmails(deps(s), iso("2026-10-25T09:00:00Z"));
    expect(s.sent).toHaveLength(2);
  });

  it("hostile text from a page: the site name and title are cleaned and escaped; the evidence never leaves", async () => {
    await person(ORG_A, USER_A_OWNER);
    await owner`update public.sites set name = '<img src=x onerror=alert(1)> Bar' where id = ${SITE_A1}`;
    const title = "Menu\r\nBcc: attacker@evil.test <script>alert(1)</script> " + "‮" + "exe.txt";
    await changed(ORG_A, SITE_A1, [[title, "high"]]);
    const s = sink();
    await sendMorningEmails(deps(s), NOW);
    const m = s.sent[0]!;
    expect(m.subject).not.toMatch(/[\r\n‮]/);
    expect(m.html).not.toMatch(/<img|<script/i);
    expect(m.text).not.toMatch(/‮/);
    expect(m.text).not.toMatch(/^Bcc:/m);
    expect(m.html + m.text).not.toContain("SECRET-EVIDENCE-LINE");
    await owner`update public.sites set name = 'The Tidewater Bar' where id = ${SITE_A1}`;
  });

  it("the worker loop runs the step for whoever it is morning for, and a quiet queue does not stop it", async () => {
    await person(ORG_A, USER_A_OWNER);
    await changed(ORG_A, SITE_A1, [["Broken link on the menu page", "high"]]);
    const s = sink();
    const stop = new AbortController();
    const loop = runWorker(
      { sql: app.sql, now: () => NOW },
      { signal: stop.signal, idleMs: 20, morning: deps(s) },
    );
    await expect.poll(() => s.sent.length, { timeout: 5000 }).toBe(1);
    stop.abort();
    await loop;
    expect(s.sent).toHaveLength(1);
  });

  describe("beside the queue (the pool's rule: never sleep with a free slot and a due job)", () => {
    const enqueue = async (count: number) =>
      owner`insert into public.jobs (org_id, site_id, kind, probing, run_after)
        select s.org_id, s.id, 'manual', false, now() - interval '1 minute'
        from public.sites s, generate_series(1, ${count}) where s.id = ${SITE_A2}`;
    const doneJobs = async () =>
      Number((await owner`select count(*)::int as n from public.jobs where status = 'done'`)[0]!.n);
    const quiet = async (site: SiteToCheck) =>
      buildResult({ url: site.url, startedAt: new Date(), findings: [], passed: [], failed: [] });
    beforeEach(async () => {
      await owner`delete from public.jobs`;
    });

    it("the step runs on its cadence, and a step that throws never stops the checks", async () => {
      const stop = new AbortController();
      const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
      let calls = 0;
      const loop = runWorker(
        { sql: app.sql, runSite: quiet },
        {
          signal: stop.signal,
          limit: 2,
          idleMs: 10,
          morning: deps(sink()),
          morningEveryMs: 25,
          morningStep: async () => {
            calls += 1;
            throw new Error(`down for ${KEY}`);
          },
        },
      );
      try {
        await enqueue(3);
        await vi.waitFor(async () => expect(await doneJobs()).toBe(3), { timeout: 30_000 });
        // The step threw each time it was due, and it was due again and again.
        await vi.waitFor(() => expect(calls).toBeGreaterThanOrEqual(3), { timeout: 30_000 });
        // Jobs that arrive after it has thrown are still taken and finished.
        await enqueue(2);
        await vi.waitFor(async () => expect(await doneJobs()).toBe(5), { timeout: 30_000 });
        expect(JSON.stringify(log.mock.calls)).not.toContain(KEY);
      } finally {
        stop.abort();
        await loop;
        log.mockRestore();
      }
    }, 60_000);

    it("a step that is still running holds no slot: a job queued meanwhile finishes, and stopping waits for the step", async () => {
      const stop = new AbortController();
      let release: () => void = () => {};
      const gate = new Promise<void>((r) => (release = r));
      let started = 0;
      let stopped = false;
      const loop = runWorker(
        { sql: app.sql, runSite: quiet },
        {
          signal: stop.signal,
          limit: 1,
          idleMs: 10,
          morning: deps(sink()),
          morningEveryMs: 1,
          morningStep: async () => {
            started += 1;
            await gate;
          },
        },
      ).then(() => (stopped = true));
      try {
        await enqueue(2);
        await vi.waitFor(() => expect(started).toBe(1), { timeout: 30_000 });
        await vi.waitFor(async () => expect(await doneJobs()).toBe(2), { timeout: 30_000 });
        expect(started).toBe(1); // one step at a time, however often it is due
        stop.abort();
        await new Promise((r) => setTimeout(r, 50));
        expect(stopped).toBe(false); // the worker waits for the step in hand, like it does for a job
      } finally {
        release();
        stop.abort();
        await loop;
      }
      expect(stopped).toBe(true);
    }, 60_000);
  });

  it("through the real notifier: the key goes in the Authorization header only, to the address on the row", async () => {
    const to = await person(ORG_A, USER_A_OWNER);
    await changed(ORG_A, SITE_A1, [["Broken link on the menu page", "high"]]);
    const seen: { auth?: string; body: string }[] = [];
    const server: Server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        seen.push({
          auth: req.headers.authorization,
          body: Buffer.concat(chunks).toString("utf8"),
        });
        res.writeHead(200, { "content-type": "application/json" }).end('{"id":"x"}');
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    try {
      const port = (server.address() as { port: number }).port;
      const send: Sender = ({ to: address, mail }) =>
        postEmail(
          {
            to: [address],
            apiKey: KEY,
            endpoint: `http://127.0.0.1:${port}/emails`,
            from: "Gaugeline <morning@mail.example.test>",
          },
          mail,
        );
      expect(await sendMorningEmails(deps({ send }), NOW)).toEqual({ sent: 1, failed: 0 });
    } finally {
      await new Promise((r) => server.close(r));
    }
    expect(seen).toHaveLength(1);
    expect(seen[0]!.auth).toBe(`Bearer ${KEY}`);
    expect(seen[0]!.body).not.toContain(KEY);
    expect(JSON.parse(seen[0]!.body)).toMatchObject({
      to: [to],
      subject: expect.stringContaining("Broken link"),
    });
  });
});

describe("the worker's email settings from the environment", () => {
  const sql = {} as never;
  const good = {
    RESEND_API_KEY: ["re", "_test_", "abcdef0123456789"].join(""),
    GAUGELINE_DASHBOARD_URL: "https://dashboard.example.test/",
    GAUGELINE_EMAIL_TOKEN_SECRET: "t9Gk2Vq7ZxMw4BnR8cLd1HsYfJ3aEuP5oIe0",
  };
  it("is off without a Resend key, and the error for a half-set-up email never contains the key", () => {
    expect(morningFromEnv(sql, {})).toBeNull();
    for (const [over, message] of [
      [{ GAUGELINE_DASHBOARD_URL: "" }, /GAUGELINE_DASHBOARD_URL/],
      [{ GAUGELINE_DASHBOARD_URL: "http://dashboard.example.test/" }, /https/],
      [{ GAUGELINE_EMAIL_TOKEN_SECRET: "short" }, /32/],
      [{ GAUGELINE_APP_URL: "javascript:alert(1)" }, /GAUGELINE_APP_URL/],
    ] as const) {
      let error = "";
      try {
        morningFromEnv(sql, { ...good, ...over });
      } catch (e) {
        error = (e as Error).message;
      }
      expect(error).toMatch(message);
      expect(error).not.toContain(good.RESEND_API_KEY);
    }
  });
  it("with everything set, it can send", () => {
    expect(morningFromEnv(sql, good)?.dashboardUrl).toBe("https://dashboard.example.test/");
  });
});
