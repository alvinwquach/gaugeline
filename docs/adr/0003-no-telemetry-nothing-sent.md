# ADR-0003: No telemetry, nothing sent

Status: accepted Date: 2026-11-05

## Context

The Security page says "Results stay there. There's no account, and nothing is sent to us." and the
Privacy and safety page says "Nothing is sent to us." Gaugeline runs on developers' machines and in
CI, often next to secrets. A single analytics ping or update check would make both sentences false,
and would be a request to a host the user never named.

## Decision

The CLI and the app make no request to any host the user did not name, apart from destinations the
user configures (Slack, Discord, email, a webhook). There are no usage counts, no crash reports and
no update check, and nothing is written to the user's home directory to identify the machine.

## Alternatives

- **Opt-in telemetry.** Lost because the code path would exist, could be switched on by mistake or by
  a default changed later, and would have to be audited forever.
- **An update notifier.** Lost because it is a request to a registry on every run that the user did
  not ask for, and `npx` already fetches the latest version.

## Cost

We will not know how many people run Gaugeline, which checks fire most, or how often it crashes.
Priorities have to come from issues, conversations and our own use of it.

## What would change it

Nothing short of a separate, explicit, opt-in product (for example the hosted version) that users
sign up for knowingly. The CLI itself stays silent.

## Enforced by

- `packages/cli/src/__tests__/no-phone-home.test.ts` (a run with every outbound connection
  recorded contacts only the checked site and configured destinations)
