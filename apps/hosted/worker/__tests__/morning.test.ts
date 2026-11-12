/**
 * Unit: the morning email's rules with no database. Which sites count for which setting, the plain
 * sentence per site, the subject, hostile text, 07:00 in a time zone across the clock changes, and the
 * signed preference link.
 */
import { describe, expect, it } from "vitest";
import {
  buildMorningEmail,
  mergeBySite,
  effectiveFrequency,
  forFrequency,
  localMorning,
  type SiteChange,
} from "../email/morning.js";

const DASH = "https://dashboard.example.test/";
const LINK = "https://dashboard.example.test/email/preferences?t=abc";

const bar: SiteChange = {
  siteId: "a1000000-0000-4000-8000-0000000000a1",
  siteName: "The Tidewater Bar",
  opened: 1,
  openedHigh: 1,
  closed: 0,
  topTitle: "Broken link on the menu page",
};
const popup: SiteChange = {
  siteId: "a2000000-0000-4000-8000-0000000000a2",
  siteName: "Juniper Pop-up Kitchen",
  opened: 0,
  openedHigh: 0,
  closed: 2,
  topTitle: null,
};
const mail = (changes: SiteChange[]) =>
  buildMorningEmail({
    orgName: "Northgate Studio",
    changes,
    dashboardUrl: DASH,
    preferencesUrl: LINK,
  });

describe("who gets what, by setting", () => {
  it("defaults: owners and admins are on, members are off, a client viewer is never mailed", () => {
    expect(effectiveFrequency(null, "owner")).toBe("every_change");
    expect(effectiveFrequency(null, "admin")).toBe("every_change");
    expect(effectiveFrequency(null, "member")).toBe("off");
    expect(effectiveFrequency(null, "client")).toBe("off");
    // Whatever a client row says, it is off: nothing here is for a client viewer.
    expect(effectiveFrequency("every_change", "client")).toBe("off");
    expect(effectiveFrequency("fix_first", "member")).toBe("fix_first");
    expect(effectiveFrequency("off", "owner")).toBe("off");
  });

  it("every change keeps any site that opened or closed something", () => {
    expect(forFrequency([bar, popup], "every_change")).toEqual([bar, popup]);
  });

  it("fix first keeps only sites with a new high-severity finding, and not the fixed ones", () => {
    const low = { ...bar, siteId: "x", openedHigh: 0, topTitle: "No canonical address" };
    expect(forFrequency([bar, popup, low], "fix_first")).toEqual([bar]);
  });

  it("off keeps nothing; a site with nothing opened or closed is never kept", () => {
    expect(forFrequency([bar], "off")).toEqual([]);
    expect(forFrequency([{ ...bar, opened: 0, openedHigh: 0, closed: 0 }], "every_change")).toEqual(
      [],
    );
  });
});

