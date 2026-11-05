# Options

Every flag the CLI accepts.

| Flag                                           | Does                                                                                                      |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `--ci`                                         | Exits with code 1 if anything is marked “Fix this first”. Also on when the CI environment variable is set |
| `--json`                                       | Prints findings as JSON instead of the terminal summary, and skips the report                             |
| `--no-open`                                    | Writes the report without opening a browser                                                               |
| `--help`                                       | Shows usage                                                                                               |
| `--slack`, `--discord`, `--email`, `--webhook` | Send the results somewhere. See [Send results anywhere](/docs/notifications)                              |
| `--notify-on`, `--report-url`                  | Control when messages are sent, and link to a hosted report                                               |

## Exit codes

| Code | Meaning                                                                       |
| ---- | ----------------------------------------------------------------------------- |
| `0`  | The check ran. Without `--ci`, this is the code even when problems were found |
| `1`  | `--ci` mode, and at least one finding is “Fix this first”                     |
| `2`  | The check couldn't run, for example the site didn't answer                    |

## In this version

What the code in this repository does today. The sections above describe the product as published on the site.

```
gaugeline <address> [options]
```

### Exit codes

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

### Flags

The table below is generated from `packages/cli/src/flags.ts` (`pnpm docs:flags`). Do not edit
between the markers; CI fails when it differs from the flag table.

<!-- flags:start -->

| Flag              | Does                                                                                    | Environment variable | Since |
| ----------------- | --------------------------------------------------------------------------------------- | -------------------- | ----- |
| `--ci`            | Exit 1 when a "Fix this first" finding is found                                         | `CI`                 | 0.1.0 |
| `--json`          | Print the result as JSON on stdout, and nothing else                                    |                      | 0.1.0 |
| `--no-open`       | Do not open anything in a browser                                                       |                      | 0.1.0 |
| `--allow-private` | Allow addresses on this computer or a private network, such as 127.0.0.1 or 192.168.x.x |                      | 0.1.0 |
| `--quiet`         | Print only results and errors                                                           |                      | 0.1.0 |
| `--verbose`       | Show each request, and technical detail when something goes wrong                       |                      | 0.1.0 |
| `-h`, `--help`    | Show this help and exit                                                                 |                      | 0.1.0 |
| `-v`, `--version` | Print the version and exit                                                              |                      | 0.1.0 |

<!-- flags:end -->

Only "Fix this first" findings fail CI. "Fix soon" and "Worth knowing" never change the exit code.

### Streams and colour

Results go to stdout; progress, warnings and errors go to stderr, so `--json` output can be piped
straight into another program. Colour is used only when stdout is a terminal, and never when
`NO_COLOR` is set. `FORCE_COLOR=1` turns it on for a pipe.

`--quiet` and `--verbose` together is refused: "Choose --quiet or --verbose, not both." (exit 2).

### JSON output

`--json` prints one object on stdout. Its shape is published as a JSON Schema file,
[`packages/core/schema/result.v1.json`](https://github.com/alvinwquach/gaugeline/blob/main/packages/core/schema/result.v1.json) (draft 2020-12),
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
