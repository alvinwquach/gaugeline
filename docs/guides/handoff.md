# Handoff: who owns what, and can the client get in without you

When a client cannot get into their own domain, hosting or content studio without you, that is a risk
for both of you. A lockout like that can take days to undo when nobody knows who holds the admin
account. `gaugeline handoff` reads who holds each part of a client's site and writes a report the
client can keep: HTML and Markdown to read, and a JSON summary, with a checklist at the end of what
they own, what to add themselves to and what to ask you for.

It only looks. It never logs in, adds or removes a person, transfers, renews or changes anything, and
the only requests are `GET` and `HEAD`. It uses what you already have: public records and the tokens
you already hold. It never asks the client for a password, and the report holds no password, token or
recovery code, only the **names** of accounts and where to find them.

```sh
npx gaugeline handoff marlowe-bar.com
```

## What it reads

| System                  | What it says                                                        | Where it comes from                                                                                      | Key                                 |
| ----------------------- | ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| Domain                  | The registrar, and whether the registry shows the registrant        | The registry's public RDAP record, as in [Renewals](renewals.md). Never WHOIS                            | None                                |
| DNS                     | Whose name servers answer for the domain                            | The same RDAP record, or live NS records with `--dns`                                                    | None                                |
| Vercel                  | The team or personal account that owns the project, and its members | `GET /v9/projects/<name>`, then `/v2/teams/<id>` and `/v3/teams/<id>/members`, or `/v2/user` if personal | `GAUGELINE_VERCEL_TOKEN`            |
| Sanity                  | The project's members, with their roles and addresses               | `GET /v2021-06-07/projects/<id>`, then `/projects/<id>/users/<ids>` on `api.sanity.io`                   | `SANITY_TOKEN`, `SANITY_PROJECT_ID` |
| Google Business Profile | The location's administrators                                       | `GET /v1/locations/<id>/admins` on `mybusinessaccountmanagement.googleapis.com`                          | `GOOGLE_BUSINESS_PROFILE_TOKEN`     |
| Stripe, Square, others  | Nothing: a line on the checklist                                    | Their APIs do not give Gaugeline a read of who can sign in                                               | None                                |

Everything that is not exposed, or that a token is not allowed to read, is "could not be checked" for
that system alone, with the reason. Gaugeline does not guess, and it does not read an admin page or a
provider's web page. Where a platform's API offers no read of a site's contributors, the system is
a checklist line: a guessed "you're fine" is worse than an honest "check this yourself".

The same goes for backups: where the page shows a platform whose backup status Gaugeline cannot read (a
hosted builder, WordPress, Shopify), the checklist asks where its backups are kept and when the last one
ran, under "Backups". [Backups](backups.md) reads the ones that can be read.

**The narrowest key.** Vercel has no read-only token type: make the token on a team member with the
narrowest role you have, scoped to the one team, with an expiry, and treat it as a key to that team.
Sanity: a token for the one project, with the lowest role that can list the project's members (if
Sanity refuses it, that system says so and the rest of the report is still made). Google offers no
read-only scope for the Business Profile APIs, so the token you use for [listings](../connectors/listings.md)
can also write: Gaugeline only ever sends a `GET`, and you should treat that token as a key to the
profile. Tokens are read from the environment, sent in a header to that provider only, and never
printed, logged or put in a report or a result.

The endpoints on this page were written from memory: the Vercel, Sanity and Google documentation could
not be reached when it was written, and no line of theirs is quoted. If an answer differs, the
provider's reference is right and this page is not; the report says "could not be checked" when an
answer is not what it expects, and never guesses.

## Example: a bar whose owner is only invited

Marlowe Bar is an invented client: a bar whose site you built on Next.js and Sanity and host on Vercel.
The project is in your studio's Vercel team, the Sanity project is yours to administer, and the owner,
Rosa, holds the bar's Google Business Profile. You name the addresses in `gaugeline.handoff.json`.
Yours are two addresses for one person, so you say so with `sameAs`.

```json title=gaugeline.handoff.json
{
  "clientEmails": ["rosa@marlowe-bar.example"],
  "freelancerEmails": [
    "dev@harbour-studio.example",
    "dev.harbour@mail.example",
    "mia@harbour-studio.example"
  ],
  "sameAs": [["dev@harbour-studio.example", "dev.harbour@mail.example"]],
  "vercel": { "project": "marlowe-bar-site", "teamId": "team_harbour01" },
  "sanity": { "projectId": "abc123xy" }
}
```

The Google location comes from the file the [listings](../connectors/listings.md) checks already use:

```json title=gaugeline.listings.json
{ "google": { "location": "locations/1234567890" } }
```

