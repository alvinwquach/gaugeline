# Running a check

```bash
npx gaugeline example.com
```

## How Gaugeline asks for pages

Gaugeline is polite to the site it checks:

- **Read-only.** Every request is a `GET` or a `HEAD`. Anything else is refused in code before it is
  sent (`assertReadOnly` in `packages/core/src/fetcher.ts`, the only module that touches the network).
- **Five at a time.** At most five requests are in flight at once. The rest wait their turn in the
  order they were asked for.
- **A named user agent.** Requests say who they are: `Gaugeline/0.1 (read-only site check)`.
- **Once per address.** The same address is requested once per run, however many checks need it.
- **Every redirect hop is kept.** Redirects are followed one at a time (up to 10), so checks can see
  a 302 where a 301 belongs, or a chain that takes three hops. A loop is stopped, not followed.
- **A size cap.** A page body is read up to 5 MB. Anything past that is cut and marked as cut.
- **A time limit.** A server that does not answer within 10 seconds is reported as not answering;
  the rest of the run carries on.

## https first

If you type a bare domain (`example.com`), Gaugeline tries `https://example.com/` first. Only if the
secure address does not answer at all does it try `http://example.com/`, and the result says that it
did. An address you type with `https://` is never downgraded.
