# ADR-0011: Listing watch is the listings checks on a schedule, not a new reader

Status: proposed Date: 2026-11-12

**Waiting for the owner's decision; nothing is built.** This record proposes; it changes no code, no
flag and no line of CLAUDE.md. Branch `08/adr-later-work`, spec row G40. The spec asked for three
records numbered 0002 to 0004; those numbers are taken, so they are 0011 (this one), 0012 and 0013.
It needs the pull requests that add ADR-0009 and ADR-0010 merged first, or the numbers have a gap.

## Context

Gaugeline already compares the web's copy of a business with the site. The listings checks (N15, merged)
read a Google Business Profile or Places record, a Yelp record, an Apple Business Connect export and a
link-in-bio address, then compare name, phone, address, hours and the website link with the site's own
LocalBusiness data. They run when someone runs Gaugeline. The landing page's "Before a launch" section
lists a listing watch as being explored, and the roadmap says the pages must call it "on the roadmap,
not in the product". People will ask what it is and what it would read. A listing is seen more than the
site, and it is edited in a dashboard nobody connects to the site, so the question is real.

### What each source gives, and whether it can be read without writing

| Source                                                    | How it is read today                               | Read without writing?                                                                |
| --------------------------------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Google Business Profile                                   | `GET` of one location with the owner's OAuth token | Yes, but the only scope Google documents for it can also write: uncited, see Sources |
| Google Places                                             | `GET` of Place Details with a restricted key       | Yes                                                                                  |
| Yelp                                                      | `GET` of business details with a key               | Yes                                                                                  |
| Apple Business Connect                                    | A CSV the owner exports; no call is made           | Yes, but it cannot be watched: someone has to export again                           |
| Instagram and Facebook bios                               | `GET` of the link-in-bio page the owner names      | Yes. The social profile itself is never requested                                    |
| Other directories (Bing Places, Tripadvisor and the like) | Not read                                           | Undecided: each needs its own key type, terms and record before it is added          |

## Decision

A listing watch is not a new reader. It is the six listing checks run on a schedule, and "watching"
means one finding appearing, staying or closing between two runs.

- **Nothing new is read.** The sources above are the sources. A directory is added only by its own
  record. A social platform is never requested (the listings settings already refuse those hosts).
- **Nothing new is stored.** The hosted tier keeps a finding's fingerprint, check id, severity, title,
  evidence line and address (G34), and compares fingerprints between runs to say "opened", "still open"
  or "closed". A listing's text is not kept: the report names the field and the mismatch, and the
  current value is read live. No table, no column and no dependency is added.
- **The schedule is the nightly run (G36).** A watch is a site with `gaugeline.listings.json` and a run
  every night, or on publish. Without a schedule there is nothing to build: the checks already exist.
- **Every request stays a `GET`.** The keys come from the environment, never reach a log, a finding or a
  report, and the owner's token is the owner's to revoke.

## Alternatives

- **A watcher that searches the web for the business and reads listing sites it finds.** Lost: it reads
  pages nobody agreed to be read and with no documented endpoint, which is the scraping rule 14 and the
  adapter rules rule out, and it would find a different copy each day.
- **Keep each night's listing text so the report can show what changed.** Lost: it stores a business's
  content (the adapter rules keep fingerprints, never content), and the platforms' terms on keeping
  their data are uncited. A fingerprint says that it changed and the live read says to what.
- **Platform notifications pushed to Gaugeline.** Lost: an inbound request is a new surface, and
  Gaugeline sends and receives nothing but the reads and the owner's own notifications (ADR-0003,
  ADR-0005).
- **Do nothing.** The answer until the trigger below: run the listings checks by hand or in CI.

## Cost

- A fingerprint says a listing changed, not who changed it or what it said before.
- Apple's listing cannot be watched without a person exporting the file again.
- Each night spends the owner's own quota on the Google and Yelp keys. What that costs per site is
  uncited: the platforms' pricing and quota pages could not be read.
- The watch is only as fresh as the schedule, and it depends on G34 and G36, which are not built.

## What would change it

A platform publishing a documented read-only change feed would replace polling. A read-only Business
Profile scope would remove the one credential caveat. A key type that cannot read at all would stop a
source being watched.

## Sources and what could not be read

Vendor documentation could not be read from this session (the network refused every vendor host), so
every claim about what a platform allows or charges is **uncited** and appears above only as a question.
What is cited is this repository: `docs/connectors/listings.md` (what each source reads and cannot read,
and that Google's scope can also write), `packages/core/src/listings/config.ts` and `packages/core/src/listings/sources/bio.ts` (social hosts are
refused), and the spec's roadmap table and G34 entry (the fingerprint, and nothing but evidence is kept).
The shapes the N15 sources use were written without the official pages, and PROGRESS.md lists them as
unverified; a watch inherits that until they are checked.

## Enforced by

Nothing new, because nothing is built. What already holds:

- `packages/core/src/fetcher.ts` (every request is a `GET` or a `HEAD`; private, loopback, link-local
  and metadata addresses are refused)
- `packages/core/src/listings/read.ts` (the listings read; a source with no key is could-not-check and the others still run)
- `packages/core/src/listings/config.ts` (a social platform's own address is refused in the settings)
- `packages/core/src/listings/sources/bio.ts` (the link-in-bio connector, which never requests a profile)
- `docs/connectors/listings.md` (the page that says what each source can and cannot read)
- `packages/core/src/__tests__/post-boundary.test.ts` (nothing but the allowed files sends a `POST`)

## Build when

Both of these, which a person can check:

1. G34 (the hosted schema) and G36 (nightly runs) have merged.
2. Three people who run listings checks for a client have each opened an issue labelled
   `listing-watch` asking to be told when a listing changes, or one agency with ten or more
   locations has. The numbers are this record's proposal; the owner may change them.