```sh title=Terminal untested="Runs the built command against recorded responses for an invented bar. packages/cli/src/__tests__/handoff-docs.test.ts runs it (the docs runner points commands at a fixture site, and this one reads a registry and three provider APIs) and compares the output with the block below."
$ npx gaugeline handoff marlowe-bar.com
```

```text title=Output
Who owns what for marlowe-bar.com
Domain registration      marlowe-bar.com is registered at Plume Registrar, Inc. The registry hides the registrant, so whose account it is shows only by logging in at the registrar.
DNS                      Name servers belong to Cloudflare (ada.ns.cloudflare.com, bob.ns.cloudflare.com). The account holder is not public.
Vercel                   Project marlowe-bar-site, in the team "Harbour Studio". Owners and admins: d***@harbour-studio.example (owner). The client has been invited and has not accepted.
Sanity                   Project Marlowe Bar. Owners and admins: d***@mail.example (admin). The client is a member, not an owner.
Google Business Profile  Location locations/1234567890. Owners and admins: r***@marlowe-bar.example (owner). The client is an owner or admin.
Stripe                   The site uses it. Gaugeline has no read of who can sign in to a Stripe account, so this is a line to check by hand, never a finding.

✗ The client is not an owner or admin of a system their site depends on
    Vercel project marlowe-bar-site (team "Harbour Studio"): the owners and admins are d***@harbour-studio.example (owner); r***@marlowe-bar.example was invited, and has not accepted
✗ The client is not an owner or admin of a system their site depends on
    Sanity project Marlowe Bar: the owners and admins are d***@mail.example (admin); r***@marlowe-bar.example is a member
! The freelancer is the only owner or admin of a system the client depends on
    Vercel project marlowe-bar-site (team "Harbour Studio"): the only owner or admin is d***@harbour-studio.example, an address of the freelancer's
! The freelancer is the only owner or admin of a system the client depends on
    Sanity project Marlowe Bar: the only owner or admin is d***@mail.example, an address of the freelancer's

4 to look at, 2 to fix first.
```

It also writes `handoff.html`, `handoff.md` and `handoff.json` into `gaugeline-handoff/`. Read down the
list:

- Rosa owns the Google Business Profile, so that line is fine.
- She has been invited to the Vercel team and has not accepted, so she is not yet an owner. Until she
  is, she cannot get in without you.
- She is an editor in Sanity: she can change the bar's content but not who else can.
- On Vercel and Sanity the only owner or admin is you, under two addresses that `sameAs` counts as one
  person. That is the second finding on each.
- The registry hides who the registrant is, so the report cannot say whose registrar account holds the
  domain. That is on the checklist, as is Stripe, which the page's script shows the bar uses.

The Markdown ends with the checklist for the owner. The links go to each provider's own page for adding
a member:

```md title=handoff.md (the end)
## A checklist for the owner

### What you own

- [ ] Google Business Profile locations/1234567890: you can add and remove people here. Check that the recovery email and phone on the account are yours. [Where to do it](https://support.google.com/business/answer/3403100)

### What to add yourself to

- [ ] Vercel marlowe-bar-site: you have been invited. Accept the invitation in your email, then ask an owner to make you an owner. [Where to do it](https://vercel.com/docs/rbac/managing-team-members)
- [ ] Sanity Marlowe Bar: you are a member, not an owner. Ask a current owner to make you an owner. [Where to do it](https://www.sanity.io/manage/project/abc123xy/members)

### What to ask the person who built the site for

- [ ] Domain registration: registered at Plume Registrar, Inc. Ask whose account it is in, and to be added to it (or to have the domain moved into an account) under your own email, so you can renew it and change where it points.
- [ ] DNS is at Cloudflare. Ask for an invitation to that account under your own email, so you can change where the domain points. [Where to do it](https://developers.cloudflare.com/fundamentals/manage-members/)
- [ ] Stripe: ask to be added as an administrator under your own email. [Where to do it](https://dashboard.stripe.com/settings/team)

Ask to be added under your own email address. Never accept a password, a token or a recovery code in a message: an invitation gives you your own way in, and those do not.
```

Send the client the Markdown or the HTML file, or the whole folder. Nothing in it is secret: addresses
are shown as their first letter and their domain (`r***@marlowe-bar.example`), and the JSON holds no token,
no full address and no provider id.

## Example: a coach who made the account herself

Ana runs Juniper Coaching. She signed up for Vercel with her own address and gave you a token, so the
project is in her personal account. She owns it, so she can get in. A personal account is one person's
login, though: it has no list of members to add anyone to, and the site goes where that login goes.

```json title=gaugeline.handoff.json
{
  "clientEmails": ["ana@juniper-coaching.example"],
  "freelancerEmails": ["dev@harbour-studio.example"],
  "vercel": { "project": "juniper-site" }
}
```

```sh title=Terminal untested="Same as above: packages/cli/src/__tests__/handoff-docs.test.ts runs it against the invented coach."
$ npx gaugeline handoff juniper-coaching.com
```

