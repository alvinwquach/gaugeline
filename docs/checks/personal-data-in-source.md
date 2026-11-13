# Visitors' details in analytics and logs

An enquiry form on a clinic's, a coach's or a pub's site collects an email, a phone number and often a message. It is easy to let that data travel further than the inbox it was meant for: a developer adds a line to see whether the form works, or to tell the analytics tool that a lead came in, and the visitor's details go with it.

These two checks read the repository, not the live site.

| Check                        | Finds                                                                                            | Severity       |
| ---------------------------- | ------------------------------------------------------------------------------------------------ | -------------- |
| `personal-data-in-analytics` | An email, a phone number or a form's values given to `dataLayer`, a pixel or an analytics client | Fix this first |
| `form-values-in-logs`        | The same given to a log call or an error report (`console`, a logger, Sentry and the like)       | Fix this first |

They only look. They read the files of a folder you name, through the static pack's reader: it never follows a link out of the folder, skips `node_modules` and `.git`, refuses `.env` files and anything that looks like a key, and caps what it reads. A check makes no request and runs no code. A finding names the file, the line, the call and the name of the field, never the value it found: no email, phone number or form text is printed in the terminal, in JSON, in SARIF or in the report.

**A note on sources.** Documentation checked on: 2026-11-13. No framework or vendor page describes these two patterns, so both checks are **uncited**: the claim that an analytics vendor or a log service is a third party that keeps what it is given is a privacy judgement, and the vendors' own pages (Google, Meta, PostHog, Sentry) could not be reached from the build session. The checks do not state it as fact about any one vendor. Grounded Code was not connected. [docs] sources: none.

## Example: a physio clinic's enquiry form

Birchfield Physio is an invented three-room clinic. A freelancer built its site with Next.js. The enquiry form sends the message to the clinic's inbox with a server action; two lines were added along the way to help with testing and with reporting.

```text title=The folder
components/EnquiryForm.tsx    a client form; after sending, pushes an event to the data layer
app/contact/actions.ts        a server action; logs the submission and the failure
```

```json title="Findings: personal-data-in-analytics"
[
  {
    "checkId": "personal-data-in-analytics",
    "severity": "high",
    "title": "A visitor's email, phone or form values are sent to analytics",
    "evidence": "components/EnquiryForm.tsx: dataLayer.push is given the field \"email\".",
    "url": "source:./birchfield-site",
    "source": {
      "file": "components/EnquiryForm.tsx",
      "line": 18
    }
  }
]
```

```json title="Findings: form-values-in-logs"
[
  {
    "checkId": "form-values-in-logs",
    "severity": "high",
    "title": "A visitor's email, phone or form values are written to a log or an error report",
    "evidence": "app/contact/actions.ts: console.log is given the whole form.",
    "url": "source:./birchfield-site",
    "source": {
      "file": "app/contact/actions.ts",
      "line": 4
    }
  },
  {
    "checkId": "form-values-in-logs",
    "severity": "high",
    "title": "A visitor's email, phone or form values are written to a log or an error report",
    "evidence": "app/contact/actions.ts: console.error is given the field \"email\".",
    "url": "source:./birchfield-site",
    "source": {
      "file": "app/contact/actions.ts",
      "line": 7
    }
  }
]
```

The first finding is the form telling Google Tag Manager the visitor's email and phone number along with the event. The others are the action writing the whole submission to the server log and, when the send fails, the email to the error log. In both places the details end up with someone other than the clinic.

**To fix the analytics call**, push the event and a fact that is not about the person (`enquiry_sent` and the form's name). If a conversion tag needs the email, send it from the server with the visitor's consent, hashed, not from the page. **To fix the log calls**, log what happened and not who it happened to: a status and a count of fields. For an error reporter, leave the form out of its extra data and keep the tool's own scrubbing of personal data on as a second line.

## What each check looks at

A call is found by its name; its arguments are then read for a personal field.

- **Analytics calls:** `dataLayer.push`, `_paq.push`, `gtag`, `fbq`, `ttq.*`, `plausible`, `umami.*`, `posthog.*`, `mixpanel.*`, `amplitude.*`, `analytics.*`, `segment.*`, `heap.*`, `va.*`, `sendGTMEvent` and `sendGAEvent`.
- **Log calls:** `console.log`, `info`, `warn`, `error`, `debug` and `trace`; `logger.*` and `log.*`; and any method of `Sentry`, `Bugsnag`, `Rollbar` and `Honeybadger`.
- **A personal field** is a name whose last word is `email`, `phone`, `mobile`, `telephone`, `tel`, `first_name`, `last_name`, `full_name`, `surname`, `postcode`, `zip`, `dob` and the like (`email`, `userEmail`, `contact_phone`), used as a key with a value that is not a literal, as a variable (`{ email }`, `identify(email)`) or as a member (`values.email`, `formData.get("email")`).
- **The whole form** counts too (`...values`, `Object.fromEntries(formData)`, `request.json()`), but only in a file that handles a form, so a chart's `values` is left alone.
- **Left alone:** a literal (`email: "redacted"`), a value hashed or masked in the same expression, the word inside an event name or a message, a call in a comment and test files.

## What it does not cover

- A value that reaches the call through another function (a helper that logs whatever it is given) is not followed. The call inside the helper is read, with its own arguments.
- A personal field with an unusual name (`contactAddress`, `guest`) is not recognised, and nothing is said about the free-text message field, because a name does not say whether it holds personal details.
- Server logs that your host or framework writes by itself (request logs with a query string) are not source code.
- Whether the visitor consented to the tool is a question for the site's privacy notice, not for these checks.

## When it cannot check

If the folder holds no source file, or a source file was left out (too large, not readable, a link), the checks say they could not check, with that reason. They never say the folder is fine when part of it was not read, and a folder with more files than Gaugeline reads never passes either.

[Every check, with what it catches and how to fix it](/docs/checks)
