# JSON output reference

`gaugeline <address> --json` prints one JSON object. Its shape carries a schema number; the number
only changes with a new published schema file.

Default schema number: `2` (`RESULT_SCHEMA_VERSION` in `@gaugeline/core`). The full schema is
[`packages/core/schema/result.v2.json`](../../packages/core/schema/result.v2.json); see [Options → JSON output](../options.md#json-output).
Schema 3 is opt-in with `--json-schema 3` (see below); schema 1 is still published as `result.v1.json` and is no longer printed.

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

## Schema 3: what suppressions hide

`gaugeline <address> --json --json-schema 3` prints schema 3 (`RESULT_SCHEMA_VERSION_3`, published as
[`result.v3.json`](../../packages/core/schema/result.v3.json)): every field of schema 2 with `schema` set to
`3`, and four lists that are always present, empty when nothing was hidden. The default stays schema 2, which never
gains a field, so choosing 3 is always a decision of whoever reads the JSON.

| Field                   | Type                            | Meaning                                                                                          |
| ----------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------ |
| `suppressed`            | `{ finding, by }[]`             | Findings an active suppression hid. `by` is the entry that did it                                |
| `expiredSuppressions`   | `{ id, url?, until, reason }[]` | Entries past their `until` date (the last day, UTC), whether or not their finding is still there |
| `unmatchedSuppressions` | `{ id, url?, until, reason }[]` | Active entries that matched no finding: a mistyped id, or a problem that is fixed                |
| `baselined`             | `Finding[]`                     | Findings the `--baseline` file already knew, left out of `findings`                              |

`--json-schema` accepts `2` or `3`; anything else is exit 2 with the accepted numbers. It needs `--json` (or
`--format json`). A runnable example with its output is in
[Config, baselines and suppressions](../config.md#seeing-what-was-hidden-in-json).

## Not in this file

The request log and the page's data are not part of `--json`. With `--save-requests <file>` they are
written to a separate file with its own `schemaVersion` and its own schema,
`packages/core/schema/requests.v2.json` (version 2 adds the read-only queries of ADR-0006: a request of kind `query`, method `POST`, with the id of the allowlist entry that allowed it; a version 1 file, published as `requests.v1.json`, is still read); see
[Privacy and safety](../privacy.md#saving-the-requests-save-requests).

## The work order is its own document

`buildBrief` in `@gaugeline/core` returns the work order as data (the same items `gaugeline brief` writes as Markdown). It has its own `schemaVersion` and its own schema, `packages/core/schema/brief.v1.json`, and changing it never changes the `--json` result. See [Use the work order from code](../no-developer.md#use-the-work-order-from-code).

## The advisory answer is its own document

`gaugeline advisory --json` prints the answer to "is my client affected?" ([Advisory check](../guides/advisory.md)): the verdict, the evidence lines, what to check inside and what could not be read. It has its own `schemaVersion` (`1`) and its own schema, `packages/core/schema/advisory.v1.json`, and changing it never changes the `--json` result of a page check, which stays at `"schema": 2`.
