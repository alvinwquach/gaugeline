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
