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

- **Only when something changed or a new draft is waiting.** A site with a run that opened or closed a finding since your last email
  counts. A quiet night writes nothing, not even a row in the database. A new draft in the inbox counts too, see below.
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

## Drafts waiting for you, in the same email

The [pending-approvals digest](../approvals-digest.md) rides in the morning email, so the people who look after
a site get one message, not two. When a draft has arrived in the [inbox](./inbox.md) since your last email, the
email says how many drafts are waiting, how many are older than 24 hours or expire within 24 hours, and lists the
five that need a decision first: the kind, the age, the hours left, the draft's title and a link to it. A morning
with a new draft and no change sends the email with only this part. A morning with no change and no new draft
sends nothing.

- **Only when a draft is new.** "New" means written after the end of the last email sent to you for that
  organisation (the `covers_to` the send log already keeps; the first email counts every draft waiting). The same
  undecided drafts are not sent again every morning: you hear about a draft once, when it arrives. A draft you
  leave undecided is not repeated, so a draft nearing its 72 hours is not reminded about; open the inbox for
  those. This is the rule that needs no new column; sending a reminder as a draft nears expiry would need one.
- **Same rules as the rest.** The same people (owner and admin by default, a member who opted in, never a client
  viewer), the same 07:00 to 11:00 window, the same once a day (the `email_sends` row), the same signed link at
  the bottom to change how often or stop it, the same retries. "Off" gets no digest. "Fix first only" gets it only
  when a new draft is also older than 24 hours or expires within 24 hours, which is rare.
- **What may leave.** Counts, draft titles and links built from your own app address and a draft's id. Never a
  draft's body, its payload, a finding's evidence or a page. A title is an agent's words and may quote a page, so
  it is cleaned and escaped like a finding title. Nothing in the email approves anything.
- **A long list is capped.** At most five drafts are listed; the rest are counted ("and 295 more in the inbox").
- **No model.** Counting and ordering are plain rules, the same code as the Slack digest.

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

One thing the cleaning cannot do: if a page puts a web address in a finding title, it appears as plain
text, and some mail programs turn plain-text addresses into links. Treat an address in a title as
something a page wrote, not something Gaugeline vouches for.

## The link at the bottom

It opens `/email/preferences?t=...`, a small page with three buttons: every change, fix first only, no
email. The link is signed with a server secret (HMAC-SHA256), names one person in one organisation, and
works for 90 days. It changes that person's email setting and nothing else: it does not sign anyone in and
sets no cookie.

- Opening the link changes nothing. Mail programs and scanners open links, so only the button (a POST that
  carries the signed token) saves a choice.
- The page does not show the address, loads nothing from elsewhere, and is not cached, framed or passed on
  as a referrer, since the address contains the token.
- The token is in the address of the page (`?t=...`), so it shows up in the access logs of the host and of
  anything in front of it (a proxy or CDN). Treat those logs as holding working links for up to 90 days.
- A link stays valid for 90 days and cannot be revoked one at a time; the only way to cancel every link at
  once is to change `GAUGELINE_EMAIL_TOKEN_SECRET`. A link whose signature has been respelled (padding,
  extra characters, another base64 alphabet) is refused.
- A bad, expired or tampered link gets "This link does not work" and changes nothing.
- A POST with `List-Unsubscribe=One-Click` (RFC 8058) turns the email off. The email does not yet send the
  `List-Unsubscribe` header that mail programs use to show their own unsubscribe button; that needs a field
  in core's `postEmail` and is left for when the sender domain is set up.

## How it sends

