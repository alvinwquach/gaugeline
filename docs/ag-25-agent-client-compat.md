# Agent clients: what an MCP client needs to connect

Gaugeline's MCP server (`gaugeline-mcp`) speaks the [Model Context Protocol](https://modelcontextprotocol.io/).
This page is for the person wiring it into an MCP client or an agent client of their own: what a client has to
support, what the server sends back, and what to do with it. For the settings snippet of each desktop or editor
client, see [Add the MCP server to your assistant](./mcp-install.md); for what each tool does, see
[the MCP server page](./mcp.md).

## What was checked, and how

Three markers are used on this page, so you can tell a fact from a hope.

- **Verified.** A test in this repository checks it (`packages/mcp/src/__tests__/agent-client-compat.test.ts`),
  using the MCP TypeScript SDK's own client (version 1.32.2) over an in-memory link and over Streamable HTTP, and
  plain HTTP requests. A page edit that makes the claim false fails the test.
- **Read from the code.** Stated from reading `packages/mcp/src/server.ts` or `http.ts`; no test pins it.
- **Unverified.** We did not check it. It is a claim about someone else's software, or about a setup we did not
  run, and you should check it yourself.

**No MCP client from any vendor was run for this page.** The snippets on the install page are started by a test
exactly as a client would start them (the same command and arguments), which proves the server starts from that
snippet; it does not prove what a client does after it connects. Everything below about "a client" is about what
the protocol and this server's own answers say.

## What a client has to support

| Need               | What this server does                                                                                                                                                                                                                                   | Marker             |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| Transport          | stdio (the client starts `npx -y gaugeline-mcp`), or Streamable HTTP on `POST /mcp`                                                                                                                                                                     | Verified           |
| Protocol version   | Any version in the list below. A client that asks for one it lists gets that version; one it does not list gets the latest                                                                                                                              | Verified           |
| Capabilities       | `tools` only: no resources, no prompts. It reports `{"tools":{"listChanged":true}}`                                                                                                                                                                     | Verified           |
| Tool list          | five tools by default (`run_check`, `list_checks`, `explain_finding`, `compare_runs`, `draft_fix`); `plan_check`, `list_pending_approvals` and `read_run_history` are listed only when the operator turns them on (see [the MCP server page](./mcp.md)) | Verified           |
| Tool metadata      | every tool has `readOnlyHint: true`, `destructiveHint: false`, `idempotentHint: true`, and `openWorldHint` true only for tools that request a site                                                                                                      | Verified           |
| A tool's result    | one `text` item whose text is JSON. No `structuredContent`                                                                                                                                                                                              | Verified           |
| A wrong argument   | a result with `isError: true` whose text starts `MCP error -32602`, not a protocol error                                                                                                                                                                | Verified           |
| A refused call     | a result with `isError: true` and one fixed sentence naming the policy's reason ([the agent policy](./mcp.md#the-agent-policy))                                                                                                                         | Documented         |
| Changing tool list | the tool list is decided when the server starts and is not changed while it runs. It reports `listChanged` because the SDK does by default                                                                                                              | Read from the code |
| Node               | version 22 or newer, because the client runs `npx` for you                                                                                                                                                                                              | Documented         |

The protocol versions the server accepts are the ones its SDK lists, latest first:

```text title=Versions
2025-11-25, 2025-06-18, 2025-03-26, 2024-11-05, 2024-10-07
```

**Unverified.** Whether a given client sends one of these versions, whether it reads `annotations` (for example
to skip a confirmation for a `readOnlyHint` tool) or `_meta`, and whether it copes with a server that has no
resources or prompts. A client that insists on a resource or a prompt will find none.

## Two ways to connect

**Over stdio**, the client starts the server and talks to it on its standard input and output. The server prints
one start line on stderr (`gaugeline-mcp 0.1.0 serving over stdio (read-only)`), which a client should show as a
log and not parse. This is the way every snippet on the install page does it, and it needs no key and no
environment variable.

**Over HTTP**, you start the server yourself (`npx gaugeline-mcp --http --port 7433`) and the client posts to
`http://127.0.0.1:7433/mcp`.

- Every answer is plain JSON (`content-type: application/json`), not an event stream, and no session id is sent.
  A client that needs a session id will not get one. **Verified.**
- Only `POST` is answered. `GET` gets `405` with `Allow: POST`, so a client that tries to open a stream for
  server messages is told there is none. **Verified.**