```text title=Output
Who owns what for juniper-coaching.com
Domain registration      juniper-coaching.com is registered at Harbour Names Ltd. The registry does not list the registrant, so whose account it is shows only by logging in at the registrar.
DNS                      Name servers belong to Vercel (ns1.vercel-dns.com, ns2.vercel-dns.com). The account holder is not public.
Vercel                   Project juniper-site, in a personal account. Owners and admins: a***@juniper-coaching.example (owner). The client is an owner or admin.
Google Business Profile  Listed. Gaugeline reads a Business Profile's administrators only when gaugeline.listings.json names the location, so this is a line to check by hand, never a finding.

! A system the site depends on lives in a personal account
    Vercel project juniper-site is in a personal account, not a team: its owner is a***@juniper-coaching.example

1 to look at, none to fix first.
```

The one finding is medium. The fix is a team that Ana owns, with you added, and the project moved into
it. `client-not-admin` and `single-admin` stay quiet: she is the client and she is the only admin.

## The checks

| Check              | Severity  | What it says                                                                                  |
| ------------------ | --------- | --------------------------------------------------------------------------------------------- |
| `client-not-admin` | Fix first | In a system Gaugeline could read, none of the client's addresses is an owner or admin         |
| `single-admin`     | Fix soon  | The only owner or admin, once your two addresses are counted as one person, is the freelancer |
| `personal-account` | Fix soon  | The project lives in a personal account, not a team or organisation                           |

An invitation that has not been accepted is not a role: the client who was invited as an owner is still
"not an owner" until they accept. A member whose address the provider does not show is left out of the
count and the check says it could not tell, rather than call the client missing. With no `clientEmails`
at all, `client-not-admin` says what to add instead of judging.

Roles are mapped per provider to four words. Vercel: Owner is `owner`; Member, Developer, Security,
Billing and Contributor are `member`; the Viewer roles are `viewer`. Sanity: administrator is `admin`;
editor, developer, contributor and deploy-studio are `member`; viewer is `viewer`; a custom role is
shown as it is and counted as neither. Google: Primary owner and Owner are `owner`; Manager and Site
manager are `member`. Only `owner` and `admin` can let others in.

## Settings

`gaugeline.handoff.json`, read from the folder you run from. Every field is optional.

| Field              | What it does                                                                                                                         |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| `clientEmails`     | The client's own addresses (1 to 20): who should be able to get in                                                                   |
| `freelancerEmails` | Yours and your studio's, so a system only you can open is named as that                                                              |
| `sameAs`           | Groups of addresses that are one person (yours at the studio and at home), counted once                                              |
| `vercel.project`   | The Vercel project to read, as Vercel shows its name                                                                                 |
| `vercel.teamId`    | The team it is in (`team_` and letters or digits); leave out for a personal account                                                  |
| `sanity.projectId` | The Sanity project, when it is not `SANITY_PROJECT_ID`                                                                               |
| `also`             | Systems to put on the checklist although the page does not show them: `stripe`, `square`, `shopify`, `mailchimp`, `google-analytics` |

An address may not be in both `clientEmails` and `freelancerEmails`. Addresses are compared in lower
case and shown only as their first letter and their domain, in the screen output, the three files and
every message.

## Options

| Flag             | What it does                                                                          |
| ---------------- | ------------------------------------------------------------------------------------- |
| `--out <folder>` | Where `handoff.html`, `handoff.md` and `handoff.json` go. Default `gaugeline-handoff` |
| `--force`        | Replace report files that exist. Never a folder or a link                             |
| `--json`         | Print the JSON summary and nothing else. With no `--out` nothing is written           |
| `--dns`          | Read the name servers from DNS as well as from the registry's record                  |
| `--ci`           | Exit 1 when a fix-first finding is found (the client is not an admin somewhere)       |

The folder must be the one you ran the command in or one inside it. It is checked, and a report that is
already there is refused without `--force`, before anything is requested. The three files are written
all together or not at all.

## What it does not do

- It does not read who can sign in to Stripe, Square, Shopify, Mailchimp or Google Analytics: their
  lines are on the checklist, with a link to the provider's page for adding someone.
- It does not read whose account a domain is registered in. The registry's record names the registrar and,
  often, hides the registrant, so that is a line on the checklist too.
- Each content adapter (WordPress, Webflow, Framer, Wix and the others, as they arrive) may offer a
  `members()` read. Where a platform's API offers no read of a site's contributors, or the key cannot
  reach it, that system becomes a checklist line.
- It does not create accounts, send invitations or use a key it was not given. Fixtures in the
  tests and in this guide are invented.

What is requested, and from where, is on [Privacy and safety](../privacy.md#handoff-gaugeline-handoff).
