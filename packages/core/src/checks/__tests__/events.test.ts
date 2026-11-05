import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { startFixture } from "../../../../fixtures/src/index.js";
import { lazyCalendars } from "../../calendars.js";
import { createFetcher } from "../../fetcher.js";
import { expandCalendar, nextAfter } from "../../ics/expand.js";
import { parseIcs, unescapeText, unfold } from "../../ics/parse.js";
import { localDate, localTime } from "../../ics/time.js";
import { createBudget } from "../../limits.js";
import { checkSite } from "../../site.js";
import { startServer, type FixtureServer } from "../../__tests__/helpers/server.js";
import { eventJsonldMismatch } from "../event-jsonld-mismatch.js";
import { eventLocationMismatch } from "../event-location-mismatch.js";
import { eventPastUpcoming } from "../event-past-upcoming.js";
import { eventTime } from "../events/events.js";
import { page } from "./helpers.js";

const LA = "America/Los_Angeles";
const NOW = new Date("2026-11-05T20:00:00Z");
const EVENT_CHECKS = [
  "ics-floating-time",
  "ics-no-vtimezone",
  "event-past-upcoming",
  "event-jsonld-mismatch",
  "event-location-mismatch",
  "event-missing-fields",
];
const servers: FixtureServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

/** A minimal calendar around some VEVENT lines. */
function ics(...events: string[][]): string {
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    ...events.flatMap((e) => ["BEGIN:VEVENT", ...e, "END:VEVENT"]),
    "END:VCALENDAR",
  ].join("\r\n");
}

/** A check context whose calendars are the given .ics texts, already read. */
function withCalendar(text: string, extra: Record<string, unknown> = {}) {
  const file = parseIcs(text);
  return {
    warn: () => undefined,
    now: () => NOW,
    calendars: async () => [
      { url: "https://kettle.example/calendar.ics", state: "found" as const, file },
    ],
    ...extra,
  };
}

describe("ics reader: unit", () => {
  it("line unfolding, escaped commas, CRLF and LF files", () => {
    const folded = "SUMMARY:Trivia night at the Copper\r\n  Kettle\\, upstairs\r\nLOCATION:Room 2";
    expect(unfold(folded)).toEqual([
      "SUMMARY:Trivia night at the Copper Kettle\\, upstairs",
      "LOCATION:Room 2",
    ]);
    expect(unfold(folded.replace(/\r\n/g, "\n"))).toEqual(unfold(folded));
    expect(unescapeText("a\\, b\\; c\\\\ d\\nnext")).toBe("a, b; c\\ d\nnext");
    const crlf = parseIcs(ics(["SUMMARY:Quiz\\, round two", "DTSTART:20261112T190000Z"]));
    const lf = parseIcs(
      ics(["SUMMARY:Quiz\\, round two", "DTSTART:20261112T190000Z"]).replace(/\r\n/g, "\n"),
    );
    expect(crlf.events[0]?.summary).toBe("Quiz, round two");
    expect(lf.events).toEqual(crlf.events);
  });

  it("DTSTART with TZID, with Z, and floating; each classified correctly", () => {
    const f = parseIcs(
      ics(
        ["SUMMARY:a", `DTSTART;TZID=${LA}:20261112T190000`],
        ["SUMMARY:b", "DTSTART:20261112T190000Z"],
        ["SUMMARY:c", "DTSTART:20261112T190000"],
        ["SUMMARY:d", "DTSTART;VALUE=DATE:20261112"],
      ),
    );
    expect(f.events.map((e) => [e.summary, e.start?.kind, e.start?.tzid])).toEqual([
      ["a", "zoned", LA],
      ["b", "utc", undefined],
      ["c", "floating", undefined],
      ["d", "date", undefined],
    ]);
  });

  it("RRULE weekly on TH expands to the right dates across the November DST change (America/Los_Angeles)", () => {
    const f = parseIcs(
      ics([
        "SUMMARY:Karaoke",
        `DTSTART;TZID=${LA}:20261022T210000`,
        "RRULE:FREQ=WEEKLY;BYDAY=TH;COUNT=4",
      ]),
    );
    const x = expandCalendar(f, Date.parse("2026-10-20T12:00:00Z"), LA);
    expect(x.occurrences.map((o) => new Date(o.start).toISOString())).toEqual([
      "2026-10-23T04:00:00.000Z", // 22 Oct, 9 PM PDT (UTC-7)
      "2026-10-30T04:00:00.000Z", // 29 Oct, 9 PM PDT
      "2026-11-06T05:00:00.000Z", // 5 Nov, 9 PM PST (UTC-8): clocks went back on 1 Nov
      "2026-11-13T05:00:00.000Z",
    ]);
    expect(x.occurrences.every((o) => localTime(o.start, LA) === "21:00")).toBe(true);
    expect(x.occurrences.map((o) => o.date)).toEqual([
      "2026-10-22",
      "2026-10-29",
      "2026-11-05",
      "2026-11-12",
    ]);
  });

  it("MONTHLY with an ordinal BYDAY and with BYSETPOS", () => {
    const f = parseIcs(
      ics(
        ["SUMMARY:Pop-up", `DTSTART;TZID=${LA}:20261105T180000`, "RRULE:FREQ=MONTHLY;BYDAY=1TH"],
        [
          "SUMMARY:Quiz final",
          `DTSTART;TZID=${LA}:20261127T190000`,
          "RRULE:FREQ=MONTHLY;BYDAY=FR;BYSETPOS=-1",
        ],
      ),
    );
    const x = expandCalendar(f, NOW.getTime(), LA);
    expect(x.occurrences.filter((o) => o.name === "Pop-up").map((o) => o.date)).toEqual([
      "2026-11-05",
      "2026-12-03",
      "2027-01-07",
    ]);
    expect(x.occurrences.filter((o) => o.name === "Quiz final").map((o) => o.date)).toEqual([
      "2026-11-27",
      "2026-12-25",
      "2027-01-29",
    ]);
    expect(nextAfter(x.occurrences, NOW.getTime())?.name).toBe("Pop-up");
  });

  it("event-past-upcoming with ctx.now one minute before and one minute after the start", async () => {
    const p = page({
      jsonLd: [
        {
          "@type": "Event",
          name: "Quiz",
          startDate: "2026-11-12T19:00:00-08:00",
          location: "Bar",
          eventStatus: "x",
        },
      ],
    });
    const start = Date.parse("2026-11-12T19:00:00-08:00");
    const at = (ms: number) => ({
      warn: () => undefined,
      now: () => new Date(ms),
      expect: { timeZone: LA },
    });
    expect(await eventPastUpcoming.run(p, at(start - 60_000))).toEqual([]);
    expect(await eventPastUpcoming.run(p, at(start + 60_000))).toEqual([
      expect.objectContaining({
        evidence: 'structured data event "Quiz" started 2026-11-12T19:00:00-08:00',
      }),
    ]);
  });

  it("JSON-LD versus .ics matched on date and normalised name; a renamed night is reported, not silently matched", async () => {
    const cal = ics(
      ["SUMMARY:Trivia night!", `DTSTART;TZID=${LA}:20261112T193000`],
      ["SUMMARY:Open mic", `DTSTART;TZID=${LA}:20261113T200000`],
    );
    const p = page({
      jsonLd: [
        { "@type": "Event", name: "Trivia Night", startDate: "2026-11-12T19:00:00-08:00" },
        { "@type": "Event", name: "Poetry evening", startDate: "2026-11-13T20:00:00-08:00" },
      ],
    });
    const found = await eventJsonldMismatch.run(p, withCalendar(cal));
    expect(found.map((f) => f.evidence)).toEqual([
      '"Trivia Night" on 2026-11-12 (America/Los_Angeles): start: the page says 19:00, the calendar says 19:30',
      '"Poetry evening" on 2026-11-13 (America/Los_Angeles): name: the page says "Poetry evening", the calendar says "Open mic"',
    ]);
  });
});

