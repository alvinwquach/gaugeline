---
"gaugeline-mcp": patch
---

Probing checks over MCP now run only when you start the server with `--allow-probing` and `--probing-origin` for the site; the `ownerConsent` argument an assistant could pass is ignored, so a page that tells an assistant to turn them on gets nothing.
