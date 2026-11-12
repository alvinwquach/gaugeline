# Hosted: the morning email

The hosted version of Gaugeline (in progress, not released) writes to you in the morning only when
something changed. If every site is as it was last night, nothing arrives: nobody should open a
dashboard to find out that nothing happened.

## An example: one night at Northgate Studio

Northgate Studio looks after The Tidewater Bar and Juniper Pop-up Kitchen. Overnight the bar's menu page
gained a broken link, and two problems on the pop-up's booking page were fixed. At 07:00 London time the
owner gets one email, not one per site. This is what the code in `apps/hosted/worker/email/morning.ts`
produces for that night (the link is shortened):

```text title=Email
Subject: New: Broken link on the menu page (The Tidewater Bar)

Overnight, Gaugeline found changes on Northgate Studio's sites.

The Tidewater Bar: 1 new problem (1 to fix first). Start with "Broken link on the menu page".
Juniper Pop-up Kitchen: 2 problems fixed.

Open the dashboard to see each one and how to fix it: https://app.northgate.example/

--
You get this because you look after Northgate Studio on Gaugeline. It only comes when something changed.
Change how often, or stop it: https://app.northgate.example/email/preferences?t=v1.eyJvIjoiMGEw....c2ln
```

There is an HTML version of the same words. It has no images, no styles from elsewhere and no tracking
address: the only two addresses in it are the dashboard and the preference link.

## When it is sent

- **Only when something changed.** A site with a run that opened or closed a finding since your last email
  counts. A quiet night writes nothing, not even a row in the database.
- **From 07:00 in your morning.** The time zone is the one you chose; if you did not, the one most of the
  organisation's sites are in. The step looks every five minutes and sends between 07:00 and 11:00, so a
  worker that was down at 07:00 still sends once. It reads the clock from the zone's own rules, so the days
  clocks go forward or back make no difference.
- **Once a day.** One row per person, organisation and day in `email_sends`; the claim is an insert, so a
  restart or a second worker cannot send a second copy. If the mail service fails, the send is tried again
  after 10 minutes and after 20, and then given up for the day. A worker that died after claiming leaves its
  row as it is: that morning's email is not sent again, and the next one covers everything since the last
  email that was sent (at most three days back).
- **One email for all sites.** Three sites changing on one night is one email with three sentences.
- **A person in two organisations** gets two emails, one for each, with only that organisation's sites.

## Who gets it

| Role          | Default           | Can change it |
| ------------- | ----------------- | ------------- |
| owner, admin  | every change      | yes           |
| member        | off (they opt in) | yes           |
| client viewer | never             | no            |

The choices are **every change**, **fix first only** (a new high-severity finding; fixes alone do not
count) and **off**. Nothing is sent to an address that is missing, unconfirmed, or marked bounced.

## What it may say

Counts, the site's name, the title of the most urgent new finding, and two links. Never the evidence line,
an address from a page, or a key. A finding title and a site name come from outside, so they go through
core's `sanitise` (the same cleaning as every other output: hidden characters, line breaks and direction
marks out, length capped) and are then escaped for HTML. A title with `<script>` or a fake `Bcc:` line comes
out as harmless text.

## The link at the bottom

It opens `/email/preferences?t=...`, a small page with three buttons: every change, fix first only, no
email. The link is signed with a server secret (HMAC-SHA256), names one person in one organisation, and
works for 90 days. It changes that person's email setting and nothing else: it does not sign anyone in and
sets no cookie.

- Opening the link changes nothing. Mail programs and scanners open links, so only the button (a POST that
  carries the signed token) saves a choice.
- The page does not show the address, loads nothing from elsewhere, and is not cached, framed or passed on
  as a referrer, since the address contains the token.
- A bad, expired or tampered link gets "This link does not work" and changes nothing.
- A POST with `List-Unsubscribe=One-Click` (RFC 8058) turns the email off. The email does not yet send the
  `List-Unsubscribe` header that mail programs use to show their own unsubscribe button; that needs a field
  in core's `postEmail` and is left for when the sender domain is set up.

## How it sends

Through core's notifier, `postEmail` in `packages/core/src/notify/email.ts`, the same Resend path as
`gaugeline --email`. No new place sends a request. The key is read from the environment, held by the sender
and sent in the `Authorization` header only; it is never stored, logged or put in a finding.

```bash
RESEND_API_KEY=...                      # the Resend key
GAUGELINE_EMAIL_FROM="Gaugeline <morning@yourdomain.example>"
GAUGELINE_DASHBOARD_URL=https://app.yourdomain.example/
GAUGELINE_APP_URL=https://app.yourdomain.example/   # optional; where the preference page is
GAUGELINE_EMAIL_TOKEN_SECRET=...        # 32 or more random characters
```

Without `RESEND_API_KEY` the step is off and the worker says so once at start-up. With a key but a missing
secret or a non-https address, the worker refuses to start, so a half-finished setup never fails quietly at
07:00.

## Not built yet

The weekly "nothing changed" note, the "weekly only" setting and the short email for a missed night (spec
X64 items 3 and 5) are left for a later row: the first conflicts with "unchanged means no email" until the
owner decides, and the others need the weekly digest. Bounce handling needs Resend's webhook; the
`bounced_at` column is ready for it.
