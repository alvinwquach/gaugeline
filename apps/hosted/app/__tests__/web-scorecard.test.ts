// check-community: allow-email (invented people at reserved example domains: the sign-in tests need addresses)
/**
 * The agent scorecard against a real Postgres (AG-07): counts from the agent trace (0015) and the decisions
 * log, read as the signed-in person, so row-level security decides who sees what.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HAS_DATABASE, ORG_A, ORG_B, SITE_A1 } from "../../db/__tests__/harness.js";
import { asUser } from "../../lib/web/db.js";
import { agentScorecard } from "../../lib/web/scorecard.js";
import { fixture, PEOPLE, type Fixture } from "./web-helpers.js";

const claims = (p: { id: string; email: string }) => ({
  sub: p.id,
  aud: "authenticated",
  role: "authenticated",
  email: p.email,
  iat: 1,
  exp: 4e9,
});
const EMAIL = { subject: "Your menu link is fixed", body: "The drinks page is back." };

describe.skipIf(!HAS_DATABASE)("agent scorecard", () => {
  let f: Fixture;
  let fixer = "";
  let idle = "";

  /** One call on the agent's role, committed: the draft id, or null when the policy refused it. */
  const draft = async (token: string, kind = "email"): Promise<string | null> => {
    let id: string | null = null;
    await f.owner.begin(async (tx) => {
      await tx.unsafe("set local role gaugeline_agent");
      const [r] =
        await tx`select private.agent_insert_draft(${token}, ${SITE_A1}, ${kind}, ${tx.json(EMAIL)}) as id`;
      id = (r!.id as string | null) ?? null;
    });
    return id;
  };
  const decide = (
    draftId: string,
    decision: string,
    extra: { reason?: string; edited?: object } = {},
  ) =>
    asUser(
      f.appSql,
      claims(PEOPLE.maya),
      (
        tx,
      ) => tx`insert into public.decisions (org_id, draft_id, decision, decided_by, reason, edited_payload)
        values (${ORG_A}, ${draftId}, ${decision}, ${PEOPLE.maya.id}, ${extra.reason ?? null},
                ${extra.edited ? tx.json(extra.edited as never) : null})`,
    );
  const register = async (name: string, scopes: string[]) => {
    const [r] = await asUser(
      f.appSql,
      claims(PEOPLE.maya),
      (tx) =>
        tx`select * from private.register_agent(${ORG_A}, ${name}, ${PEOPLE.maya.id}, ${scopes})`,
    );
    return { id: r!.agent_id as string, token: r!.token as string };
  };

  beforeAll(async () => {
    f = await fixture();
    const a = await register("Menu fixer", ["draft:email"]);
    fixer = a.id;
    idle = (await register("Booking page watcher", ["read:runs"])).id;
    await f.owner`update public.agent_limits set calls_per_window = 100 where agent_id = ${a.id}`;
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push((await draft(a.token))!);
    expect(await draft(a.token, "pull_request")).toBeNull(); // refused: scope
    expect(await draft(a.token, "pull_request")).toBeNull();
    await decide(ids[0]!, "approved");
    await decide(ids[1]!, "approved");
    await decide(ids[2]!, "edited", {
      edited: { subject: "Menu link fixed", body: "Drinks are back." },
    });
    await decide(ids[3]!, "declined", { reason: "<b>Wrong</b> opening hours" });
    // ids[4] stays pending.
  });
  afterAll(async () => {
    await f?.drop();
  });

  const card = (p: (typeof PEOPLE)[keyof typeof PEOPLE], org = ORG_A) =>
    asUser(f.appSql, claims(p), (tx) => agentScorecard(tx, org));

  it("an owner sees each agent's real counts; an agent with no call is all zeros and blanks", async () => {
    const list = await card(PEOPLE.maya);
    const by = Object.fromEntries(list.map((a) => [a.id, a]));
    expect(by[fixer]).toMatchObject({
      name: "Menu fixer",
      status: "active",
      calls: 5,
      denies: 2,
      approved: 3,
      edited: 1,
      declined: 1,
      costMicros: 0,
      declineReasons: [{ reason: "<b>Wrong</b> opening hours", count: 1 }],
    });
    expect(by[idle]).toMatchObject({ calls: 0, denies: 0, approved: 0, declined: 0 });
  });

  it("a member, a client viewer and another organisation's owner see no agent of Northgate", async () => {
    expect(await card(PEOPLE.dev)).toEqual([]);
    expect(await card(PEOPLE.manager)).toEqual([]);
    expect(await card(PEOPLE.ben)).toEqual([]);
    expect((await card(PEOPLE.ben, ORG_B)).map((a) => a.id)).not.toContain(fixer);
  });

  it("through the page: rates in whole percent, blanks in words, the reason escaped, and owners only", async () => {
    expect((await f.browser().get("/agents")).status).toBe(303);
    const b = f.browser();
    await b.signIn(PEOPLE.maya.email);
    const res = await b.get("/agents");
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toMatch(/aria-current="page"[^>]*>Agents/);
    expect(body).toContain("Menu fixer");
    // 3 approved of 4 decided = 75%; 1 of 3 approvals edited = 33%; cost 0 / 3 = 0.
    expect(body).toMatch(
      /<td class="num">5<\/td>\s*<td class="num">75%<\/td>\s*<td class="num">33%<\/td>\s*<td class="num">0<\/td>\s*<td class="num">2<\/td>/,
    );
    expect(body).toContain("&lt;b&gt;Wrong&lt;/b&gt; opening hours (1)");
    expect(body).not.toContain("<b>Wrong");
    expect(body).toContain('<td class="num blank">none yet</td>');
    expect(body).toContain('<td class="num blank">not measured</td>');
    expect(body).not.toMatch(/gla_[0-9a-f]{8}_/); // a prefix is shown, never a token
    expect(await (await b.get("/")).text()).toContain('href="/agents"');

    const dev = f.browser();
    await dev.signIn(PEOPLE.dev.email);
    const page = await (await dev.get("/agents")).text();
    expect(page).toContain("Only owners and admins");
    expect(page).not.toContain("Menu fixer");
    expect(await (await dev.get("/")).text()).not.toContain('href="/agents"');
  });
});
