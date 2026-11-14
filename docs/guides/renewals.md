# Renewals: see what lapses before the site goes dark

When a client's domain or certificate lapses, you get the call, usually from an owner whose website and
email have both stopped. `gaugeline renewals` reads the dates that decide that and prints them in one
list, soonest first, with the date written out: "expires 3 Dec 2026, 22 days". The same checks run in the
page check with `--renewals`, so a nightly run catches a date drifting closer.

It only looks. It never renews, buys, logs in or changes anything, and the only requests are `GET` and
`HEAD`.

```sh
npx gaugeline renewals marlowe-bar.com
```

## What it reads

| What lapses                   | Where the date comes from                                                                       | Needs a key?     |
| ----------------------------- | ----------------------------------------------------------------------------------------------- | ---------------- |
| The domain's registration     | The registry's public RDAP server, found through IANA's bootstrap file. Never WHOIS             | No               |
| The certificate, bare and www | The connection itself: one `HEAD` of each host, not followed                                    | No               |
| A GitHub or Vercel token      | The provider's own answer, only for a token you put in the environment                          | The token itself |
| A Vercel project's Node.js    | The project's setting, against a dated list of the versions Vercel has announced it will retire | The Vercel token |

Everything that is not exposed is listed as "could not be checked", with the reason. Gaugeline does not
guess, and it does not read a registrar's or a provider's web page.

## Example: a bar's site, three things in the next fortnight