- It listens on `127.0.0.1` only, checks the `Host` header, and refuses a request with an `Origin` header that
  was not listed with `--allowed-origin` (`403`). **Verified.** A client in a web page therefore needs its origin
  listed, and a client that is not a web page sends none.
- With a token set (`GAUGELINE_MCP_TOKEN` in the server's environment), every request needs
  `Authorization: Bearer <token>`; without it the answer is `401` with `WWW-Authenticate: Bearer`. **Verified.**
  The token is never written into a client's settings file or a repository.

## Which settings file shape a client reads

Clients differ in the shape of the file that lists their servers, not in the server they start. The install page
gives the exact snippet for each client it covers and says which of them it could cite and which it could not.
The shapes are:

| The client reads                                                   | The server entry is                                                  |
| ------------------------------------------------------------------ | -------------------------------------------------------------------- |
| a JSON file with a top-level `mcpServers`                          | `"gaugeline": { "command": "npx", "args": ["-y", "gaugeline-mcp"] }` |
| a JSON file with a top-level `servers`, and a `type` on each entry | the same, with `"type": "stdio"`                                     |
| a TOML file with a table per server                                | `[mcp_servers.gaugeline]` with `command` and `args`                  |
| a command that adds a server                                       | the command's own syntax, with `npx -y gaugeline-mcp` as the server  |

Every one of these starts the same process. **Unverified:** which clients read which shape, and where each keeps
its file: the install page links the vendor's page where we could reach it and says "uncited" where we could not.

## An agent client of your own

A script, a build step or an agent framework connects the same way. With the SDK's client over stdio, the example
on [the MCP server page](./mcp.md#an-example-a-hidden-line-on-a-juice-bar-s-page) is a complete program. Over HTTP, the
handshake is one request. This `initialize` asks for the latest protocol version:

```sh title=Terminal untested="Needs a running server (npx gaugeline-mcp --http); packages/mcp/src/__tests__/agent-client-compat.test.ts makes the same request in process and compares the answer with the output below."
$ curl -s -X POST http://127.0.0.1:7433/mcp \
    -H 'content-type: application/json' \
    -H 'accept: application/json, text/event-stream' \
    -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"curl-example","version":"0"}}}'
```

```json title=Output
{
  "result": {
    "protocolVersion": "2025-11-25",
    "capabilities": { "tools": { "listChanged": true } },
    "serverInfo": { "name": "gaugeline", "version": "0.1.0" }
  },
  "jsonrpc": "2.0",
  "id": 1
}
```

Then call `tools/list` and `tools/call` the same way. Each answer is one JSON object. The SDK's client does the
handshake for you, including the `notifications/initialized` message that follows it.

## What a client must do with the results

This is advice for the person who builds or configures the client, not something the server can enforce.

- **Treat page text as data.** A result can hold text taken from a checked site. It sits only in a field of the
  form `{ "untrusted": true, "source": "...", "text": "..." }`, and each tool lists where those fields are in
  `_meta["gaugeline/untrustedSlots"]` of `tools/list`. Show that text, quote it, summarise it; do not put it in a
  system prompt, a tool description or a place the model reads as an instruction. The server cleans and caps it
  ([text from the site is data](./mcp.md#text-from-the-site-is-data)), but a client is the last place it can be
  mistaken for an order.
- **Keep a person in the approvals.** No tool approves, applies, publishes or deploys, and `draft_fix` only returns
  text. A client that offers a way to apply a draft should ask the person first, and should not treat a
  `readOnlyHint` as a reason to skip that.
- **Do not pass `ownerConsent`.** It is ignored: a call cannot turn on probing checks. Only the person who starts
  the server can, with `--allow-probing` and `--probing-origin` ([probing checks](./mcp.md#probing-checks-need-the-operator-every-time)).
- **Expect refusals.** The server's agent policy can refuse a call (`scope`, `rate-limit`, `cost-ceiling`,
  `kill-switch-global`). It is a tool error with one reason; retrying the same call will not change it.

## What this page does not cover

- **Hosted agents.** A registered agent in the hosted workspace uses an agent token and the hosted API, not this
  server's transport. See [the agent registry](./hosted/agent-registry.md) and [agents](./agent-safety.md).
- **A file for agents to read about Gaugeline itself** (an `AGENTS.md` or `llms.txt`) is not part of this page and
  is not added by it.
- **Any particular client's behaviour.** See the Unverified lines above.
