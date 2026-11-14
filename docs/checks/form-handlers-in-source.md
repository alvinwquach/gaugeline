# Form handlers that fail quietly or let anyone in

A small business's enquiry form is the part of the site that earns money: a booking request for a private dining room, a clinic's appointment request, a coach's sign-up. Two things go wrong in the code behind it that nobody sees until a customer complains: the form says "sent" when the send failed, and the endpoint takes a post from anything.

These two checks read the repository, not the live site. Gaugeline never submits a form to find out.

| Check                        | Finds                                                                                         | Severity       |
| ---------------------------- | --------------------------------------------------------------------------------------------- | -------------- |
| `form-failure-shows-success` | A handler whose `catch` block returns or shows success after the email or webhook send failed | Fix this first |
| `form-post-unguarded`        | A route handler that takes a form post with no origin check, honeypot or signed token         | Fix soon       |

They only look. They read the files of a folder you name, through the static pack's reader: it never follows a link out of the folder, skips `node_modules` and `.git`, refuses `.env` files and anything that looks like a key, and caps what it reads. A check makes no request and runs no code.

**A note on sources.** Documentation checked on: 2026-11-13. The Next.js documentation site could not be reached when this page was written (the build session's network policy refused it), so the pages below were read as the official Markdown sources in the Next.js repository at the `v16.4.1` tag [docs]: [Data Security](https://raw.githubusercontent.com/vercel/next.js/v16.4.1/docs/01-app/02-guides/data-security.mdx) (lines 544 to 548: Server Actions use POST only, and Next.js compares the `Origin` header with the host the app is served from; `serverActions.allowedOrigins` adds safe hosts) and [route.js](https://raw.githubusercontent.com/vercel/next.js/v16.4.1/docs/01-app/03-api-reference/03-file-conventions/route.mdx) (a Route Handler is a function per HTTP method, and the page describes no origin check). That is why `form-post-unguarded` leaves Server Actions alone and looks at Route Handlers. Everything else is **uncited**: that a visitor is shown success and the lead is lost is the result of the code pattern, not a documented behaviour, and which guards are enough against spam is a judgement. Grounded Code was not connected.

## Example: a pub's private-dining enquiry

Quayside Taproom is an invented pub. Its site, built with Next.js, has a private-dining enquiry form that tells the kitchen's channel, with the form's date and number of guests. The folder has two pieces:

```text title=The folder
app/enquiry/actions.ts        a server action that posts the enquiry to the kitchen channel
app/api/enquiry/route.ts      a route handler that takes the same form from a plain HTML page
```

### A failed send that still says "sent"

```json title="Findings: form-failure-shows-success"
[
  {
    "checkId": "form-failure-shows-success",
    "severity": "high",
    "title": "A form shows 'sent' even when sending the message failed",
    "evidence": "app/enquiry/actions.ts: the send is in a try block, and its catch block reports success.",
    "url": "source:./quayside-site",
    "source": {
      "file": "app/enquiry/actions.ts",
      "line": 10
    }
  }
]
```

The action posts to the kitchen channel inside a `try`. When that fails (the channel's address was rotated, the service is down), the `catch` block returns `{ ok: true }`, so the visitor is told the enquiry went through. It did not. Nobody is told either: the kitchen sees nothing, and the pub learns about the lost booking when the customer phones.

**To fix it**, return an error from the `catch` block that the form shows, with the pub's phone number, and a failing status code for a route handler. Log the failure without the visitor's details. Show "sent" only after the send answered ok.

### A form endpoint that takes a post from anywhere

```json title="Findings: form-post-unguarded"
[
  {
    "checkId": "form-post-unguarded",
    "severity": "medium",
    "title": "A form endpoint accepts posts with no origin check, honeypot or token",
    "evidence": "app/api/enquiry/route.ts: POST reads a submission and has no origin check, honeypot or token.",
    "url": "source:./quayside-site",
    "source": {
      "file": "app/api/enquiry/route.ts",
      "line": 1
    }
  }
]
```

The route handler reads the posted form and passes it on, and nothing checks where the post came from. Any script can fill the kitchen channel with fake enquiries, and another website can make a visitor's browser post to it. **To fix it**, check that the `Origin` header is the pub's own address, add a hidden "honeypot" field that a person never fills in and refuse a post that has it, and add a captcha such as Turnstile if spam continues. Or move the form to a Server Action, where Next.js compares the `Origin` with the site's host for you.

## What each check looks at

- **`form-failure-shows-success`.** A `try` block that sends (`.send(`, `sendMail`, `sendEmail`, `emails.send`, `axios.post`, `.post(`, or `fetch` with `method: "POST"`), whose `catch` block returns or shows success (`ok`, `success`, `sent` or `submitted` set to `true`, a status of `"ok"` or `"success"`, `Response.json({ ok: true })`, a redirect to a thank-you path, `setSent(true)`) and holds nothing that says it failed (a `throw`, `ok: false`, an `error` value, a 4xx or 5xx status, an error state).
- **`form-post-unguarded`.** A `route.ts` handler that exports `POST` (or a Pages Router API route) and reads the submitted body, with none of: a check of the `Origin` or `Referer` header, a honeypot field, a captcha or signed token (Turnstile, reCAPTCHA, hCaptcha, a CSRF token, a nonce, an HMAC or signature check), a session check. Routes named `webhook`, `hooks`, `stripe`, `cron`, `auth`, `callback`, `revalidate`, `trpc` or `graphql` are not forms and are left alone. Server Actions are not looked at.

## What it does not cover

- `form-failure-shows-success` does not follow a `fetch` whose answer is never read. `fetch` does not throw on a 4xx or 5xx answer, so a handler with no `res.ok` check shows success after a failed send with no `catch` at all. Gaugeline does not look for that yet.
- A failure handled somewhere the `catch` block does not show (a wrapper that logs and rethrows, a framework error boundary) is not followed.
- `form-post-unguarded` does not count a rate limit as a guard, and does not know about a guard that lives in a helper it cannot see: a file that calls `getServerSession` or checks a signature somewhere else in its own text is read as guarded.
- Neither check submits a form or runs the code.

## When it cannot check

If the folder holds no source file, or a source file was left out (too large, not readable, a link), the checks say they could not check, with that reason. For `form-post-unguarded` there is one more reason: when a `middleware` or `proxy` file mentions an origin or token check, the guard may live there, so an endpoint with none of its own is reported as could-not-check, not as a finding. A folder with more files than Gaugeline reads never passes either.

[Every check, with what it catches and how to fix it](/docs/checks)
