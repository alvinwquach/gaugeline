# ADR-0012: Creator platform checks: one adapter per room, and a test account before a line is written

Status: proposed Date: 2026-11-12

**Waiting for the owner's decision; nothing is built.** This record proposes; it changes no code, no
flag and no line of CLAUDE.md. Branch `08/adr-later-work`, spec row G40 (the second of three records,
numbered 0011 to 0013 because 0002 to 0004 are taken).

## Context

The landing page's "For creators" section lists nine platform checks, one per "room", and the spec's
roadmap table says: "Needs a test account per room. A product line of its own." That is all the spec
says. It does not name the nine rooms, and the landing page is not in this repository, so this record
cannot list them. It reads "room" as one platform or surface where a creator sells, publishes or hosts
people, which is an assumption the owner should confirm or correct.

What is known from the code Gaugeline already has is the cost of getting an adapter wrong. N15 (the
listings checks) shipped with its Google and Yelp response shapes written without the official pages,
and PROGRESS.md lists every field as unverified until someone records a response with a real key. A room
check built the same way would be nine such lists.

### What a room has to answer before its check is built

The owner fills one card per room. Where an answer is unknown, the default is "could-not-check", never a
guess and never a scrape.

| Question                                                  | Why it decides                                                     |
| --------------------------------------------------------- | ------------------------------------------------------------------ |
| Is there a documented read endpoint or page?              | No documented read means nothing can be checked                    |
| Is there a key type that cannot write?                    | If not, the docs page says so first (the adapter rules)            |
| Can it be read without writing and without login?         | A login is never driven (rule 14); a key the creator makes is fine |
| Is there a free or cheap account to test on?              | The recorded responses come from it                                |
| What does a response carry that is the creator's content? | Reports show field names and the mismatch, never the text          |

## Decision

1. **One adapter per room, on the existing adapter contract.** Read only (`GET` or `HEAD`; a `POST` only
   for a documented read-only query through ADR-0006), the narrowest key, fingerprints never content,
   recorded responses and invented fixtures. Nothing generic, no shared "platform" reader.
2. **A test account per room comes first.** It is the project's own, created by the owner (no agent
   creates an account), filled with invented content, and used for two things: recording the responses
   the tests replay, and confirming the narrowest key really cannot write. It is never used at run time
   and never holds a customer's data (rule 12).
3. **No login, ever.** Gaugeline reads a public page, or a documented API with a key the creator makes
   and puts in the environment. It never signs in, keeps a session cookie, drives a form or reads an
   admin screen. A room with neither is could-not-check, with the reason.
4. **Rooms are built one at a time, off by default.** A room runs only when its settings file exists, as
   the listings checks do. It is a product line in the sense of its own docs section and check ids; it is
   not a new package or dependency until a first room ships and proves it needs one.

## Alternatives

- **One generic platform adapter for all nine.** Lost: each platform has different access rules and
  different honest answers (N15's own reason for one connector per source).
- **Record responses without a test account, from the documentation alone.** Lost: this is what N15 did,
  and its shapes are still unverified.
- **Borrow a creator's real account to record.** Lost: it puts real content in the repository (rule 12)
  and may break the platform's terms (uncited).
- **Drive a logged-in browser through each dashboard.** Lost: rule 14 forbids login attempts, and ADR-0009
  is about rendering a public page, not signing in.
- **Build all nine together.** Lost: nine accounts, nine fixture sets and one reviewer; the first room
  teaches what the other eight need.

## Cost

- Nine accounts to create and keep alive: free tiers may lapse and paid ones cost money (uncited: no
  platform's pricing page could be read).
- Whether automated testing on a test account is allowed is each platform's terms, and none could be read.
- A recorded response goes stale when the platform changes; each room carries its own upkeep.
- A room with no read-only key or no documented read stays could-not-check, a visible gap in the nine.

## What would change it

A platform offering a sandbox or a read-only key type would lift its card to "yes". A platform
forbidding test accounts would move that room out of reach. The owner naming the nine could split or
merge rooms.

## Sources and what could not be read

Vendor documentation could not be read from this session (the network refused every vendor host), so every
statement about a platform's keys, terms or pricing is **uncited** or phrased as a question. Cited from
this repository: the spec's roadmap table (the nine rooms and the test-account requirement), PROGRESS.md
"Owner actions" (N15's unverified shapes), CLAUDE.md rules 6, 12 and 14, and ADR-0006 and ADR-0009.

## Enforced by

Nothing new, because nothing is built. What already holds:

- `packages/core/src/fetcher.ts` (every request is a `GET` or a `HEAD`; private and metadata addresses are
  refused)
- `packages/core/src/fetch/query-registry.ts` and `packages/core/src/__tests__/post-boundary.test.ts`
  (the only place an adapter may register a read-only `POST`)
- `packages/core/src/consent.ts` (the record of who agreed to probing checks)
- `docs/connectors/listings.md` (the model for a page that lists what a source can and cannot read)

## Build when

For each room, all three, which a person can check:

1. Its card is filled in with documented sources and a key type that cannot write (or the docs page says
   there is none).
2. The owner has created its test account and noted that in PROGRESS.md "Owner actions".
3. A creator who runs that room has asked for it in an issue labelled `platform-check`. For the first
   room, three such issues across any rooms; after that, one per room. The numbers are this record's
   proposal; the owner may change them.
