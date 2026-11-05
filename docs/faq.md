# FAQ

Common questions.

### I already have tests. Why would I use this?

Tests check your code and run when code changes. Most website mistakes come from content changes, like an editor publishing or a price changing in Stripe. No code changed, so no test runs.

### Does it work with WordPress, Webflow or Wix?

The site check works on any website. The Sanity plugin needs Sanity.

### Does it use AI?

Not to find problems. Checks are plain rules, so the same site gets the same answer every time.

### How much does it cost?

Nothing. It's free and open source under the MIT license.

Why checks never call a model, and what enforces it: [ADR-0002 Plain rules, no model calls](https://github.com/alvinwquach/gaugeline/blob/main/docs/adr/0002-plain-rules-no-model-calls.md).
