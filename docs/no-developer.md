# When you don't have a developer

Your developer moved on, or is busy. Here's how to find out what's wrong and hand it to whoever comes next.

You don't need to understand any of this to use it. One command reads your live website and writes a work order in plain English. Nothing on the site changes.

```sh title=Terminal untested="Converted with a fixture in this page's own branch."
$ npx gaugeline brief yoursite.com --business "The Corner Bar" --rate 110 --out work-order.md
```

## What the work order contains

- How many items are worth paying to fix, and how big each one is
- Each item: what's wrong, why it matters, and what "done" looks like
- The evidence, so a developer can start without re-diagnosing it
- What changes the estimate, so nobody quotes blind

## Why it doesn't give you hours

Two developers quote the same fix differently, and both can be right: one link built in a shared component is minutes, the same link hardcoded in twelve places is an afternoon. So the work order sizes each item instead — Small (1 point), Medium (3), Large (8) — and leaves the conversion to whoever is quoting.

| Size   | Points | Means                                                                                   |
| ------ | ------ | --------------------------------------------------------------------------------------- |
| Small  | 1      | A contained change in one place, with an obvious way to confirm it                      |
| Medium | 3      | Touches a component, a setting or a third-party system, and needs checking across pages |
| Large  | 8      | Changes something shared, or needs a decision or content from someone else first        |

```sh title=Terminal untested="Converted with a fixture in this page's own branch."
$ npx gaugeline brief yoursite.com --hours-per-point 1.5 --rate 110

At 1.5 hours per point, that's roughly 13–21 hours (about $1,452–$2,360 at $110/hour).
```

::: info
To find your own number: take an item you've already done, divide the hours it actually took by its points, and use that. It gets more accurate every time you check it against what really happened.
:::

## How to use it

1. Run the command, or ask anyone technical to run it once.
2. Send the file to a developer, an agency, or three of them for quotes.
3. Ask them to re-run the same command when they're done and send you the result.

::: info
The last step is the point: the same check that found the problem proves the fix. You don't have to take anyone's word for it.
:::

- **If you own the site:** This is the page for you. It turns "something feels wrong with the website" into a list with prices attached.
- **If you run marketing:** Useful for scoping: you can see whether a problem is an afternoon or a project before asking for budget.
- **If you edit content:** If you publish content and nobody maintains the site, run this monthly and send it on.
- **If you build the site:** `gaugeline brief` is also an MCP tool, so an assistant can produce the work order and you can edit it before it goes out.

## What it can't tell you

It reads what's public. It can't see your hosting bill, your contracts, or anything behind a password, and the effort ranges are estimates from similar work rather than a quote. Treat them as a starting point for the conversation.
