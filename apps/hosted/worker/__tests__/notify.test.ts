/**
 * Notifications (X67), the parts that need no database: quiet hours in the site's own zone, rule matching,
 * and the short codes the delivery log keeps instead of an error message.
 */
import { describe, expect, it } from "vitest";
import { deliveryCode, matchesRule, sendAfter } from "../notify.js";

describe("quiet hours, in the site's own time zone", () => {
  it("outside quiet hours: send now", () => {
    const now = new Date("2026-11-13T12:00:00Z"); // 12:00 in London
    expect(sendAfter(now, "Europe/London", 22, 7)).toEqual(now);
  });

  it("inside quiet hours that cross midnight: wait for the end hour, local time", () => {
    const now = new Date("2026-11-13T03:10:00Z"); // 03:10 in London, nightly run time
    expect(sendAfter(now, "Europe/London", 22, 7).toISOString()).toBe("2026-11-13T07:00:00.000Z");
    // 03:10 in Toronto is 08:10 UTC; 07:00 Toronto is 12:00 UTC.
    expect(
      sendAfter(new Date("2026-11-13T08:10:00Z"), "America/Toronto", 22, 7).toISOString(),
    ).toBe("2026-11-13T12:00:00.000Z");
  });

  it("quiet hours inside one day", () => {
    const now = new Date("2026-11-13T13:30:00Z");
    expect(sendAfter(now, "Europe/London", 13, 14).toISOString()).toBe("2026-11-13T14:00:00.000Z");
  });

  it("across a clock change, the end hour is still the local end hour", () => {
    // 29 Mar 2026: London moves from GMT to BST at 01:00 UTC. 00:30 GMT, quiet until 07:00 BST = 06:00 UTC.
    expect(sendAfter(new Date("2026-03-29T00:30:00Z"), "Europe/London", 22, 7).toISOString()).toBe(
      "2026-03-29T06:00:00.000Z",
    );
  });

  it("no quiet hours, or start equal to end: send now", () => {
    const now = new Date("2026-11-13T03:10:00Z");
    expect(sendAfter(now, "Europe/London", null, null)).toEqual(now);
    expect(sendAfter(now, "Europe/London", 3, 3)).toEqual(now);
  });
});

describe("rules: which findings go to a channel", () => {
  const f = { checkId: "broken-links", severity: "medium" as const };
  it("by lowest severity", () => {
    expect(matchesRule({ minSeverity: "high", checkIds: null }, f)).toBe(false);
    expect(matchesRule({ minSeverity: "medium", checkIds: null }, f)).toBe(true);
    expect(matchesRule({ minSeverity: "low", checkIds: null }, f)).toBe(true);
  });
  it("by check, when the rule names some", () => {
    expect(matchesRule({ minSeverity: "low", checkIds: ["canonical-missing"] }, f)).toBe(false);
    expect(matchesRule({ minSeverity: "low", checkIds: ["broken-links"] }, f)).toBe(true);
  });
});

describe("the delivery log keeps a code, never the error text", () => {
  it.each([
    [{ ok: true, status: 200, attempts: 1 }, null],
    [{ ok: false, status: 404, attempts: 1, permanent: true }, "http-404"],
    [{ ok: false, status: 503, attempts: 3 }, "http-503"],
    [
      { ok: false, attempts: 3, error: "hooks.slack.com did not answer within 10 seconds" },
      "timeout",
    ],
    [
      {
        ok: false,
        attempts: 1,
        error: "hooks.slack.com is not a public address: nothing was sent",
      },
      "address-refused",
    ],
    [
      { ok: false, attempts: 3, error: "hooks.slack.com could not be reached (ENOTFOUND)" },
      "unreachable",
    ],
    [{ ok: false, attempts: 3, error: "anything else /services/T0/B0/secret" }, "failed"],
  ])("%j -> %s", (r, code) => {
    expect(deliveryCode(r)).toBe(code);
  });
});

describe("a time zone the runtime does not know falls back to UTC (never throws)", () => {
  it.each(["posix/Europe/London", "Factory", "right/UTC", "Not/AZone"])("%s", (zone) => {
    const now = new Date("2026-11-13T03:10:00Z");
    // 03:10 UTC is inside 22-7: the message waits until 07:00 UTC.
    expect(sendAfter(now, zone, 22, 7).toISOString()).toBe("2026-11-13T07:00:00.000Z");
    expect(sendAfter(new Date("2026-11-13T12:00:00Z"), zone, 22, 7).toISOString()).toBe(
      "2026-11-13T12:00:00.000Z",
    );
  });
});