Marlowe Bar is an invented client: a bar whose site you built on Next.js and Sanity and host on Vercel.
You keep its Vercel project's name in `gaugeline.renewals.json`, and a GitHub token and a Vercel token in
the environment of the machine that runs the nightly check (the tokens are yours, not the client's).

```json title=gaugeline.renewals.json
{ "vercel": { "projects": ["marlowe-bar-site"] } }
```

```sh title=Terminal untested="Runs the built command against recorded responses for an invented bar. packages/cli/src/__tests__/renewals-docs.test.ts runs it (the docs runner points commands at a fixture site, and this one reads a domain registry and two token APIs) and compares the output with the block below."
$ npx gaugeline renewals marlowe-bar.com
```

```text title=Output
Renewals for marlowe-bar.com, by date
Fix first  Certificate for www.marlowe-bar.com: its certificate does not name it (it names marlowe-bar.com)
Fix first  Vercel project marlowe-bar-site, Node.js 18.x: retired 1 Sep 2025, 436 days ago
Fix first  Certificate for marlowe-bar.com: expires 14 Nov 2026, 3 days
Fix soon   GitHub token (GAUGELINE_GITHUB_TOKEN): expires 26 Nov 2026, 14 days
Fix soon   Domain marlowe-bar.com: expires 3 Dec 2026, 22 days; registrar Plume Registrar, Inc.
-          Vercel token (GAUGELINE_VERCEL_TOKEN): no expiry reported

✗ The site's certificate expires soon
    The certificate for marlowe-bar.com expires on 2026-11-14: 3 days left (issued by Invented Authority)
✗ The bare domain or www is not covered by the certificate
    www.marlowe-bar.com is not covered by its certificate, which names marlowe-bar.com
✗ A Vercel project runs a Node.js version Vercel is retiring
    Vercel project marlowe-bar-site uses Node.js 18.x, which retired 1 Sep 2025, 436 days ago (Gaugeline's list, written 11 Nov 2026; source https://vercel.com/docs/functions/runtimes/node-js/node-js-versions)
! The domain's registration runs out soon
    marlowe-bar.com expires 3 Dec 2026, 22 days (registrar Plume Registrar, Inc.)
! An access token expires soon
    The GitHub token (GAUGELINE_GITHUB_TOKEN) expires 26 Nov 2026, 14 days
? token-expires-soon could not be checked: no expiry reported for the Vercel token (GAUGELINE_VERCEL_TOKEN) (token:vercel)

5 to look at, 3 to fix first.
```

The list at the top is every date Gaugeline read, healthy or not, soonest first. Below it are the
findings, each with why it matters and how to fix it in the report. Here:

- The certificate on the bare domain runs out in three days. Renewal normally happens by itself, so
  find why it stopped (a DNS change at the host is the usual cause).
- `www.marlowe-bar.com` is not on the certificate, so anyone who types it, or follows a link from a
  menu card or a social profile, gets a full-page browser warning. This is a different certificate
  problem from the date: nothing is wrong until someone uses the address.
- The domain renews on 3 December. The registrar's name is in the finding, so you know whose login to
  ask the owner for.
- The Vercel project builds on a Node.js version that Vercel has stopped supporting, so the next deploy
  can fail.
- The GitHub token the sync uses expires in two weeks. The Vercel token reports no expiry, so it is
  listed once as "no expiry reported" and is not a finding.

## Example: a clinic whose site stopped answering

Cedar Clinic's domain was left to a card that expired. The site no longer loads, which is exactly why
the date matters: `renewals` does not need the page. It reads the registration and carries on.

```sh title=Terminal untested="Same as above: packages/cli/src/__tests__/renewals-docs.test.ts runs it against the invented clinic."
$ npx gaugeline renewals cedar-clinic.co.uk
```

```text title=Output
Renewals for cedar-clinic.co.uk, by date
Fix first  Domain cedar-clinic.co.uk: expired 2 Nov 2026, 9 days ago; registrar Harbour Names Ltd; on hold, so it does not resolve

✗ The domain's registration has passed its expiry date
    cedar-clinic.co.uk expired 2 Nov 2026, 9 days ago (registrar Harbour Names Ltd)
✗ The domain is on hold, so it resolves nowhere
    cedar-clinic.co.uk has the status "client hold", so it does not resolve
? token-expires-soon could not be checked: no token is set up (set GAUGELINE_GITHUB_TOKEN or GAUGELINE_VERCEL_TOKEN to check one) (/)
? runtime-deprecated could not be checked: no Vercel project is listed under "vercel" in gaugeline.renewals.json (/)

2 to look at, 2 to fix first.
```

On stderr it says the site did not answer and that the registration was still read. With a lapsed
domain that is the usual picture: renew at the registrar, wait for the hold to clear, and run the
command again. `.co.uk` is a two-part ending, and Gaugeline knows to look up `cedar-clinic.co.uk`, not
`co.uk`.

## The checks

| Check                  | Severity                                   | What it says                                                                        |
| ---------------------- | ------------------------------------------ | ----------------------------------------------------------------------------------- |
| `domain-expires-soon`  | Fix soon under 30 days, first under 7      | The registry's expiration date is close                                             |
| `domain-expired`       | Fix first                                  | The expiration date has passed                                                      |
| `domain-status-hold`   | Fix first                                  | The status is clientHold or serverHold, so the domain resolves nowhere              |
| `certificate-expiring` | Fix soon under 21 days, first under 7      | The certificate's end date is close; with `--renewals` the bare domain and www both |
| `cert-name-mismatch`   | Fix first                                  | The bare domain or www is not on its certificate                                    |
| `token-expires-soon`   | Fix soon under 21 days, first under 7      | A token you set up expires soon, or already has                                     |
| `runtime-deprecated`   | Fix first when retired, soon under 90 days | A Vercel project's Node.js version is one Vercel has announced it will retire       |

`certificate-expiring` already existed, so it is reused rather than copied: it reads the certificate off
the page's own request, and with `--renewals` it also reads the other of the bare domain and www, and
reports one whose date differs. Days are whole days counted in UTC from the run's clock, so a clock
change or a leap day never moves a threshold.

## Domain registration

The registry is asked through RDAP, the registries' public replacement for WHOIS. Gaugeline fetches
IANA's bootstrap file (`https://data.iana.org/rdap/dns.json`) once for the run, finds the server that
answers for the domain's ending, and makes one `GET` of `/domain/<name>` there. It reads three things:
the earliest "expiration" event, the registrar's name, and the status values. It keeps nothing else (no
contact, no registrant).

It is "could not be checked", with the reason in the output, when:

