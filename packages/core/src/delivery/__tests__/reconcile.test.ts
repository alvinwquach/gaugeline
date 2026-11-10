// check-community: allow-email (invented addresses at reserved example domains, matched by hash and never printed)
import { describe, expect, it } from "vitest";
import { reconcile, recipientKey, type PaidOrder, type SentEmail } from "../reconcile.js";

const at = (iso: string) => Date.parse(iso);
const order = (email: string | null, iso = "2026-11-05T10:00:00Z"): PaidOrder => ({
  at: at(iso),
  email,
});
const mail = (to: string[], iso = "2026-11-05T10:01:00Z"): SentEmail => ({ at: at(iso), to });

const people = (n: number) => Array.from({ length: n }, (_, i) => `buyer${i}@tideline.example`);

describe("reconcile: unit", () => {
  it("12 paid and 9 sent gives unmatched 3", () => {
    const buyers = people(12);
    const r = reconcile(
      buyers.map((b) => order(b)),
      buyers.slice(0, 9).map((b) => mail([b])),
    );
    expect(r).toMatchObject({ paid: 12, sent: 9, unmatched: 3 });
  });

  it("two orders from one address and one email gives unmatched 1 (a multiset, not a set)", () => {
    const r = reconcile(
      [order("maya@tideline.example"), order("maya@tideline.example", "2026-11-06T10:00:00Z")],
      [mail(["maya@tideline.example"])],
    );
    expect(r).toMatchObject({ paid: 2, sent: 1, unmatched: 1 });
  });

  it("totals alone would hide an order with no email behind another with two", () => {
    // 2 paid, 2 sent, and the totals agree: but the second buyer got nothing.
    const r = reconcile(
      [order("a@tideline.example"), order("b@tideline.example")],
      [mail(["a@tideline.example"]), mail(["a@tideline.example"])],
    );
    expect(r).toMatchObject({ paid: 2, sent: 2, unmatched: 1 });
  });

  it("more emails than orders (resends): unmatched is 0, never negative", () => {
    const r = reconcile(
      [order("a@tideline.example")],
      [mail(["a@tideline.example"]), mail(["a@tideline.example"]), mail(["z@tideline.example"])],
    );
    expect(r).toMatchObject({ paid: 1, sent: 3, unmatched: 0 });
  });

  it("a window with zero orders and zero emails", () => {
    expect(reconcile([], [])).toEqual({ paid: 0, sent: 0, unmatched: 0, byDay: [] });
  });

  it("an order with no address can never be matched", () => {
    const r = reconcile([order(null), order("   ")], [mail(["a@tideline.example"])]);
    expect(r.unmatched).toBe(2);
  });

  it("an email to two people counts once as sent and once for each recipient", () => {
    const r = reconcile(
      [order("a@tideline.example"), order("b@tideline.example")],
      [mail(["a@tideline.example", "b@tideline.example", "A@Tideline.example"])],
    );
    expect(r).toMatchObject({ paid: 2, sent: 1, unmatched: 0 });
  });

  it("the answer does not depend on the order of the lists", () => {
    const buyers = people(7);
    const paid = buyers.map((b, i) => order(b, `2026-11-0${1 + (i % 5)}T10:00:00Z`));
    const sent = buyers.slice(2).map((b) => mail([b]));
    const forward = reconcile(paid, sent);
    expect(reconcile([...paid].reverse(), [...sent].reverse())).toEqual(forward);
  });
});

describe("recipientKey: unit", () => {
  it("is a SHA-256 hex of the lower-cased, trimmed address", () => {
    const key = recipientKey("  Maya@Tideline.Example ");
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(key).toBe(recipientKey("maya@tideline.example"));
    expect(key).not.toContain("maya");
  });

  it("reads the address inside a display name", () => {
    expect(recipientKey('"Maya Ortiz" <Maya@Tideline.example>')).toBe(
      recipientKey("maya@tideline.example"),
    );
  });

  it("is null for an empty or missing address", () => {
    expect(recipientKey("")).toBeNull();
    expect(recipientKey("  ")).toBeNull();
    expect(recipientKey(null)).toBeNull();
  });
});

describe("reconcile: days", () => {
  it("byDay buckets use UTC days, in order, with both counts", () => {
    const r = reconcile(
      [
        order("a@tideline.example", "2026-11-05T23:59:00Z"),
        order("b@tideline.example", "2026-11-03T00:00:00Z"),
        order("c@tideline.example", "2026-11-05T00:00:00Z"),
      ],
      [mail(["a@tideline.example"], "2026-11-06T00:01:00Z")],
    );
    expect(r.byDay).toEqual([
      { day: "2026-11-03", paid: 1, sent: 0 },
      { day: "2026-11-05", paid: 2, sent: 0 },
      { day: "2026-11-06", paid: 0, sent: 1 },
    ]);
  });

  it("an order at 23:59 and its email at 00:01 the next day still match", () => {
    const r = reconcile(
      [order("a@tideline.example", "2026-11-05T23:59:00Z")],
      [mail(["a@tideline.example"], "2026-11-06T00:01:00Z")],
    );
    expect(r.unmatched).toBe(0);
    expect(r.byDay.map((d) => d.day)).toEqual(["2026-11-05", "2026-11-06"]);
  });

  it("a time zone offset on the input does not move a day: the number is an instant", () => {
    // 2026-11-05T23:30-08:00 is 2026-11-06T07:30Z.
    const r = reconcile([order("a@tideline.example", "2026-11-05T23:30:00-08:00")], []);
    expect(r.byDay).toEqual([{ day: "2026-11-06", paid: 1, sent: 0 }]);
  });
});

describe("reconcile: nothing identifying leaves the function", () => {
  it("the result holds counts and days and no address or hash", () => {
    const r = reconcile([order("maya@tideline.example")], [mail(["other@tideline.example"])]);
    const text = JSON.stringify(r);
    expect(text).not.toContain("@");
    expect(text).not.toMatch(/[0-9a-f]{64}/);
    expect(Object.keys(r).sort()).toEqual(["byDay", "paid", "sent", "unmatched"]);
  });
});
