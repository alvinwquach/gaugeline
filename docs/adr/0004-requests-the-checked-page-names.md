# ADR-0004: Requests to addresses the checked page names

Status: accepted Date: 2026-11-05

## Context

ADR-0003 says the CLI requests no host the user did not name. Some checks can only answer by asking
another host about something the checked page itself publishes: whether the app its App Store link
names still exists (N07), or whether a link in its llms.txt still works (N04). Those hosts were not
typed by the user, but the page named them, and a person reading the page would follow the same
links.

## Decision

A check may request an address the checked page or its own files publish (a link, an llms.txt
entry, the store listing for an app it links to), through the fetcher, GET or HEAD only, within a
published limit. The request carries only what the page published (the address, or the app id it
names, plus the store's language or storefront parameter) and nothing about the user, the machine or
the run. Anything else is still a request to a host nobody named, and ADR-0003 forbids it.

## Alternatives

- **Same-site requests only.** Lost because "the app this page promotes is gone" and "this llms.txt
  link is dead" are the findings, and they cannot be answered from the site alone.
- **Ask the user to list allowed hosts.** Lost because nobody knows in advance which stores or
  documentation hosts their pages link to, and a forgotten entry would silently turn a check off.

## Cost

A run can contact the App Store, Google Play and hosts linked from llms.txt. A user who must not
contact any third party has to skip those checks by id. Each such check carries its own limit
(`appLinks`, `llmsTxtLinks`), published on the Security page.

## What would change it

A request that carries anything beyond what the page published, or a third-party host contacted for
a reason other than a check's finding.

## Enforced by

- `packages/core/src/checks/__tests__/app-store-links.test.ts` (store requests carry only the app id
  and the storefront or language parameter)
- `packages/cli/src/__tests__/no-phone-home.test.ts` (a run contacts only the checked site and
  configured destinations)
