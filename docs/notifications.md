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
