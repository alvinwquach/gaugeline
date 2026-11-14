// check-community: allow-email (invented addresses on the reserved .test domain, for the stand-in)
/**
 * The waiting-drafts digest inside the morning email against a real Postgres and a local stand-in for Resend:
 * sent once a day, only when something is waiting or changed, to the people the morning-email rules pick,
 * with the retry rules the existing path has, and refusing while the sender domain is the placeholder.
 */
import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { appLogin } from "../../app/api/__tests__/app-login.js";
import {
  freshDatabase,
  HAS_DATABASE,
  ORG_A,
  ORG_B,
  seed,
  SITE_A1,
  SITE_B1,
  type Sql,
  type TestDatabase,
  USER_A_CLIENT,
  USER_A_MEMBER,
  USER_A_OWNER,
  USER_B_OWNER,
} from "../../db/__tests__/harness.js";
import { DEFAULT_MAIL_FROM, morningFromEnv, sendMorningEmails } from "../email/send.js";

const KEY = ["re", "_test_", "0123456789abcdef"].join("");
const SECRET = "t9Gk2Vq7ZxMw4BnR8cLd1HsYfJ3aEuP5oIe0";
const NOW = new Date("2026-11-14T07:10:00Z"); // 07:10 in London
const min = (m: number) => new Date(NOW.getTime() + m * 60_000);
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000);

