# Options

```
gaugeline <address> [options]
```

## Exit codes

| Code | Meaning                                                     |
| ---- | ----------------------------------------------------------- |
| 0    | The check ran                                               |
| 1    | `--ci` was set and a "Fix this first" finding was found     |
| 2    | Gaugeline could not run, for example the site didn't answer |

When Gaugeline exits 2 it prints one plain sentence and one thing to try on stderr, and nothing on
stdout. For example:

```
$ npx gaugeline shop.exmaple
shop.exmaple could not be found. Check the spelling.
Try: Type the address the way it appears in a browser, for example example.com.
```

```
$ npx gaugeline http://127.0.0.1:4000
127.0.0.1:4000 refused the connection.
Try: Check the site is running, and the port if you typed one.
```

`--verbose` adds the technical detail after a blank line: the stack and every underlying cause.
Query strings and anything that looks like a key are removed from both forms.

## Flags

| Flag              | Meaning                                                                                                                                     |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `--ci`            | Exit 1 when a "Fix this first" finding is found. Also on when the `CI` environment variable is set (any value except empty, `false` or `0`) |
| `--json`          | Print the result as JSON on stdout, and nothing else (see below)                                                                            |
| `--no-open`       | Do not open anything in a browser. Accepted now; the app arrives later                                                                      |
| `--verbose`       | Show technical detail when something goes wrong                                                                                             |
| `-h`, `--help`    | Show help and exit                                                                                                                          |
| `-v`, `--version` | Print the version and exit                                                                                                                  |

Only "Fix this first" findings fail CI. "Fix soon" and "Worth knowing" never change the exit code.

## Streams and colour

Results go to stdout; progress, warnings and errors go to stderr, so `--json` output can be piped
straight into another program. Colour is used only when stdout is a terminal, and never when
`NO_COLOR` is set. `FORCE_COLOR=1` turns it on for a pipe.

## JSON output

`--json` prints one object on stdout. Its shape is published as a JSON Schema file,
[`packages/core/schema/result.v1.json`](../packages/core/schema/result.v1.json) (draft 2020-12),
that scripts can validate against:

```json
{
  "schema": 1,
  "url": "https://shop.example/",
  "startedAt": "2026-01-02T03:04:05.000Z",
  "findings": [],
  "passed": ["title-missing"],
  "failed": []
}
```

- `passed` and `failed` are check ids. `failed` lists checks that could not execute; the rest of the
  run still reports.
- Unknown keys are not allowed, so a misspelt field fails validation.
- The `schema` number only changes with a new file. `result.v1.json` is never edited in place; a new
  shape ships as `result.v2.json` and the old file stays in the package so consumers can pin.
