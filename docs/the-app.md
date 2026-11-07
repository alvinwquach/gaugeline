# Open the app

Run checks from a browser tab on your own computer, the way dbpeek opens a database.

```sh title=Terminal untested="gaugeline open runs until Ctrl+C: open.test.ts runs the built bin and checks these two lines."
$ npx gaugeline open
Gaugeline is running at http://localhost:4817/?s=…
It's only reachable from this computer. Press Ctrl+C to stop.
```

The link opens in your browser (not with `--no-open`, and not in CI). If port 4817 is taken, the app
uses the next free one, up to 4826, and the link says which. If all ten are taken, it stops with exit
code 2 and says so.

The address is optional. Run `npx gaugeline open` on its own and enter one in the app. You can check as many pages as you like in one session; each one appears in the sidebar.

## What's in it

| View                                   | Shows                                                                                                           |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Overview                               | Counts by urgency, where to start, what looked right, and how much was checked                                  |
| Problems                               | Every finding, filterable. Open one for why it matters, how to fix it, and a copy-ready note for your developer |
| Pages checked                          | Every address the check tested, and what it answered                                                            |
| Search data                            | The title, canonical, readable words and structured data the page declares                                      |
| Leaks & access                         | Whether the Sanity dataset is public, which types it holds, JavaScript scanned for keys, and staging copies     |
| Page cost, Automatic messages, Content | Need your Sanity login. Coming in version 0.2                                                                   |

## Private to your computer

- The app listens on 127.0.0.1 only, so nothing else on your network can reach it.
- The link in your terminal carries a one-time key, made new each time and printed only there. Without
  it, every request is refused. The link works once: opening it swaps the key for a session cookie
  and takes the key out of the address bar. To open the app in another browser or a private window,
  restart `gaugeline open`.
- Requests that claim to come from another website are refused, so a page open in another tab can't
  drive it: the app answers only to `localhost` and `127.0.0.1` on its own port (which also stops a
  hostile name that resolves to your computer), and refuses any other Origin and any cross-site
  request.
- Press Ctrl+C and it's gone: the port is closed, open connections end, and nothing is saved.

::: info
Want to see it first? [Open the live demo](https://claude.ai/artifact/MwQmr83pa7xZdkAKvGBcNH) with example results.
:::
