/**
 * Applying an approved Sanity draft (X71, ADR-0010): two reads of the document, then one request that creates
 * `drafts.<id>`, and one trail entry on every outcome. Against the in-memory stand-in (sanity-helpers.ts).
 * Every refusal has one fault against an otherwise valid job, and a test checks the valid one passes first.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { applySanityDraft } from "../sanity/apply.js";
import { valueSha256 } from "../sanity/hash.js";
import { sanitySender } from "../sanity/send.js";
import { resolveMode } from "../switches.js";
import { sha256, TOKEN } from "./helpers.js";
import {
  fakeSanity,
  LIVE,
  SANITY_PAYLOAD,
  SANITY_TARGET,
  sanityDeps,
  sanityJob,
} from "./sanity-helpers.js";

afterEach(() => vi.unstubAllGlobals());

const DRAFT_ID = "drafts.menu-page";
const payloadWith = (over: Record<string, unknown>) => ({ ...SANITY_PAYLOAD, ...over });
const setField = (field: string, value: unknown, live: unknown = undefined) => ({
  ...SANITY_PAYLOAD,
  set: { [field]: value },
  before: { [field]: valueSha256(live) },
});

describe("a valid job", () => {
  it("reads the live document and its draft, then creates the draft with the fix in it, once", async () => {
    const s = fakeSanity();
    const d = sanityDeps({ send: s.send });
    const entry = await applySanityDraft(sanityJob(), d);
    expect(entry).toMatchObject({ outcome: "applied", ref: DRAFT_ID });
    expect(s.sent.map((r) => `${r.endpoint} ${r.path.split("/").pop()}`)).toEqual([
      "getDoc menu-page",
      `getDoc ${DRAFT_ID}`,
      "mutate production",
    ]);
    expect(d.log).toEqual([entry]);
    expect(d.lookups).toEqual(["42"]);
  });

  it("the draft is a copy of the live document with only the corrected field changed", async () => {
    const s = fakeSanity();
    await applySanityDraft(sanityJob(), sanityDeps({ send: s.send }));
    const draft = s.docs.get(DRAFT_ID)!;
    expect(draft).toEqual({
      _id: DRAFT_ID,
      _type: "page",
      title: LIVE.title,
      hours: "Mon to Sun, 4pm to 11pm",
      phone: LIVE.phone,
      sections: LIVE.sections,
    });
    // The system fields are not sent; the live document is untouched.
    expect(
      Object.keys(draft)
        .filter((k) => k.startsWith("_"))
        .sort(),
    ).toEqual(["_id", "_type"]);
    expect(s.docs.get("menu-page")).toEqual(LIVE);
  });

  it("makes exactly one write, and it names the drafts. id and never the live id", async () => {
    const s = fakeSanity();
    await applySanityDraft(sanityJob(), sanityDeps({ send: s.send }));
    expect(s.writes()).toHaveLength(1);
    const body = JSON.stringify(s.writes()[0]!.body);
    expect(body).toContain(`"_id":"${DRAFT_ID}"`);
    expect(body).not.toContain('"_id":"menu-page"');
    expect(Object.keys((s.writes()[0]!.body!.mutations as object[])[0]!)).toEqual(["create"]);
    // The reads are reads: no body.
    for (const r of s.sent.filter((x) => x.endpoint === "getDoc")) expect(r.body).toBeUndefined();
  });

  it("a field that was never set has the digest of null", async () => {
    const s = fakeSanity();
    const payload = setField("tagline", "Cocktails by the water");
    const d = sanityDeps(
      { send: s.send, target: { ...SANITY_TARGET, allowedFields: ["page.tagline"] } },
      sanityJob(payload),
    );
    expect(await applySanityDraft(sanityJob(payload), d)).toMatchObject({ outcome: "applied" });
    expect(s.docs.get(DRAFT_ID)!.tagline).toBe("Cocktails by the water");
  });

  it("the trail entry holds the outcome and the draft's id, and none of the client's text", async () => {
    const s = fakeSanity();
    const d = sanityDeps({ send: s.send });
    await applySanityDraft(sanityJob(), d);
    const text = JSON.stringify(d.log);
    for (const secret of ["Tidewater", "4pm", "20 7946", "Gin", "Mon to"])
      expect(text).not.toContain(secret);
  });
});

describe("dry run is the default and sends nothing", () => {
  it("an unset or odd mode is a dry run", () => {
    for (const v of [undefined, "", "dry-run", "Write", "true", 1, null])
      expect(resolveMode(v)).toBe("dry-run");
    expect(resolveMode("write")).toBe("write");
  });

  it("records the plan and sends no request at all, not even a read", async () => {
    const s = fakeSanity();
    const d = sanityDeps({ send: s.send, mode: resolveMode(undefined) });
    const entry = await applySanityDraft(sanityJob(), d);
    expect(s.sent).toEqual([]);
    expect(entry).toMatchObject({ outcome: "dry_run" });
    expect(entry.planned!.map((p) => p.endpoint)).toEqual(["getDoc", "getDoc", "mutate"]);
    expect(entry.planned![2]!.path).toBe("/v2025-02-06/data/mutate/production");
    expect(JSON.stringify(entry)).not.toContain("Mon to");
    expect(d.log).toEqual([entry]);
  });

  it("a dry run does not run while a stop is set", async () => {
    const s = fakeSanity();
    const d = sanityDeps({ send: s.send, mode: "dry-run", env: { GAUGELINE_WRITER_STOP: "1" } });
    expect(await applySanityDraft(sanityJob(), d)).toMatchObject({
      outcome: "refused",
      reason: "kill switch",
    });
  });

  it("a dry run still checks the approval, the payload and the registry", async () => {
    const s = fakeSanity();
    const dry = { send: s.send, mode: "dry-run" as const };
    expect(await applySanityDraft(sanityJob(), sanityDeps(dry, sanityJob(), null))).toMatchObject({
      reason: "approval",
    });
    const hostile = sanityJob(payloadWith({ documentId: "drafts.menu-page" }));
    expect(await applySanityDraft(hostile, sanityDeps(dry, hostile))).toMatchObject({
      reason: "payload",
    });
    const price = sanityJob(setField("price", "4.50"));
    expect(await applySanityDraft(price, sanityDeps(dry, price))).toMatchObject({
      reason: "field",
    });
    expect(s.sent).toEqual([]);
  });
});

describe("the approval is read and compared before any request", () => {
  const cases: [string, Parameters<typeof sanityDeps>[2], string][] = [
    ["no approval row", null, "approval"],
    ["a declined decision", { decision: "declined" }, "approval"],
    ["another draft's row", { draftId: "a1d10000-0000-4000-8000-0000000000b2" }, "draft"],
    ["another organisation's row", { orgId: "0b000000-0000-4000-8000-00000000000b" }, "org"],
    ["another site's row", { siteId: "5e000000-0000-4000-8000-0000000000e6" }, "site"],
    ["another kind's row", { kind: "pull_request" }, "kind"],
    ["a hash of another payload", { payloadSha256: sha256("{}") }, "hash"],
    ["a withdrawal after it", { later: ["withdrawn"] }, "withdrawn"],
    ["an approval older than 72 hours", { decidedAt: new Date("2026-11-09T11:59:00Z") }, "expired"],
  ];
  for (const [name, row, reason] of cases)
    it(`refuses ${name}`, async () => {
      const s = fakeSanity();
      const d = sanityDeps({ send: s.send }, sanityJob(), row);
      expect(await applySanityDraft(sanityJob(), d)).toMatchObject({ outcome: "refused", reason });
      expect(s.sent).toEqual([]);
      expect(d.log).toHaveLength(1);
    });

  it("refuses a payload edited after it was approved, including its before digest", async () => {
    const s = fakeSanity();
    const approved = sanityJob();
    // The approval is for the original payload; the job carries a different `before`.
    const tampered = sanityJob(payloadWith({ before: { hours: valueSha256("anything") } }), {
      payloadSha256: approved.payloadSha256,
    });
    const d = sanityDeps({ send: s.send }, approved);
    expect(await applySanityDraft(tampered, d)).toMatchObject({ reason: "hash" });
    expect(s.sent).toEqual([]);
  });

  it("refuses a job of another kind or with a draft id that is not a UUID, even with a matching approval", async () => {
    for (const over of [{ kind: "email" }, { kind: "pull_request" }, { draftId: "not-a-uuid" }]) {
      const s = fakeSanity();
      const j = sanityJob(undefined, over);
      expect(
        await applySanityDraft(j, sanityDeps({ send: s.send }, j)),
        JSON.stringify(over),
      ).toMatchObject({ reason: "kind" });
      expect(s.sent).toEqual([]);
    }
  });

  it("refuses a target that is not plain, even when the job and the approval agree with it", async () => {
    const bads = [
      { projectId: "evil.example" },
      { dataset: "a/b" },
      { apiVersion: "2025-02-06" },
      { orgId: "not-a-uuid" },
      { siteId: "not-a-uuid" },
      { allowedFields: "page.hours" as never },
      { allowedFields: ["hours"] },
      { allowedFields: ["page.*"] },
      { allowedFields: Array.from({ length: 201 }, (_, i) => `page.f${i}`) },
    ];
    for (const bad of bads) {
      const s = fakeSanity();
      const j = sanityJob(undefined, {
        ...("orgId" in bad ? { orgId: bad.orgId } : {}),
        ...("siteId" in bad ? { siteId: bad.siteId } : {}),
      } as never);
      const d = sanityDeps({ send: s.send, target: { ...SANITY_TARGET, ...bad } }, j);
      expect(await applySanityDraft(j, d), JSON.stringify(bad).slice(0, 60)).toMatchObject({
        reason: "target",
      });
      expect(s.sent).toEqual([]);
    }
  });
});

describe("the payload: one document, plain names, an allowed field", () => {
  const hostileIds = [
    "drafts.menu-page",
    "versions.r1.menu-page",
    "a..b",
    "a%2fb",
    "a/b",
    "../menu",
    "menu page",
    "_menu",
    ".menu",
    "menu.page",
  ];
  for (const documentId of hostileIds)
    it(`refuses the document id ${JSON.stringify(documentId)} with no request`, async () => {
      const s = fakeSanity();
      const j = sanityJob(payloadWith({ documentId }));
      expect(await applySanityDraft(j, sanityDeps({ send: s.send }, j))).toMatchObject({
        outcome: "refused",
        reason: "payload",
      });
      expect(s.sent).toEqual([]);
    });

  it("refuses a payload with a key it does not know (a target, a publish flag), a missing before, or no fields", async () => {
    for (const bad of [
      payloadWith({ projectId: "other" }),
      payloadWith({ publish: true }),
      payloadWith({ before: undefined }),
      payloadWith({ set: {}, before: {} }),
    ]) {
      const s = fakeSanity();
      const j = sanityJob(bad);
      expect(await applySanityDraft(j, sanityDeps({ send: s.send }, j))).toMatchObject({
        reason: "payload",
      });
      expect(s.sent).toEqual([]);
    }
  });

  it("refuses a field that is not in allowedFields for that document type", async () => {
    for (const [type, field] of [
      ["page", "heading"],
      ["post", "hours"],
      ["page", "Hours"],
    ] as const) {
      const s = fakeSanity();
      const j = sanityJob({ ...setField(field, "x"), documentType: type });
      expect(await applySanityDraft(j, sanityDeps({ send: s.send }, j))).toMatchObject({
        reason: "field",
      });
      expect(s.sent).toEqual([]);
    }
  });

  it("with no allowed fields at all, every field is refused", async () => {
    const s = fakeSanity();
    const d = sanityDeps({ send: s.send, target: { ...SANITY_TARGET, allowedFields: [] } });
    expect(await applySanityDraft(sanityJob(), d)).toMatchObject({ reason: "field" });
    expect(s.sent).toEqual([]);
  });

  const money = [
    "price",
    "priceFrom",
    "Price",
    "ticket_price",
    "unit_cost",
    "unitprice",
    "cost",
    "fee",
    "serviceFee",
    "currency",
    "discountCode",
    "tariff",
    "paymentLink",
    "slug",
    "password",
    "secretKey",
    "token",
    "accessToken",
    "auth_token",
    "apiKey",
  ];
  for (const field of money)
    it(`never changes ${field}, even when it is allowed (prices and secrets are for a person)`, async () => {
      const s = fakeSanity();
      const j = sanityJob(setField(field, "4.50"));
      const d = sanityDeps(
        { send: s.send, target: { ...SANITY_TARGET, allowedFields: [`page.${field}`] } },
        j,
      );
      expect(await applySanityDraft(j, d)).toMatchObject({ outcome: "refused", reason: "field" });
      expect(s.sent).toEqual([]);
    });

  it("does not refuse a field that only looks like a price word inside another word", async () => {
    for (const field of ["description", "operatingHours", "tagline", "rating"]) {
      const s = fakeSanity();
      const j = sanityJob(setField(field, "x"));
      const d = sanityDeps(
        { send: s.send, target: { ...SANITY_TARGET, allowedFields: [`page.${field}`] } },
        j,
      );
      expect(await applySanityDraft(j, d), field).toMatchObject({ outcome: "applied" });
    }
  });
});

describe("a stale or missing document is refused, and nothing is written", () => {
  it("refuses when the live value changed since the fix was proposed", async () => {
    const s = fakeSanity({ live: { ...LIVE, hours: "Mon to Sat, 5pm to midnight" } });
    const d = sanityDeps({ send: s.send });
    expect(await applySanityDraft(sanityJob(), d)).toMatchObject({
      outcome: "refused",
      reason: "stale",
    });
    expect(s.writes()).toEqual([]);
    expect(s.docs.has(DRAFT_ID)).toBe(false);
  });

  it("a change to another field is not stale", async () => {
    const s = fakeSanity({ live: { ...LIVE, phone: "+44 20 7946 0001" } });
    expect(await applySanityDraft(sanityJob(), sanityDeps({ send: s.send }))).toMatchObject({
      outcome: "applied",
    });
    expect(s.docs.get(DRAFT_ID)!.phone).toBe("+44 20 7946 0001");
  });

  it("refuses when the field was set meanwhile and the proposal said it was empty", async () => {
    const s = fakeSanity({ live: { ...LIVE, tagline: "New" } });
    const j = sanityJob(setField("tagline", "Cocktails"));
    const d = sanityDeps(
      { send: s.send, target: { ...SANITY_TARGET, allowedFields: ["page.tagline"] } },
      j,
    );
    expect(await applySanityDraft(j, d)).toMatchObject({ reason: "stale" });
    expect(s.writes()).toEqual([]);
  });

  it("refuses a document that does not exist, and one of another type", async () => {
    const none = fakeSanity({ live: null });
    expect(await applySanityDraft(sanityJob(), sanityDeps({ send: none.send }))).toMatchObject({
      reason: "missing",
    });
    const other = fakeSanity({ live: { ...LIVE, _type: "post" } });
    expect(await applySanityDraft(sanityJob(), sanityDeps({ send: other.send }))).toMatchObject({
      reason: "type",
    });
    const gone = fakeSanity({ readStatus: 404 });
    expect(await applySanityDraft(sanityJob(), sanityDeps({ send: gone.send }))).toMatchObject({
      reason: "missing",
    });
    for (const s of [none, other, gone]) expect(s.writes()).toEqual([]);
  });

  it("refuses a live document too large to copy", async () => {
    const s = fakeSanity({ live: { ...LIVE, body: "x".repeat(600_000) } });
    expect(await applySanityDraft(sanityJob(), sanityDeps({ send: s.send }))).toMatchObject({
      reason: "document",
    });
    expect(s.writes()).toEqual([]);
  });
});

describe("an existing draft is never overwritten, and a replay makes no second write", () => {
  it("refuses when a draft exists with another value for the field, and says so", async () => {
    const draft = { ...LIVE, _id: DRAFT_ID, hours: "Fri to Sun only" };
    const s = fakeSanity({ draft });
    const d = sanityDeps({ send: s.send });
    expect(await applySanityDraft(sanityJob(), d)).toMatchObject({
      outcome: "refused",
      reason: "draft exists",
    });
    expect(s.writes()).toEqual([]);
    expect(s.docs.get(DRAFT_ID)!.hours).toBe("Fri to Sun only");
  });

  it("applying the same approval twice creates one draft and one write", async () => {
    const s = fakeSanity();
    const first = await applySanityDraft(sanityJob(), sanityDeps({ send: s.send }));
    const second = await applySanityDraft(sanityJob(), sanityDeps({ send: s.send }));
    expect(first).toMatchObject({ outcome: "applied", ref: DRAFT_ID });
    expect(second).toMatchObject({ outcome: "applied", ref: DRAFT_ID });
    expect(s.writes()).toHaveLength(1);
  });

  it("a draft made between the read and the write (a conflict) is a failure with the status, not an overwrite", async () => {
    // An editor creates the draft after the writer has read both documents and before it writes.
    const racer: ReturnType<typeof fakeSanity> = fakeSanity({
      after: (n) => {
        if (n === 2)
          racer.docs.set(DRAFT_ID, { ...LIVE, _id: DRAFT_ID, hours: "An editor's text" });
      },
    });
    const d = sanityDeps({ send: racer.send });
    expect(await applySanityDraft(sanityJob(), d)).toEqual({
      draftId: sanityJob().draftId,
      decisionId: "42",
      outcome: "apply_failed",
      status: 409,
    });
    expect(racer.docs.get(DRAFT_ID)!.hours).toBe("An editor's text");
  });
});

describe("the kill switches are checked before every request", () => {
  it("a stop set before the job sends nothing", async () => {
    const s = fakeSanity();
    const d = sanityDeps({ send: s.send, env: { GAUGELINE_WRITER_STOP: "1" } });
    expect(await applySanityDraft(sanityJob(), d)).toMatchObject({
      outcome: "refused",
      reason: "kill switch",
    });
    expect(s.sent).toEqual([]);
  });

  it("a paused organisation, or a pause that cannot be read, sends nothing", async () => {
    for (const orgPaused of [
      async () => true,
      async () => {
        throw new Error("db down");
      },
    ]) {
      const s = fakeSanity();
      expect(
        await applySanityDraft(sanityJob(), sanityDeps({ send: s.send, orgPaused })),
      ).toMatchObject({ reason: "organisation paused" });
      expect(s.sent).toEqual([]);
    }
  });

  it("a stop between the first read and the write stops before the write", async () => {
    const env: Record<string, string | undefined> = {};
    const s = fakeSanity({
      after: (n) => {
        if (n === 2) env.GAUGELINE_WRITER_STOP = "1";
      },
    });
    const entry = await applySanityDraft(sanityJob(), sanityDeps({ send: s.send, env }));
    expect(entry).toMatchObject({ outcome: "refused", reason: "kill switch" });
    expect(s.sent).toHaveLength(2);
    expect(s.writes()).toEqual([]);
  });

  it("a pause that starts after the first request stops the next one", async () => {
    let calls = 0;
    const s = fakeSanity();
    const d = sanityDeps({ send: s.send, orgPaused: async () => ++calls > 2 });
    expect(await applySanityDraft(sanityJob(), d)).toMatchObject({ reason: "organisation paused" });
    expect(s.writes()).toEqual([]);
  });
});

describe("a failure leaves a trail entry that says what happened and nothing else", () => {
  it("a read that fails is apply_failed with the status, and the response text is not kept", async () => {
    const s = fakeSanity({ readStatus: 500 });
    const d = sanityDeps({ send: s.send });
    // A 500 on the first read: apply_failed, no write.
    expect(await applySanityDraft(sanityJob(), d)).toMatchObject({
      outcome: "apply_failed",
      status: 500,
    });
    expect(JSON.stringify(d.log)).not.toContain("RESPONSE-TEXT");
    expect(s.writes()).toEqual([]);
  });

  it("a write that fails is apply_failed with the status, and the response text is not kept", async () => {
    const s = fakeSanity({ mutateStatus: 403 });
    const d = sanityDeps({ send: s.send });
    expect(await applySanityDraft(sanityJob(), d)).toMatchObject({
      outcome: "apply_failed",
      status: 403,
    });
    expect(JSON.stringify(d.log)).not.toContain("RESPONSE-TEXT");
  });

  it("a connection that fails leaves apply_failed in the trail, then lets the error go on", async () => {
    const d = sanityDeps({
      send: async () => {
        throw new Error("the request to Sanity failed");
      },
    });
    await expect(applySanityDraft(sanityJob(), d)).rejects.toThrow("the request to Sanity failed");
    expect(d.log).toMatchObject([{ outcome: "apply_failed" }]);
  });

  it("a registry refusal inside the apply is a refusal, not an error", async () => {
    const d = sanityDeps({
      send: async () => {
        const { SanityRegistryError } = await import("../sanity/endpoints.js");
        throw new SanityRegistryError("refused mutate: x");
      },
    });
    expect(await applySanityDraft(sanityJob(), d)).toMatchObject({
      outcome: "refused",
      reason: "registry",
    });
  });
});

describe("through the sender: the whole path, and the token goes nowhere but the header", () => {
  it("runs a job end to end over the sender and a stubbed fetch, with no token in the trail, the logs or the URLs", async () => {
    const s = fakeSanity();
    const urls: string[] = [];
    const headers: Headers[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      urls.push(url);
      headers.push(new Headers(init.headers));
      const path = new URL(url).pathname;
      const req =
        init.method === "POST"
          ? {
              endpoint: "mutate" as const,
              path,
              query: { returnIds: "true" },
              body: JSON.parse(String(init.body)) as Record<string, unknown>,
            }
          : { endpoint: "getDoc" as const, path };
      const r = await s.send(req);
      return new Response(JSON.stringify(r.json), { status: r.status });
    });
    const logs = [vi.spyOn(console, "log"), vi.spyOn(console, "error"), vi.spyOn(console, "warn")];
    const send = sanitySender({ ...SANITY_TARGET, token: TOKEN });
    const d = sanityDeps({ send });
    const entry = await applySanityDraft(sanityJob(), d);
    expect(entry).toMatchObject({ outcome: "applied", ref: DRAFT_ID });
    expect(urls.every((u) => new URL(u).origin === "https://tidewtr1.api.sanity.io")).toBe(true);
    expect(urls.join()).not.toContain(TOKEN);
    expect(headers.every((h) => h.get("authorization") === `Bearer ${TOKEN}`)).toBe(true);
    expect(JSON.stringify(d.log)).not.toContain(TOKEN);
    for (const l of logs) expect(l).not.toHaveBeenCalled();
    expect(s.writes()).toHaveLength(1);
  });

  it("a failed answer's text, which here carries the token, reaches neither the trail nor the error", async () => {
    vi.stubGlobal("fetch", async () => new Response(`denied for ${TOKEN}`, { status: 401 }));
    const d = sanityDeps({ send: sanitySender({ ...SANITY_TARGET, token: TOKEN }) });
    const entry = await applySanityDraft(sanityJob(), d);
    expect(entry).toMatchObject({ outcome: "apply_failed", status: 401 });
    expect(JSON.stringify(d.log)).not.toContain(TOKEN);
  });

  it("a dropped connection throws a message with neither the token nor the project", async () => {
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      throw new Error(`down: ${url} ${new Headers(init.headers).get("authorization")}`);
    });
    const d = sanityDeps({ send: sanitySender({ ...SANITY_TARGET, token: TOKEN }) });
    const err = await applySanityDraft(sanityJob(), d).catch((e: unknown) => e);
    expect(String((err as Error).message)).not.toMatch(new RegExp(`${TOKEN}|tidewtr1`));
    expect(JSON.stringify(d.log)).not.toContain(TOKEN);
  });
});

describe("an approval that was already applied is never applied again", () => {
  it("records the replay with no request at all, even when the editor discarded the draft", async () => {
    // The first apply wrote a draft and recorded `applied` after the approval; the draft is gone now.
    const s = fakeSanity();
    const d = sanityDeps({ send: s.send }, sanityJob(), { later: ["applied"] });
    const entry = await applySanityDraft(sanityJob(), d);
    expect(entry).toMatchObject({ outcome: "refused", reason: "duplicate" });
    expect(s.sent).toEqual([]);
    expect(s.docs.has(DRAFT_ID)).toBe(false);
    expect(d.log).toEqual([entry]);
  });

  it("holds in a dry run too, and after other outcomes", async () => {
    const dry = fakeSanity();
    const d1 = sanityDeps({ send: dry.send, mode: "dry-run" }, sanityJob(), {
      later: ["dry_run", "applied"],
    });
    expect(await applySanityDraft(sanityJob(), d1)).toMatchObject({ reason: "duplicate" });
    expect(dry.sent).toEqual([]);
  });

  it("an earlier failure or dry run is not an application: the job may go on", async () => {
    for (const later of [
      [],
      ["dry_run"],
      ["apply_failed"],
      ["refused"],
      ["dry_run", "apply_failed"],
    ]) {
      const s = fakeSanity();
      const d = sanityDeps({ send: s.send }, sanityJob(), { later });
      expect(await applySanityDraft(sanityJob(), d), later.join()).toMatchObject({
        outcome: "applied",
      });
      expect(s.writes()).toHaveLength(1);
    }
  });
});

describe("only the exact word write writes", () => {
  for (const mode of [
    undefined,
    null,
    "",
    "Write",
    "WRITE",
    "write ",
    " write",
    "apply",
    "true",
    1,
    true,
    "dry-run",
  ]) {
    it(`mode ${JSON.stringify(mode)} stays a dry run`, async () => {
      const s = fakeSanity();
      const d = sanityDeps({ send: s.send, mode: mode as never });
      expect(await applySanityDraft(sanityJob(), d)).toMatchObject({ outcome: "dry_run" });
      expect(s.sent).toEqual([]);
    });
  }
});

describe("an answer is read only for the document that was asked for", () => {
  /** A send that answers every read with `documents`, whatever was asked, and records the writes. */
  const answering = (documents: unknown[]) => {
    const sent: string[] = [];
    const send = async (req: { endpoint: string; path: string }) => {
      sent.push(req.endpoint);
      if (req.endpoint === "mutate") return { status: 200, json: {} };
      return { status: 200, json: { documents } };
    };
    return { sent, send };
  };

  it("a live read that answers with another document's id is a missing document", async () => {
    const a = answering([{ ...LIVE, _id: "other-page" }]);
    const d = sanityDeps({ send: a.send as never });
    expect(await applySanityDraft(sanityJob(), d)).toMatchObject({
      outcome: "refused",
      reason: "missing",
    });
    expect(a.sent).toEqual(["getDoc"]);
  });

  it("a draft read that answers with another document's id is not an existing draft: it is created", async () => {
    // The live read finds the live page; the draft read answers with the live page again (a different _id).
    const a = answering([LIVE]);
    const d = sanityDeps({ send: a.send as never });
    expect(await applySanityDraft(sanityJob(), d)).toMatchObject({
      outcome: "applied",
      ref: DRAFT_ID,
    });
    expect(a.sent).toEqual(["getDoc", "getDoc", "mutate"]);
  });

  it("an answer that is not a list of documents is a missing document", async () => {
    for (const json of [null, {}, { documents: "x" }, { documents: [null, 3, "x"] }]) {
      const send = async () => ({ status: 200, json });
      expect(
        await applySanityDraft(sanityJob(), sanityDeps({ send: send as never })),
      ).toMatchObject({ reason: "missing" });
    }
  });
});
