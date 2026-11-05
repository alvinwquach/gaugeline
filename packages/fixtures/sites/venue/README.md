# venue

An invented tavern (America/Los_Angeles) for the N01 event checks. With the run's clock at
2026-11-05T20:00:00Z, the event checks find exactly four things:

- event-past-upcoming: the "next night" card is dated 1 November.
- event-jsonld-mismatch: Trivia Night is 19:00 in the structured data and 19:30 in the calendar.
- event-missing-fields: Karaoke has no eventStatus.
- ics-floating-time: the darts league's DTSTART has no time zone.

The calendar has a VTIMEZONE, so ics-no-vtimezone is not reported, and the events at the venue use
its own address, so event-location-mismatch is not either.