- the ending has no RDAP service in the bootstrap file (some country registries publish only WHOIS), and
  Gaugeline does not read WHOIS, by port or by web page;
- the registry is down, answers with something that is not RDAP, or says 429 (the output says when to
  try again, if the registry said);
- the registry hides its dates: the hold check still runs, and the two date checks say there is no date;
- the host is an address on a platform (`name.vercel.app`, `name.netlify.app`): the platform owns that
  name, so there is no registration of the client's to read. Check the client's own domain instead.

The registered name is the host's last two labels, or three for the common two-part endings (`co.uk`,
`com.au`, `co.nz` and about sixty more, in a list in the repository). For an ending the list does not have,
the registry answers "no such domain" and the output says so. Name the domain yourself in
`gaugeline.renewals.json`:

```json title=gaugeline.renewals.json
{ "domain": "example-shop.co.xx" }
```

## Tokens and runtimes

Only tokens you put in the environment are asked, and only to say when they expire. Nothing is created,
rotated or revoked, and the token is never printed, logged or put in a result.

| Variable                 | Asked                                                                                                        | What is read                                                                        |
| ------------------------ | ------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| `GAUGELINE_GITHUB_TOKEN` | `GET https://api.github.com/rate_limit`                                                                      | The `GitHub-Authentication-Token-Expiration` response header, nothing from the body |
| `GAUGELINE_VERCEL_TOKEN` | `GET https://api.vercel.com/v5/user/tokens/current`, and `GET /v9/projects/<name>` for each project you list | `expiresAt`, and each project's `nodeVersion`                                       |

The names are specific to Gaugeline on purpose, so a deploy token that a CI job already holds is never
picked up by accident. A token whose provider reports no expiry is listed once as "no expiry reported",
never as a finding.

**The narrowest key.** GitHub: a fine-grained personal access token with the fewest permissions you can
pick and no repositories is enough, because `/rate_limit` needs no scope. Vercel has no read-only token
type: a token acts as the account that made it. Make it on a team member with the narrowest role you
have, scoped to the one team, with an expiry, and treat it as a key to that team. If you would rather not
hold one, leave `GAUGELINE_VERCEL_TOKEN` unset: the domain and certificate checks need no key.

The endpoints on this page were written from memory: the GitHub and Vercel documentation could not be
reached when it was written, and no line of theirs is quoted. If an answer differs, the provider's
reference is right and this page is not; the checks say "could not be checked" when an answer has no
date, and never guess one.

`runtime-deprecated` compares each listed Vercel project's Node.js version with
`packages/core/src/data/vercel-node-runtimes.json`. Each entry has the major version, the day Vercel
retires it and the page that announces it. The list is dated, and each entry says whether someone has
compared it with its source (`verified`); the first entries have not been, so confirm a date on
Vercel's own Node.js versions page before you tell a client about it. A version that is not on the list
has no announced retirement and is not a finding.

## In the nightly run

`--renewals` adds these checks to any page check, so they join the nightly run, and `gaugeline run --all
--renewals` does it for every site in `gaugeline.sites.json`:

```yaml
- name: Check every site
  run: npx --yes gaugeline run --all --renewals
```

The tokens come from secrets, by site prefix like the other keys ([Many sites](many-sites.md)). The
HTML report and the [weekly digest](weekly-digest.md) each get one "Renewals" section, sorted by date,
with the date written out; the same findings still appear in the lists they belong to in the report.
`--json` stays at schema 2 and carries the findings and "could not check" entries, not the list.

## Settings

`gaugeline.renewals.json`, read from the folder you run from. Every field is optional.

| Field             | What it does                                                                              |
| ----------------- | ----------------------------------------------------------------------------------------- |
| `domain`          | The registered name, when it is not the host's last two (or three) labels                 |
| `vercel.projects` | Vercel project names whose Node.js version is read (1 to 20)                              |
| `vercel.teamId`   | The team they belong to (`team_` and letters or digits); leave out for a personal account |

What is requested, and from where, is on [Privacy and safety](../privacy.md#renewals-gaugeline-renewals).
