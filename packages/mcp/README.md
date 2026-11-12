# gaugeline-mcp

Gaugeline as an MCP server. An AI assistant can check a site, list and explain checks, compare runs and draft a fix as text. It is read-only: it never writes, publishes, merges or changes a site, and it has no tool that approves anything.

```sh
npx gaugeline-mcp            # stdio, for an assistant that starts the server
npx gaugeline-mcp --http     # streamable HTTP on 127.0.0.1:7433/mcp
```

Docs: the MCP server page at https://github.com/alvinwquach/gaugeline/blob/main/docs/mcp.md