Through core's notifier, `postEmail` in `packages/core/src/notify/email.ts`, the same Resend path as
`gaugeline --email`: one `POST` to `https://api.resend.com/emails` with the key in the `Authorization` header
(see [Resend: send email](https://resend.com/docs/api-reference/emails/send-email) [docs]). The worker's sender
can post only there: the address is a constant in core, no setting changes it, a name that resolves to a private
or loopback address is refused, and a redirect is never followed. Each message carries an `Idempotency-Key`
header (`morning/<organisation>/<person>/<local day>`), so if a request times out after Resend accepted it, the
retry 10 minutes later is not sent a second time. Resend's own Node library names the header that way
([resend on npm](https://www.npmjs.com/package/resend), `idempotencyKey` "sent as the `Idempotency-Key` header", 6.38.1) [docs];
how long Resend remembers a key and what it answers to a changed message under the same key are **uncited**
(the documentation host was not reachable), so a retry whose words differ may be refused by Resend and given up
for the day. No new place sends a request. The key is read from the environment, held by the sender and sent in the header only; it
is never stored, logged or put in a finding.

```bash
RESEND_API_KEY=...                      # the Resend key
GAUGELINE_EMAIL_FROM="Gaugeline <morning@mail.yourdomain.example>"   # an address on a domain verified in Resend
GAUGELINE_DASHBOARD_URL=https://app.yourdomain.example/
GAUGELINE_APP_URL=https://app.yourdomain.example/   # optional; where the preference page and the inbox are
GAUGELINE_EMAIL_TOKEN_SECRET=...        # 32 or more characters, at least 8 different (use a random value)
```

| `RESEND_API_KEY` | `GAUGELINE_EMAIL_FROM`             | What the worker does                                                                  |
| ---------------- | ---------------------------------- | ------------------------------------------------------------------------------------- |
| not set          | any                                | The step is off and the worker says so once at start-up. Nothing is claimed or sent.  |
| set              | not set, or on the placeholder     | Refuses: no request, no row, `sender-domain-not-configured`. The worker says so once. |
| set              | an address on your verified domain | Sends.                                                                                |

With a key but a missing secret or a non-https address, the worker refuses to start, so a half-finished setup
never fails quietly at 07:00.

### Swap the sender domain

Until you set one, every email is from `morning@mail.gaugeline.invalid`. `.invalid` is reserved (RFC 2606): it
cannot be registered, so nothing can be sent from a real domain by accident, and the sender refuses to send from
it. The same refusal covers the placeholder's subdomains, any other `.invalid` name, Resend's shared test domain
(`resend.dev` and everything under it, for example `onboarding@resend.dev`, which delivers only to your own Resend
account, not to a member), a value that is not an address, a domain with anything but ASCII letters, digits,
hyphens and dots (a look-alike letter, a zero-width character), and any control or direction character anywhere
in the value (so a display name cannot add a header). A trailing dot and capital letters are ignored. A refused
morning is not used up: once you swap the domain, that morning's email still goes out.

To swap it, change one value, `GAUGELINE_EMAIL_FROM`, and restart the worker. To have a domain to put there:

1. Create a Resend account and add your domain in its dashboard.
2. Add the DNS records Resend shows you (the SPF and DKIM records) at your DNS host, and wait for Resend to show
   the domain as verified.
3. Create an API key and set `RESEND_API_KEY`.
4. Set `GAUGELINE_EMAIL_FROM` to an address on that domain.

[Resend: managing domains](https://resend.com/docs/dashboard/domains/introduction) [docs]. Those two pages were
not reachable from the session that wrote this page, so the request shape and the verification steps come from
core's own tested sender and are **uncited**: check them against the pages before going live.

### Try it without an account

This runs the real sender against a stand-in for Resend on your own machine (`worker/__tests__/example-digest.ts`):
no key is real and nothing leaves the machine. It builds the email from two invented waiting drafts, then tries
the placeholder sender and a sender on a test domain. Run from `apps/hosted` with
`node --import tsx worker/__tests__/example-digest.ts`:

```text title=Output
Subject: 2 drafts waiting for your approval

2 drafts wait for approval: 1 older than 24 hours, 1 expire within 24 hours.
- email, 70 hours old, 2 hours left: Your menu link is fixed https://app.northgate.example/inbox/a1d20000-0000-4000-8000-000000000001
and 1 more in the inbox: https://app.northgate.example/inbox
Nothing here approves anything: a person decides each draft in the inbox.

Open the dashboard to see each one and how to fix it: https://app.northgate.example/

--
You get this because you look after Northgate Studio on Gaugeline. It only comes when something changed or a draft is waiting for approval.
Change how often, or stop it: https://app.northgate.example/email/preferences?t=v1.eyJvIjoiMGEw....c2ln

sender Gaugeline <morning@mail.gaugeline.invalid>: {"ok":false,"error":"sender-domain-not-configured"}
sender Gaugeline <morning@mail.northgate.example>: {"ok":true,"status":200}
requests the stand-in received: 1
POST /emails from Gaugeline <morning@mail.northgate.example> to owner@northgate.example (authorization: Bearer <key>, idempotency-key: morning/org-1/user-1/2026-11-13)
```

A test runs this same code and fails if this page's output differs from it.

## Not built yet

The weekly "nothing changed" note, the "weekly only" setting and the short email for a missed night (spec
X64 items 3 and 5) are left for a later row: the first conflicts with "unchanged means no email" until the
owner decides, and the others need the weekly digest. Bounce handling needs Resend's webhook; the
`bounced_at` column is ready for it.