describe.skipIf(!HAS_DATABASE)("the digest in the morning email", () => {
  let db: TestDatabase;
  let owner: Sql;
  let app: Awaited<ReturnType<typeof appLogin>>;
  let server: Server;
  let endpoint = "";
  let answers: { status: number; body: string }[] = [];
  const seen: { auth?: string; body: Record<string, unknown> }[] = [];
  let n = 0;

  beforeAll(async () => {
    db = await freshDatabase();
    owner = db.sql;
    await seed(owner);
    app = await appLogin(owner);
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        seen.push({
          auth: req.headers.authorization,
          body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>,
        });
        const a = answers.shift() ?? { status: 200, body: `{"id":"re_msg_${seen.length}"}` };
        res.writeHead(a.status, { "content-type": "application/json" }).end(a.body);
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}/emails`;
  });
  afterAll(async () => {
    await new Promise((r) => server?.close(r));
    await app?.drop();
    await db?.drop();
  });
  beforeEach(async () => {
    seen.length = 0;
    answers = [];
    await owner`delete from public.email_sends`;
    await owner`delete from public.email_preferences`;
    await owner`delete from public.run_changes`;
    // Decisions are append-only: drafts from an earlier test are settled, not deleted.
    await owner`insert into public.decisions (org_id, draft_id, decision, decided_by)
      select d.org_id, d.id, 'declined', case d.org_id when ${ORG_A}::uuid then ${USER_A_OWNER}::uuid else ${USER_B_OWNER}::uuid end
      from public.drafts d where not exists (select 1 from public.decisions y where y.draft_id = d.id)`;
  });

  const env = (over: Record<string, string> = {}) => ({
    RESEND_API_KEY: KEY,
    GAUGELINE_EMAIL_FROM: "Gaugeline <morning@mail.studio.test>",
    GAUGELINE_DASHBOARD_URL: "https://dashboard.example.test/",
    GAUGELINE_EMAIL_TOKEN_SECRET: SECRET,
    ...over,
  });
  const deps = (over: Record<string, string> = {}) =>
    morningFromEnv(app.sql, env(over), { endpoint })!;
  const person = async (orgId: string, userId: string, frequency: string | null = null) => {
    const email = `u${++n}@mail.example.test`;
    await owner`insert into public.email_preferences (org_id, user_id, email, email_confirmed_at, frequency)
      values (${orgId}, ${userId}, ${email}, ${hoursAgo(120)}, ${frequency})`;
    return email;
  };
  const waiting = async (_n: number, orgId: string, hours: number, subject = "A draft") => {
    const id = `a1d20000-0000-4000-8000-${String(1000 + ++n).padStart(12, "0")}`;
    await owner`insert into public.drafts (id, org_id, site_id, kind, payload, finding_ids, created_at)
      values (${id}, ${orgId}, ${orgId === ORG_A ? SITE_A1 : SITE_B1}, 'email',
        ${owner.json({ subject, body: "SECRET-BODY-TEXT" })}, '{}', ${hoursAgo(hours)})`;
    return id;
  };
  const rows = () =>
    owner`select user_id, status, attempts, last_error from public.email_sends order by user_id`;

  it("a waiting draft and no change: one email to the owner, in the stand-in, with the id answered", async () => {
    const to = await person(ORG_A, USER_A_OWNER);
    const id = await waiting(1, ORG_A, 30, "Your menu link is fixed");
    expect(await sendMorningEmails(deps(), NOW)).toEqual({ sent: 1, failed: 0 });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.auth).toBe(`Bearer ${KEY}`);
    expect(seen[0]!.body).toMatchObject({ to: [to], from: "Gaugeline <morning@mail.studio.test>" });
    const text = seen[0]!.body.text as string;
    expect(seen[0]!.body.subject).toBe("1 draft waiting for your approval");
    expect(text).toContain("Your menu link is fixed");
    expect(text).toContain(`https://dashboard.example.test/inbox/${id}`);
    expect(text).toContain("/email/preferences?t=");
    expect(JSON.stringify(seen[0]!.body)).not.toMatch(/SECRET-BODY-TEXT|re_test_/);
    expect(await rows()).toMatchObject([{ status: "sent", attempts: 1 }]);
  });

  it("once a day: a second pass, and a later pass the same morning, send nothing more", async () => {
    await person(ORG_A, USER_A_OWNER);
    await waiting(1, ORG_A, 30);
    const d = deps();
    await sendMorningEmails(d, NOW);
    await sendMorningEmails(d, min(30));
    await waiting(2, ORG_A, 1);
    await sendMorningEmails(d, min(60));
    expect(seen).toHaveLength(1);
  });

  it("nothing changed and nothing waits: nothing is sent and nothing is written", async () => {
    await person(ORG_A, USER_A_OWNER);
    // A decided draft and another organisation's draft do not count.
    const decided = await waiting(1, ORG_A, 30);
    await owner`insert into public.decisions (org_id, draft_id, decision, decided_by)
      values (${ORG_A}, ${decided}, 'declined', ${USER_A_OWNER})`;
    await waiting(2, ORG_B, 30);
    expect(await sendMorningEmails(deps(), NOW)).toEqual({ sent: 0, failed: 0 });
    expect(seen).toEqual([]);
    expect(await rows()).toEqual([]);
  });

  it("the morning-email rules decide who: not a client viewer, not a member who never opted in, not someone off", async () => {
    await person(ORG_A, USER_A_CLIENT, "every_change");
    await person(ORG_A, USER_A_MEMBER);
    await person(ORG_B, USER_B_OWNER, "off");
    await waiting(1, ORG_A, 30);
    await waiting(2, ORG_B, 30);
    expect(await sendMorningEmails(deps(), NOW)).toEqual({ sent: 0, failed: 0 });
    expect(seen).toEqual([]);
  });

  it("the placeholder domain with a key: nothing is sent, no row is claimed, the pass says why", async () => {
    await person(ORG_A, USER_A_OWNER);
    await waiting(1, ORG_A, 30);
    const report = await sendMorningEmails(deps({ GAUGELINE_EMAIL_FROM: DEFAULT_MAIL_FROM }), NOW);
    expect(report).toEqual({ sent: 0, failed: 0, refused: "sender-domain-not-configured" });
    expect(seen).toEqual([]);
    expect(await rows()).toEqual([]);
    // Swap the domain and the same morning's email goes out.
    expect(await sendMorningEmails(deps(), min(20))).toEqual({ sent: 1, failed: 0 });
  });

  it("429 and 503 are retried after 10 minutes, a 422 is not, and the key is in no row", async () => {
    await person(ORG_A, USER_A_OWNER);
    await waiting(1, ORG_A, 30);
    answers = [{ status: 429, body: `{"message":"key ${KEY} limited"}` }];
    expect(await sendMorningEmails(deps(), NOW)).toEqual({ sent: 0, failed: 1 });
    expect(await rows()).toMatchObject([{ status: "failed", last_error: "provider-busy" }]);
    expect(await sendMorningEmails(deps(), min(5))).toEqual({ sent: 0, failed: 0 });
    expect(await sendMorningEmails(deps(), min(11))).toEqual({ sent: 1, failed: 0 });
    expect(await rows()).toMatchObject([{ status: "sent", attempts: 2 }]);
    await owner`delete from public.email_sends`;
    answers = [{ status: 422, body: "{}" }];
    await sendMorningEmails(deps(), min(100));
    await sendMorningEmails(deps(), min(160));
    expect(await rows()).toMatchObject([{ status: "failed", attempts: 1, last_error: "rejected" }]);
    expect(JSON.stringify(await owner`select * from public.email_sends`)).not.toContain(KEY);
  });

  it("a huge inbox is read once and capped: five are listed, the rest counted", async () => {
    await person(ORG_A, USER_A_OWNER);
    await owner`insert into public.drafts (org_id, site_id, kind, payload, finding_ids, created_at)
      select ${ORG_A}, ${SITE_A1}, 'email', json_build_object('subject', 'Draft ' || g, 'body', 'x')::jsonb, '{}',
        ${hoursAgo(30)}
      from generate_series(1, 300) g`;
    await sendMorningEmails(deps(), NOW);
    const text = seen[0]!.body.text as string;
    expect(text).toContain("300 drafts wait for approval");
    expect(text).toContain("and 295 more in the inbox");
    expect(text.length).toBeLessThan(5000);
  });
});
