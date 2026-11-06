# How Gaugeline reads a venue calendar

A venue's calendar is where its website most often lies: a night that already happened is still
"next", or a phone calendar shows the wrong hour. These checks read the page's Event structured
data, any "next" or "upcoming" card, and the .ics calendars the page links to.

## What is read

- **Calendars:** `<link rel="alternate" type="text/calendar">`, links ending in `.ics`, and
  `webcal://` links (requested over https). At most 3 per run. A calendar that answers with an HTML
  page (often a sign-in page) is "could not check", not an empty calendar.
- **Events:** schema.org `Event` and its subtypes (`MusicEvent`, `SocialEvent`, `FoodEvent` and so
  on) in the page's JSON-LD.
- **"Next" cards:** an element whose class, id or `data-` attribute names it as the next or upcoming
  event, with a `<time datetime="...">` inside.

The calendar reader is deliberately small. It reads `SUMMARY`, `LOCATION`, `DTSTART`, `DTEND`,
`VTIMEZONE` and `RRULE` with `FREQ=WEEKLY` or `FREQ=MONTHLY` and `BYDAY` (and `BYSETPOS` for monthly).
Any other rule is reported as could not check, with the rule quoted, never guessed. Recurrences are
expanded for the next 90 days only; a calendar with more events says so in the run's notes.

## Time zones

Every date is compared in the venue's time zone, never the machine's: a check that passed in CI and
failed for guests would be worse than none. The zone is the one you configure, else the calendar's
own (`X-WR-TIMEZONE`, or the `TZID` its events use). Recurrences are worked out in the venue's
wall time, so a 9 PM Thursday night is still 9 PM the week the clocks change. An all-day event
(`VALUE=DATE`) is a date, not midnight.

## Example

Against the invented `venue` fixture, a tavern whose "next night" card is out of date, with the
run's clock set to 5 November 2026, version 0.1.0 prints:

```text title=Output
✗ The page and the calendar disagree about an event
    "Trivia Night" on 2026-11-12 (America/Los_Angeles): start: the page says 19:00, the calendar says 19:30
✗ The page still promotes an event that already happened
    the "next" card "Next up Darts league final, Sunday 1 November, 8 PM" is dated 2026-11-01T20:00:00-07:00
✗ Your calendar shows the wrong hour on some phones
    1 of 3 events in /calendar.ics have no time zone: "Darts league" DTSTART:20261119T200000
· Some events are missing details search engines need
    "Karaoke" has no eventStatus
? 4 checks could not run: email-spf-missing, email-spf-multiple, email-dmarc-missing, email-dmarc-none
    Mail records are read from DNS only with --dns. Rerun with --dns to check them.

4 to look at, 3 to fix first.
```

Each check that passed also prints a `✓ <id>` line, left out above. The output is asserted by
`packages/cli/src/__tests__/events.test.ts`.