describe("the email", () => {
  it("quiet night: no email at all", () => {
    expect(mail([])).toBeNull();
  });

  it("one new finding: the finding is the subject, one sentence, a link, no pixel", () => {
    const m = mail([bar])!;
    expect(m.subject).toBe("New: Broken link on the menu page (The Tidewater Bar)");
    expect(m.text).toContain(
      'The Tidewater Bar: 1 new problem (1 to fix first). Start with "Broken link on the menu page".',
    );
    expect(m.text).toContain(DASH);
    expect(m.text).toContain(LINK);
    expect(m.html).toContain(`href="${DASH}"`);
    expect(m.html).not.toMatch(/<img|<script|<style|<link|url\(|<iframe/i);
    // No tracking: the only addresses in the message are the two we gave.
    const urls = (m.html.match(/https?:\/\/[^"'<\s]+/g) ?? []).sort();
    expect(urls).toEqual([DASH, LINK].sort());
  });

  it("only fixes: the subject says how many were fixed", () => {
    const m = mail([popup])!;
    expect(m.subject).toBe("2 problems fixed on 1 site");
    expect(m.text).toContain("Juniper Pop-up Kitchen: 2 problems fixed.");
  });

  it("three sites changed on one night: one email, one sentence each", () => {
    const third: SiteChange = {
      ...bar,
      siteId: "c",
      siteName: "Maple Street Physio",
      opened: 3,
      openedHigh: 0,
      closed: 1,
      topTitle: "No canonical address",
    };
    const m = mail([bar, popup, third])!;
    expect(m.subject).toBe("4 new problems on 3 sites, 3 fixed");
    expect(m.text).toContain("Maple Street Physio: 3 new problems and 1 fixed.");
    expect(m.text.match(/^.+: \d+ (new|problems? fixed)/gm)).toHaveLength(3);
  });

  it("is the fix-first count in the sentence, and does not dump evidence", () => {
    const m = mail([{ ...bar, opened: 5, openedHigh: 2 }])!;
    expect(m.text).toContain("5 new problems (2 to fix first)");
    expect(m.text).not.toMatch(/evidence|404/i);
  });

  it("hostile text: markup is escaped, header injection and hidden characters are removed", () => {
    const evil: SiteChange = {
      ...bar,
      siteName: '<img src=x onerror="alert(1)"> Bar',
      topTitle:
        "Menu\r\nBcc: attacker@evil.test\r\n<script>alert(1)</script> \u202Etxt.exe \u{E0049}\u{E0067}",
    };
    const m = mail([evil])!;
    expect(m.subject).not.toMatch(/[\r\n\u202E]/);
    expect(m.subject).not.toMatch(/[\u{E0000}-\u{E007F}]/u);
    expect(m.html).not.toMatch(/<img|<script/i);
    expect(m.html).toContain("&lt;script&gt;");
    expect(m.html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
    expect(m.text).not.toMatch(/[\u202E]|[\u{E0000}-\u{E007F}]/u);
    // The injected header line cannot start a line of its own in the subject or the text.
    expect(m.text).not.toMatch(/^Bcc:/m);
  });

  it("a very long title is cut in the subject and the body", () => {
    const m = mail([{ ...bar, topTitle: "x".repeat(5000) }])!;
    expect(m.subject.length).toBeLessThan(200);
    expect(m.text.length).toBeLessThan(1500);
  });

  it("refuses a dashboard address that is not https (a javascript: or data: link)", () => {
    for (const bad of ["javascript:alert(1)", "data:text/html,x", "http://dashboard.example.test/"])
      expect(() =>
        buildMorningEmail({
          orgName: "x",
          changes: [bar],
          dashboardUrl: bad,
          preferencesUrl: LINK,
        }),
      ).toThrow(/https/);
  });
});

describe("07:00 in the person's own time zone", () => {
  const at = (iso: string, zone: string) => localMorning(new Date(iso), zone);

  it("is due from 07:00 until 11:00 local time, and names the local date", () => {
    expect(at("2026-11-12T06:59:00Z", "UTC")).toEqual({ localDate: "2026-11-12", due: false });
    expect(at("2026-11-12T07:00:00Z", "UTC")).toEqual({ localDate: "2026-11-12", due: true });
    expect(at("2026-11-12T10:59:00Z", "UTC")).toEqual({ localDate: "2026-11-12", due: true });
    expect(at("2026-11-12T11:00:00Z", "UTC")).toEqual({ localDate: "2026-11-12", due: false });
  });

  it("uses the local date, not the UTC date (Toronto is behind, Auckland ahead)", () => {
    expect(at("2026-11-12T03:00:00Z", "America/Toronto")).toEqual({
      localDate: "2026-11-11",
      due: false,
    });
    expect(at("2026-11-12T12:00:00Z", "America/Toronto")).toEqual({
      localDate: "2026-11-12",
      due: true,
    });
    expect(at("2026-11-11T18:30:00Z", "Pacific/Auckland")).toEqual({
      localDate: "2026-11-12",
      due: true,
    });
  });

  it("spring forward in London (29 Mar 2026): 07:00 is 06:00 UTC that day, and not the day before", () => {
    expect(at("2026-03-28T07:00:00Z", "Europe/London")?.due).toBe(true); // 07:00 GMT
    expect(at("2026-03-29T05:59:00Z", "Europe/London")?.due).toBe(false); // 06:59 BST
    expect(at("2026-03-29T06:00:00Z", "Europe/London")).toEqual({
      localDate: "2026-03-29",
      due: true,
    }); // 07:00 BST
    expect(at("2026-03-29T07:00:00Z", "Europe/London")?.due).toBe(true); // 08:00 BST, still in the window
  });

  it("fall back in London (25 Oct 2026): the morning comes once, with one local date", () => {
    expect(at("2026-10-25T06:30:00Z", "Europe/London")?.due).toBe(false); // 06:30 GMT
    expect(at("2026-10-25T07:00:00Z", "Europe/London")).toEqual({
      localDate: "2026-10-25",
      due: true,
    });
    expect(at("2026-10-25T00:30:00Z", "Europe/London")?.localDate).toBe("2026-10-25"); // 01:30 BST
  });

  it("a half-hour zone (India, +05:30)", () => {
    expect(at("2026-11-12T01:29:00Z", "Asia/Kolkata")?.due).toBe(false);
    expect(at("2026-11-12T01:30:00Z", "Asia/Kolkata")?.due).toBe(true);
  });

  it("a zone nobody knows is null, so one bad row cannot stop the others", () => {
    expect(at("2026-11-12T07:00:00Z", "Mars/Olympus")).toBeNull();
    expect(at("2026-11-12T07:00:00Z", "")).toBeNull();
  });
});

describe("several runs of one site since the last email", () => {
  const row = (over: Partial<SiteChange>) => ({ ...bar, ...over });
  it("counts add up and the most urgent latest title is shown", () => {
    const merged = mergeBySite([
      row({ opened: 1, openedHigh: 0, topTitle: "No canonical address", closed: 0 }),
      row({ opened: 1, openedHigh: 1, topTitle: "Menu page returns 404", closed: 1 }),
      row({ opened: 2, openedHigh: 0, topTitle: "Missing alt text", closed: 0 }),
      row({
        siteId: "other",
        siteName: "Maple Street Physio",
        opened: 0,
        openedHigh: 0,
        closed: 1,
        topTitle: null,
      }),
    ]);
    expect(merged).toHaveLength(2);
    expect(merged[0]).toMatchObject({
      opened: 4,
      openedHigh: 1,
      closed: 1,
      topTitle: "Menu page returns 404",
    });
    expect(merged[1]!.siteName).toBe("Maple Street Physio");
  });
});
