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

## Agent messages: a place in the outbox (not sent yet)

An [agent](../agent-safety.md) can build a message for the people who run a site: the
regression watcher's alert (row AG-13) when a night's run got worse than the one before, and
the [pending-approvals digest](../approvals-digest.md) of what waits for a decision. **Today** the outbox has a
place for them (migration `0017_agent_message_outbox.sql`). **Not built:** nothing queues or sends one yet.
A later row adds the worker step, and it sends through the sender this page already describes: one message
to your own Slack channel, to the address you saved, and nowhere else.

What the database holds for one:

- A delivery of kind `agent` says **which** message (`agent_kind`: `regression-alert` or `approvals-digest`)
  and **what it is about**: the run an alert is for (`subject_run_id`, with its site), or the local day a
  digest is for (`digest_date`). It holds **no words**. As for a night's findings, the worker builds the
  message when it sends, from your organisation's own rows, so no column can hold an address or a message.
- A channel takes agent messages only when you turn it on (`agent_messages`, off by default), and only a
  Slack channel can: a Sentry project takes events, not messages. The database checks it when the row is
  queued, not only the worker: a row for a channel that is off, disabled or not Slack is refused.
- A row is queued untouched and only moves forward (queued, sending, sent or failed; a claimed row may go back to
  queued for a retry), and a channel never has more than three digests waiting (in each of two groups: the days around today, and the rest).
- One row per channel and per run (an alert), or per channel and per day (a digest): queueing it twice is one
  row.
- The same people read it as read the rest of the log (staff of the organisation, not a client viewer), and
  only the worker's role writes it. An agent has no privilege on it: an agent returns text, and the worker
  queues it.
- A row cannot point at another organisation's channel, run or site: the database refuses it.

The database refuses a row for a channel that does not take agent messages, so the channel is turned on first.
The worker then queues an alert for the night's run. This is the row, as
the seeded test database (`apps/hosted/db/__tests__/harness.ts` and migrations up to
`0017_agent_message_outbox.sql`) returns it:

```sql
update public.notification_channels set agent_messages = true
where id = 'ca000000-0000-4000-8000-0000000000a1';

insert into public.notification_deliveries (org_id, channel_id, kind, site_id, agent_kind, subject_run_id, findings)
values ('0a000000-0000-4000-8000-00000000000a', 'ca000000-0000-4000-8000-0000000000a1', 'agent',
        'a1000000-0000-4000-8000-0000000000a1', 'regression-alert', 'a1a10000-0000-4000-8000-0000000000a1', 2)
returning kind, agent_kind, status, findings
```

```json title=Output
[
  {
    "kind": "agent",
    "agent_kind": "regression-alert",
    "status": "queued",
    "findings": 2
  }
]
```

A test runs this statement and fails if the output shown here differs from what the database returns.

## Needs from the owner before launch

- Nothing to create for this feature: each customer creates their own Slack incoming webhook (in their
  Slack workspace) or copies their Sentry project's DSN. We create no Slack app and no Sentry account.
- The worker needs `GAUGELINE_SECRET_STORE=vault` (V-01), and its login must be granted `gaugeline_worker`
  with SET (the default), the role able to execute `private.get_secret`: the worker checks both at start-up
  and refuses to start otherwise.
  `GAUGELINE_APP_URL` adds the "Open in Gaugeline" link.
