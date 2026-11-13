# Hosted: findings in your Slack and Sentry

The hosted version of Gaugeline (in progress, not released) can send what a night's run found to the
places your team already looks: a Slack channel, or a Sentry project. A finding in a place nobody checks
is a finding nobody fixes.

## An example: a cocktail bar's broken menu link

Northgate Studio looks after The Tidewater Bar's site. They want a message in `#tidewater` when
something new breaks overnight, but not at 3 a.m. They add a Slack channel (an incoming webhook from
their own Slack workspace) and one rule: the Tidewater site, findings of "Fix this first" only, only what
changed since last night, quiet from 22:00 to 07:00 in the site's own time zone.

The night's run finds a broken link. At 07:00 London time the channel gets one message. This is the
message the worker builds, from `@gaugeline/core` (run with `node --import tsx example.mts` in
`apps/hosted`). The page's own text is data: the `<!channel>` the page wrote is shown, and pings nobody.

```ts
import { checkDestination, slackChangesPayload } from "@gaugeline/core";

const message = slackChangesPayload(
  {
    site: "The Tidewater Bar",
    siteUrl: "https://tidewater-bar.test",
    opened: [
      {
        checkId: "broken-links",
        severity: "high",
        title: "Broken link on the menu page <!channel>",
        evidence: "/menu links to /drinks-2025 (404)",
        url: "https://tidewater-bar.test/menu",
        fingerprint: "0123456789abcdef",
      },
    ],
    closed: 2,
    stillOpen: 1,
  },
  "https://app.example/sites/a1",
);
console.log(JSON.stringify(message, null, 2));
console.log(checkDestination("slack", "https://hooks.slack.com.evil.test/services/T0/B0/x"));
```

```text
{
  "text": "Gaugeline: The Tidewater Bar has 1 new finding, 2 fixed",
  "blocks": [
    {
      "type": "section",
      "text": {
        "type": "mrkdwn",
        "text": "*Gaugeline: The Tidewater Bar has 1 new finding, 2 fixed*"
      }
    },
    {
      "type": "section",
      "text": {
        "type": "mrkdwn",
        "text": "*Fix this first:* Broken link on the menu page &lt;!channel&gt;\n`/menu links to /drinks-2025 (404)`\n`https://tidewater-bar.test/menu`"
      }
    },
    {
      "type": "context",
      "text": {
        "type": "mrkdwn",
        "text": "1 still open · <https://app.example/sites/a1|Open in Gaugeline>"
      }
    }
  ]
}
{ ok: false, error: 'a Slack webhook must be on hooks.slack.com' }
```

## Destinations

| Destination | What you give us                                                         | What it does                                                                                                                                                                 |
| ----------- | ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Slack       | An incoming webhook URL (`https://hooks.slack.com/services/...`)         | One message per site per night: the new findings (the ten most urgent), each with its sentence, evidence and page, then how many were fixed.                                 |
| Sentry      | The project's DSN (`https://<key>@o<number>.ingest.sentry.io/<project>`) | One event per new finding, grouped by the finding's fingerprint: one finding is one Sentry issue for its whole life, and a finding that comes back regresses the same issue. |
| GitHub      | Not yet (v1.1)                                                           | Opening and closing an issue needs a token with write rights to your repository. The hosted service holds no write credentials to your systems (ADR-0010).                   |

An incoming webhook can post but cannot edit a message, and a DSN can send events but cannot resolve an
issue. So a fix is reported in the next night's message (Slack), and in Sentry you resolve the issue
yourself (Sentry reopens it as a regression if the finding comes back).

## Rules

Each rule ties a channel to a site (or every site) and says:

- the lowest severity to send (default: "Fix this first" only);
- optionally, which checks;
- only what changed since last night (the default), or everything open, every night;
- quiet hours, in the site's own time zone: a message due inside them waits until they end. A zone
  name the worker's runtime does not know (Postgres also lists names such as `Factory`) is read as UTC.

Staff of the organisation can read rules; owners and admins can change them. A client viewer sees none.

## Your webhook address is a secret

Anyone holding a Slack webhook URL can post into that channel. The address goes to Supabase Vault
through the worker's SecretStore ([where secrets live](./secrets.md)); the tables keep only a name, the
host and your label. What the app shows of a channel is its kind, host and label ("Slack ·
hooks.slack.com · #tidewater"), never the address.
It is not in any log, error, delivery record or page sent to the browser.

The address is checked when you save it and again before every send: https, the vendor's own host
exactly (`hooks.slack.com`, `o<number>.ingest.sentry.io`), no user name or password in the address sent
to, no port, and the address it resolves to must be a public one.

## Delivery, retries and the log

The night's run queues one delivery per matching channel in the same transaction that stores the run,
inside a savepoint: if queueing fails, only the notifications are lost (the log shows `queue-failed`), never
the night's run. A failed send is tried three times (waiting 5 and then 30 seconds). The delivery log keeps
the time, the outcome, the number of findings, the HTTP status and a short code (`http-503`, `timeout`,
`address-refused`, `secret-unavailable`, `interrupted`), never the address or the message.

Delivery is **at most once**. The worker records that a send has started before the first request goes
out. If a worker stops while it holds a delivery, another worker takes it back after 30 minutes: a
delivery whose send had not started is sent; one whose send had started is marked `interrupted` and not
sent again, because Slack or Sentry may already have it, and a duplicate message is worse than a gap the
log shows. When the secret store does not answer (`secret-unavailable`), the delivery waits 15 minutes and
tries again, for up to a day; that is not the channel's fault, so it does not count against the channel.

A channel is turned off, with the reason shown, when Slack or Sentry refuses it outright (the webhook was
revoked: `rejected`) or after three deliveries in a row fail (`failed-repeatedly`). **Send test message**
posts a short message now; when it gets through, the channel is turned back on.

## Needs from the owner before launch

- Nothing to create for this feature: each customer creates their own Slack incoming webhook (in their
  Slack workspace) or copies their Sentry project's DSN. We create no Slack app and no Sentry account.
- The worker needs `GAUGELINE_SECRET_STORE=vault` (V-01), and its login must be granted `gaugeline_worker`
  with SET (the default), the role able to execute `private.get_secret`: the worker checks both at start-up
  and refuses to start otherwise.
  `GAUGELINE_APP_URL` adds the "Open in Gaugeline" link.
