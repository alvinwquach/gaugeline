---
"gaugeline": minor
---

`gaugeline platform` now reads a Supabase project named in `gaugeline.platforms.json`, through Supabase's own MCP server in read-only mode, and reports a public table with row-level security off and the problems Supabase's security advisor raises.
