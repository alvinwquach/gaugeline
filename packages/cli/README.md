# gaugeline

Check a website the way search engines and visitors see it, and get a plain-English list of what to
fix first. Gaugeline only reads: every request is a `GET` or a `HEAD`, five at a time, and it never
requests addresses on your own computer or network unless you pass `--allow-private`.

```bash
npx gaugeline example.com
```

Requires Node.js 18.17 or newer.

| Exit code | Meaning                                                                  |
| --------- | ------------------------------------------------------------------------ |
| 0         | The check ran                                                            |
| 1         | `--ci` was set (or `CI` is set) and a "Fix this first" finding was found |
| 2         | Gaugeline could not run, for example the site didn't answer              |

`--json` prints a versioned result (schema 1) and nothing else on stdout. Run `gaugeline --help`
for every option.