describe("events: integration (fixture site)", () => {
  it("the venue fixture gives exactly the four expected findings, with evidence quoting both values", async () => {
    const site = await startFixture("venue");
    try {
      const fetcher = createFetcher({ allowPrivate: true, timeoutMs: 5000 });
      const { result } = await checkSite({
        address: site.origin,
        fetcher,
        only: EVENT_CHECKS,
        now: () => NOW,
      });
      expect(result.findings.map((f) => [f.checkId, f.evidence])).toEqual([
        [
          "event-jsonld-mismatch",
          '"Trivia Night" on 2026-11-12 (America/Los_Angeles): start: the page says 19:00, the calendar says 19:30',
        ],
        [
          "event-past-upcoming",
          'the "next" card "Next up Darts league final, Sunday 1 November, 8 PM" is dated 2026-11-01T20:00:00-07:00',
        ],
        [
          "ics-floating-time",
          '1 of 3 events in /calendar.ics have no time zone: "Darts league" DTSTART:20261119T200000',
        ],
        ["event-missing-fields", '"Karaoke" has no eventStatus'],
      ]);
      expect(result.failed).toEqual([]);
    } finally {
      await site.close();
    }
  });
});

describe("events: edge cases", () => {
  it("an .ics with 2,000 events: only the next 90 days are expanded, and the report says so", async () => {
    const events = Array.from({ length: 2000 }, (_, i) => {
      const d = new Date(Date.UTC(2026, 0, 1) + i * 24 * 60 * 60 * 1000);
      const ymd = d.toISOString().slice(0, 10).replace(/-/g, "");
      return [`SUMMARY:Night ${i}`, `DTSTART;TZID=${LA}:${ymd}T190000`];
    });
    const file = parseIcs(ics(...events));
    const x = expandCalendar(file, NOW.getTime(), LA);
    expect(x.events).toBe(2000);
    expect(x.occurrences.length).toBeGreaterThanOrEqual(90);
    expect(x.occurrences.length).toBeLessThanOrEqual(92);
    expect(x.outsideWindow).toBe(2000 - x.occurrences.length);
    const warnings: string[] = [];
    await eventJsonldMismatch.run(
      page({
        jsonLd: [{ "@type": "Event", name: "Night 320", startDate: "2026-11-17T19:00:00-08:00" }],
      }),
      { ...withCalendar(ics(...events)), warn: (m: string) => warnings.push(m) },
    );
    expect(warnings).toContainEqual(
      expect.stringMatching(/2000 events; only the next 90 days were expanded \(\d+ occurrences\)/),
    );
  });

  it("an RRULE the reader doesn't support: could-not-check with the rule quoted", async () => {
    const cal = ics([
      "SUMMARY:Happy hour",
      `DTSTART;TZID=${LA}:20261105T170000`,
      "RRULE:FREQ=DAILY;BYHOUR=17",
    ]);
    expect(expandCalendar(parseIcs(cal), NOW.getTime(), LA).unsupported).toEqual([
      { summary: "Happy hour", reason: "RRULE:FREQ=DAILY;BYHOUR=17 (FREQ=DAILY is not read)" },
    ]);
    const warnings: string[] = [];
    await eventJsonldMismatch.run(
      page({
        jsonLd: [{ "@type": "Event", name: "Happy hour", startDate: "2026-11-06T17:00:00-08:00" }],
      }),
      { ...withCalendar(cal), warn: (m: string) => warnings.push(m) },
    );
    expect(warnings).toContain(
      'Could not check "Happy hour" in https://kettle.example/calendar.ics: RRULE:FREQ=DAILY;BYHOUR=17 (FREQ=DAILY is not read).',
    );
  });

  it("an all-day event (VALUE=DATE) is not treated as midnight local", () => {
    const x = expandCalendar(
      parseIcs(ics(["SUMMARY:Closed for a private party", "DTSTART;VALUE=DATE:20261126"])),
      NOW.getTime(),
      LA,
    );
    expect(x.occurrences[0]).toMatchObject({ date: "2026-11-26", allDay: true });
    const t = eventTime("2026-11-26", LA);
    expect(t).toMatchObject({ date: "2026-11-26", allDay: true });
    // A date-only event dated today is not "past" at 8 PM: it lasts the whole local day.
    const today = page({
      jsonLd: [{ "@type": "Event", name: "Open day", startDate: localDate(NOW.getTime(), LA) }],
    });
    return expect(
      eventPastUpcoming.run(today, {
        warn: () => undefined,
        now: () => NOW,
        expect: { timeZone: LA },
      }),
    ).resolves.toEqual([]);
  });

  it("an event that crosses midnight is on its start date and ends the next day", () => {
    const x = expandCalendar(
      parseIcs(
        ics([
          "SUMMARY:Late show",
          `DTSTART;TZID=${LA}:20261107T230000`,
          `DTEND;TZID=${LA}:20261108T013000`,
        ]),
      ),
      NOW.getTime(),
      LA,
    );
    const o = x.occurrences[0];
    expect(o?.date).toBe("2026-11-07");
    expect(localDate(o?.end ?? 0, LA)).toBe("2026-11-08");
    expect(((o?.end ?? 0) - (o?.start ?? 0)) / 60_000).toBe(150);
  });

  it("an .ics served as text/html (a login page) is could-not-check", async () => {
    const server = await startServer({
      "/calendar.ics": (_req: IncomingMessage, res: ServerResponse) => {
        res
          .writeHead(200, { "content-type": "text/html" })
          .end("<!doctype html><title>Sign in</title><form></form>");
      },
    });
    servers.push(server);
    const read = lazyCalendars({
      page: page({ calendars: [`${server.origin}/calendar.ics`] }),
      fetcher: createFetcher({ allowPrivate: true }),
      budget: createBudget(),
    });
    expect(await read()).toEqual([
      {
        url: `${server.origin}/calendar.ics`,
        state: "unchecked",
        reason: "it is served as text/html, not a calendar (a login or error page?)",
      },
    ]);
  });

  it("an event at the venue with a different address is event-location-mismatch; another place is not", () => {
    const venue = {
      "@type": "BarOrPub",
      name: "Copper Kettle Tavern",
      telephone: "+1 503-555-0177",
      address: { streetAddress: "88 Ferrous Lane", postalCode: "97999" },
    };
    const ev = (name: string, street: string) => ({
      "@type": "Event",
      name: "Quiz",
      startDate: "2026-11-12T19:00:00-08:00",
      location: { "@type": "Place", name, address: { streetAddress: street, postalCode: "97999" } },
    });
    const ctx = { warn: () => undefined };
    expect(
      eventLocationMismatch.run(
        page({ jsonLd: [venue, ev("Copper Kettle Tavern", "12 Old Mill Road")] }),
        ctx,
      ),
    ).toEqual([
      expect.objectContaining({
        evidence:
          '"Quiz" is at "12 Old Mill Road, 97999"; Copper Kettle Tavern is at "88 Ferrous Lane, 97999"',
      }),
    ]);
    expect(
      eventLocationMismatch.run(
        page({ jsonLd: [venue, ev("Fernvale Town Hall", "12 Old Mill Road")] }),
        ctx,
      ),
    ).toEqual([]);
  });
});
