---
"gaugeline-mcp": patch
---

The HTTP server now reads an oversize request to its end (up to 16 MiB) before it answers 413, so a client that is still sending gets the 413 instead of a reset connection on Windows and macOS.
