# Send results anywhere

Get the findings in Slack, Discord, email, or any tool that accepts a webhook.

```sh title=Terminal untested="Converted with a fixture in this page's own branch."
$ GAUGELINE_SLACK_WEBHOOK=https://hooks.slack.com/services/... npx gaugeline yoursite.com
$ GAUGELINE_DISCORD_WEBHOOK=https://discord.com/api/webhooks/... npx gaugeline yoursite.com
$ RESEND_API_KEY=re_... npx gaugeline yoursite.com --email you@yourdomain.com
```

| Channel       | Option or variable                                    | What arrives                                                                               |
| ------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Slack         | `--slack` or `GAUGELINE_SLACK_WEBHOOK`                | A summary with the ten most urgent findings, in plain English                              |
| Discord       | `--discord` or `GAUGELINE_DISCORD_WEBHOOK`            | An embed colored by the worst finding                                                      |
| Email         | `--email` or `GAUGELINE_EMAIL`, with `RESEND_API_KEY` | The full report as the email body. Set `GAUGELINE_EMAIL_FROM` to send from your own domain |
| Anything else | `--webhook` or `GAUGELINE_WEBHOOK`                    | Every finding as JSON, for Microsoft Teams, Zapier or n8n                                  |

## When messages are sent

| --notify-on     | Sends                                   |
| --------------- | --------------------------------------- |
| `any` (default) | Only when something was found           |
| `high`          | Only when something needs fixing first  |
| `always`        | After every check, including clean ones |

## Keep webhook addresses secret

Anyone with a webhook address can post to your channel. Store addresses as CI secrets and pass them as environment variables. Gaugeline never prints them.

::: info
If a message fails to send, the check still finishes and tells you which channel failed. A broken webhook never fails your build.
:::

## In this version

What the code in this repository does today. The sections above describe the product as published
on the site.

Slack, Discord and the webhook work; email arrives in its own branch. Each channel is a flag or an
environment variable, and a flag wins when both are set:

```bash
GAUGELINE_SLACK_WEBHOOK=https://hooks.slack.com/services/... npx gaugeline yoursite.com
```

- **Slack** gets a summary line and the ten most urgent findings, then "and N more". A section longer
  than Slack's limit is cut short with "…", never rejected.
- **Discord** gets one embed coloured by the worst finding (red, amber, grey, or green when there is
  nothing to fix), with up to ten findings as fields.
- **The webhook** gets the run exactly as `--json` prints it, with `X-Gaugeline-Report` set when
  `--report-url` is.

`--report-url` adds a link to a hosted copy of the report in each message. After the run, one line
per channel on stderr says `Sent to Slack.` or `Could not send to Discord: hooks.example answered 500.`;
with `--notify-on high` and nothing to fix first it says `Nothing sent: ...`. Sends run together and
each is reported on its own, and a failed or slow send (it gives up after 10 seconds) never changes
the exit code.

Webhook addresses are secrets. Only their host is ever printed; the path never appears in output,
logs or errors. Prefer the environment variables over flags, so the address stays out of your shell
history and CI logs.

This is the one place Gaugeline sends a `POST`: to your own channels, at your request, from
`packages/core/src/notify/`. Every request to the site being checked still goes through the
read-only fetcher, which refuses anything but `GET` and `HEAD`.
