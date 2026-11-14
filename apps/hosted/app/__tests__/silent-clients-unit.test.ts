/**
 * A client with no run in 7 days is "silent": the all-clients page says so instead of showing zeros, lists silent
 * clients first (longest silent first), and the nav links to /clients for staff only. The clock is always passed in.
 */
import { describe, expect, it } from "vitest";
import {
  silenceOf,
  silenceText,
  sortClientsSilentFirst,
  sortClientsWorstFirst,
  type Silence,
} from "../../agency/weekly-update.js";
import { markup } from "../../lib/web/html.js";
import { respondHtml } from "../../lib/web/layout.js";
import type { Membership, Role } from "../../lib/web/memberships.js";

const NOW = new Date("2026-11-12T09:00:00Z");
const DAY = 86_400_000;
const ago = (ms: number) => new Date(NOW.getTime() - ms);

describe("silenceOf: no run in more than 7 days", () => {
  it("a run 8 days ago is silent for 8 days", () => {
    expect(silenceOf(ago(8 * DAY), NOW)).toEqual({ days: 8 });
  });
  it("a run 2 days ago is not silent", () => {
    expect(silenceOf(ago(2 * DAY), NOW)).toBeNull();
  });
  it("exactly 7 days is not silent; one millisecond more is, counted in whole days (7)", () => {
    expect(silenceOf(ago(7 * DAY), NOW)).toBeNull();
    expect(silenceOf(ago(7 * DAY + 1), NOW)).toEqual({ days: 7 });
    expect(silenceOf(ago(8 * DAY - 1), NOW)).toEqual({ days: 7 });
  });
  it("no run ever is silent with no number", () => {
    expect(silenceOf(null, NOW)).toEqual({ days: null });
  });
  it("a run stamped after now (clock skew) is not silent", () => {
    expect(silenceOf(new Date(NOW.getTime() + DAY), NOW)).toBeNull();
  });
});

describe("silenceText", () => {
  it("says the days, or that there is no run yet, and never invents a number", () => {
    expect(silenceText({ days: 8 })).toBe("No run in 8 days");
    expect(silenceText({ days: null })).toBe("No run yet");
  });
});

describe("sortClientsSilentFirst", () => {
  const row = (name: string, high: number, silence: Silence | null) => ({
    name,
    high,
    open: high,
    changed: 0,
    silence,
  });
  it("puts silent clients first, longest silent first (never run first), then by name; the rest worst first", () => {
    const order = sortClientsSilentFirst([
      row("Calm Cafe", 0, null),
      row("Busy Bar", 5, null),
      row("Zed Zoo", 0, { days: 9 }),
      row("Alder Clinic", 0, { days: 9 }),
      row("Maple Mill", 0, { days: 30 }),
      row("New Nursery", 0, { days: null }),
    ]);
    expect(order.map((c) => c.name)).toEqual([
      "New Nursery",
      "Maple Mill",
      "Alder Clinic",
      "Zed Zoo",
      "Busy Bar",
      "Calm Cafe",
    ]);
  });
  it("leaves the worst-first order of clients that are not silent as it was", () => {
    const rows = [
      row("Calm Cafe", 0, null),
      row("Busy Bar", 1, null),
      row("Alder Clinic", 0, null),
    ];
    expect(sortClientsSilentFirst(rows).map((c) => c.name)).toEqual(
      sortClientsWorstFirst(rows).map((c) => c.name),
    );
  });
});

describe("the nav link to /clients", () => {
  const membership = (role: Role): Membership => ({
    orgId: "0a000000-0000-4000-8000-00000000000a",
    orgName: "Northgate Studio",
    role,
    siteId: role === "client" ? "a1000000-0000-4000-8000-0000000000a1" : null,
  });
  const page = async (role: Role) => {
    const m = membership(role);
    const res = respondHtml(200, "Sites", markup`<p>x</p>`, {
      email: "a-person",
      memberships: [m],
      current: m,
    });
    return res.text();
  };
  it.each(["owner", "admin", "member"] as const)("shows for %s", async (role) => {
    expect(await page(role)).toContain('<a href="/clients"');
  });
  it("does not show for a client viewer, who is redirected away from /clients", async () => {
    expect(await page("client")).not.toContain('href="/clients"');
  });
  it("marks Clients as the current page on the clients page, and not Sites", async () => {
    const m = membership("owner");
    const html = await respondHtml(200, "Clients", markup`<p>x</p>`, {
      email: "a-person",
      memberships: [m],
      current: m,
      active: "clients",
    }).text();
    expect(html).toMatch(/href="\/clients" aria-current="page"/);
    expect(html).not.toMatch(/href="\/" aria-current="page"/);
  });
});
