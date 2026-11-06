# JSON output reference

`gaugeline <address> --json` prints one JSON object. Its shape carries a schema number; the number
only changes with a new published schema file.

Current schema number: `1` (`RESULT_SCHEMA_VERSION` in `@gaugeline/core`). The full schema is
[`packages/core/schema/result.v2.json`](../../packages/core/schema/result.v2.json); see [Options → JSON output](../options.md#json-output).

## Finding

| Field      | Type                              | Meaning                                                                   |
| ---------- | --------------------------------- | ------------------------------------------------------------------------- |
| `checkId`  | string                            | Stable, kebab-case id of the check, for example `canonical-elsewhere`     |
| `severity` | `"high"` \| `"medium"` \| `"low"` | Fix this first / Fix soon / Worth knowing                                 |
| `title`    | string                            | Plain English, for whoever owns the site                                  |
| `evidence` | string                            | The technical line, for whoever fixes it. Secret-looking text is redacted |
| `url`      | string                            | The address the evidence is about                                         |
| `source`   | `{ file, line }`, optional        | Set by repository checks                                                  |

```json
{
  "checkId": "canonical-elsewhere",
  "severity": "high",
  "title": "This page tells search engines another page is the real one",
  "evidence": "<link rel=\"canonical\" href=\"https://other.example/\">",
  "url": "https://shop.example/"
}
```
