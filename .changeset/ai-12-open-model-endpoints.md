---
"gaugeline": minor
---

New probing check `ai-endpoint-open`: asks the routes you list under `modelEndpoints` in `gaugeline.ai.json` (one GET each, never a POST) and finds one that lists its models or replies with no login, or that shows the provider's error text; it runs only with `--owner-consent`.
