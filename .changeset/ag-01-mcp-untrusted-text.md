---
"gaugeline-mcp": patch
"gaugeline": patch
---

Text from a checked site is now handled one way in every MCP tool result: it comes only in a labelled slot, with hidden and invisible characters shown as escapes, a visible cut at its length cap, and nothing from the page in an error message. The result shape is unchanged apart from two additions (`_meta["gaugeline/untrustedSlots"]` and `linesTotal` on a plan finding that covers more than 50 rows), so this is a patch.
