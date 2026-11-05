# Why not just use Playwright?

The honest answer: use both. They check different things, and one of them makes you write the checks yourself.

Playwright is a browser you can drive. It's excellent, and Gaugeline's own browser-based checks will use it. But a test framework gives you the machinery, not the checks: every assertion is one you write, review and maintain.

## What the equivalent test looks like

Here's one Gaugeline check, the canonical pointing at a different page, written by hand:

```ts title=canonical.spec.ts
test("canonical points at this page", async ({ page, baseURL }) => {
  const res = await page.goto("/macro-calculator");
  const canonical = await page.locator("link[rel=canonical]").getAttribute("href");
  const here = new URL("/macro-calculator", baseURL).toString();
  expect(normalise(canonical)).toBe(normalise(here));
});

// then: trailing slashes, www vs bare, query strings, uppercase hosts,
// pages that legitimately point elsewhere, and the same again for og:url
```

That's one check on one page. Gaugeline ships 70, each with the edge cases already argued out, plus a plain-English explanation an editor or a client can read.

## Four things a test suite can't reach

| The problem                             | Why tests miss it                                                           |
| --------------------------------------- | --------------------------------------------------------------------------- |
| A price changes in Stripe               | No code changed, so nothing ran. Your test suite is asleep.                 |
| An editor publishes a draft link        | Same: content changed, not code.                                            |
| No DMARC record on the domain           | That's DNS. A browser can't read it.                                        |
| An audit says your pages return no HTML | Needs a request with the framework's prefetch header, and a look at `Vary`. |

## Where each one belongs

| Question                                                  | The right tool                          |
| --------------------------------------------------------- | --------------------------------------- |
| Does checkout still work end to end?                      | **Playwright.** Flows, clicks, state.   |
| Did my component break at tablet width?                   | **Playwright**, with visual comparison. |
| Does the live page agree with Stripe, Shopify and Sanity? | **Gaugeline.**                          |
| Did the thing an editor published actually land?          | **Gaugeline.**                          |
| Is my code correct?                                       | **Your unit tests.**                    |

- **If you own the site:** Tests are for your developer's code. This checks the words, prices and links your visitors see.
- **If you run marketing:** Neither a test suite nor an uptime monitor notices a campaign losing its tracking. This does.
- **If you edit content:** You don't need to know what a test is. Gaugeline checks the page after you publish.
- **If you build the site:** Run both. Gaugeline in CI takes one line and covers what your suite structurally can't: changes that arrive without a commit.

## The honest limits

- Gaugeline won't test your business logic, your checkout flow, or your components in isolation. That's your suite's job.
- It reads one page at a time by design; it isn't a full-site crawler like Screaming Frog.
- Every check is a plain rule. If your site does something unusual on purpose, you'll want to ignore that check rather than argue with it.

::: info
A good rule: if a failure can happen without anyone opening a pull request, a test suite won't catch it.
:::
