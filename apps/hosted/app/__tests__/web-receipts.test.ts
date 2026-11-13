// check-community: allow-email (invented people at reserved example domains: the sign-in tests need addresses)
/**
 * GET /receipts against a real Postgres (AG-06): the current organisation's approval receipts as JSON lines,
 * through the web app's own login (a member of `authenticated` only). Owners and admins download a chain
 * that verifies offline; members and client viewers are refused, never handed an empty chain.
 */
import { verifyApprovalReceipts } from "@gaugeline/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HAS_DATABASE, ORG_A, ORG_B } from "../../db/__tests__/harness.js";
import { fixture, PEOPLE, type Fixture } from "./web-helpers.js";

describe.skipIf(!HAS_DATABASE)("GET /receipts", () => {
  let f: Fixture;
  beforeAll(async () => {
    f = await fixture();
  });
  afterAll(async () => {
    await f?.drop();
  });

  it("an owner downloads their organisation's chain, and it verifies offline", async () => {
    const b = f.browser();
    await b.signIn(PEOPLE.maya.email);
    const res = await b.get("/receipts");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/x-ndjson; charset=utf-8");
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="receipts.jsonl"');
    expect(res.headers.get("cache-control")).toBe("no-store");
    const v = verifyApprovalReceipts(await res.text());
    expect(v).toMatchObject({ ok: true, receipts: 1, org: ORG_A });
  });

  it("an admin downloads the organisation they chose, not another one", async () => {
    const b = f.browser();
    await b.signIn(PEOPLE.both.email);
    await b.post("/org", { org: ORG_B });
    const res = await b.get("/receipts");
    expect(res.status).toBe(200);
    expect(verifyApprovalReceipts(await res.text())).toMatchObject({ ok: true, org: ORG_B });
  });

  it("a member and a client viewer are refused (403), and a visitor is sent to sign in", async () => {
    for (const p of [PEOPLE.dev, PEOPLE.manager]) {
      const b = f.browser();
      await b.signIn(p.email);
      const res = await b.get("/receipts");
      expect(res.status, p.email).toBe(403);
      expect(await res.text()).not.toContain('"hash"');
    }
    const res = await f.browser().get("/receipts");
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/sign-in?next=%2Freceipts");
  });

  it("a member of Northgate who is admin elsewhere cannot download Northgate's chain", async () => {
    const b = f.browser();
    await b.signIn(PEOPLE.both.email);
    await b.post("/org", { org: ORG_A });
    expect((await b.get("/receipts")).status).toBe(403);
  });
});
