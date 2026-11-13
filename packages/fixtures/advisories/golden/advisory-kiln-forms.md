# kiln-forms: denial of service when parsing nested form fields

GHSA-m4h7-9p2x-c8hq

Source: https://advisories.example.org/GHSA-m4h7-9p2x-c8hq

| Package          | Affected versions | Patched versions |
| ---------------- | ----------------- | ---------------- |
| kiln-forms (npm) | >= 2.0.0, < 2.4.3 | 2.4.3            |

A request with deeply nested field names makes the parser use all of its memory.
