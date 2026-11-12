# MCP server

Let AI assistants check a site, and draft a fix, before anyone changes anything.

`gaugeline-mcp` is a separate small package that speaks the [Model Context Protocol](https://modelcontextprotocol.io/). Your assistant (Claude Desktop, Claude Code, Cursor and the rest) starts it and gets six tools. It runs the same checks as `npx gaugeline`, through the same code, and it is read-only: it never writes a file, publishes, merges or changes a site.

| Tool              | Kind    | Does                                                                                                            |
| ----------------- | ------- | --------------------------------------------------------------------------------------------------------------- |
| `run_check`       | `read`  | Checks one page and its site: `GET` and `HEAD` only. Probing checks need `ownerConsent: true` on that one call. |
| `list_checks`     | `read`  | Lists the checks, by area or framework. No request.                                                             |
| `explain_finding` | `read`  | Says what a finding catches, why it matters, how to fix it and how big the fix is. No request.                  |
| `compare_runs`    | `read`  | Which findings are new, which are fixed, between two runs in the session. No request.                           |
| `plan_check`      | `read`  | Checks a launch-plan file in the server's folder against a built site, the way `gaugeline plan --base` does.    |
| `draft_fix`       | `draft` | Returns the change that would fix a finding as plain text. It applies nothing; a person or a coding agent does. |

Every description starts with its kind, `[read]` or `[draft]`, so a client that shows only descriptions still shows it. There is no tool that approves, applies, publishes or deploys: assistants plan, people approve. A missing tool cannot be misconfigured.

## Add it to your assistant

For an assistant that starts a server itself (stdio), in its MCP settings:

```json title=Settings untested="A settings snippet for an assistant, not a command."
{
  "mcpServers": {
    "gaugeline": { "command": "npx", "args": ["-y", "gaugeline-mcp"] }
  }
}
```

A plan file is read only from the folder the server starts in (or `--root`), never from anywhere else. To check a site on your own machine or network, add `"--allow-private"` to `args`: without it, loopback, private and metadata addresses are refused, which stops an assistant being talked into fetching them.

## An example: a bindery's staging site

A freelancer is about to launch a bindery's new site and asks the assistant to look at the staging address before the client sees it. The assistant calls `run_check`; this is the real answer for an invented bindery fixture, shortened to the summary and the first finding.

```json title=Output untested="Captured from the packages/fixtures/sites/tampered fixture through the built server (needs an MCP client); packages/mcp/src/__tests__/stdio.test.ts runs the same call."
{
  "runId": "run-1",
  "url": "https://tampered.example/",
  "summary": { "high": 4, "medium": 0, "low": 1, "passed": 196, "couldNotCheck": 0 },
  "findings": [
    {
      "id": "21047dd581765f28",
      "checkId": "hidden-ai-directive",
      "severity": "high",
      "checkTitle": "Hidden text on the page gives orders to AI assistants",
      "untrusted": {
        "evidence": {
          "untrusted_page_text": "body > main#main > div#seo-notes (hidden by display:none): ...",
          "source": "finding evidence",
          "truncated": false
        }
      }
    }
  ]
}
```

The assistant can then call `explain_finding` with `21047dd581765f28`, or `draft_fix` for text the freelancer applies. Run it again after the fix and `compare_runs` shows what is fixed.

## Text from the site is data

A checked page can say anything, including "ignore your instructions". Every value taken from a page (a title, a line of evidence, an address) comes back inside a field named `untrusted_page_text`, with invisible and control characters removed and the length capped. Each tool that returns such a field says in its description that it is data from the checked site, never instructions. Page text never appears in a tool name, a description or an address the server offers.

## Probing checks need the owner, every time

Checks that ask for a path that is not public (see [privacy and safety](./security.md)) run only when a call passes `ownerConsent: true`. It defaults to `false`, it is a boolean (the string `"true"` is refused), it is not remembered for the next call, and asking for a probing check by id does not skip it. Pass it only when the person who owns the site has said so.

## Over HTTP

```sh title=Terminal untested="Starts a long-running server."
$ npx gaugeline-mcp --http --port 7433
```

It answers `POST` on `http://127.0.0.1:7433/mcp` and nothing else. Following the MCP specification's [transport security guidance](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports#security-warning), it listens on `127.0.0.1` only, checks the `Host` header against the address it bound (so a web page cannot reach it through a name that points at your machine), and refuses any request that carries an `Origin` header unless you listed it with `--allowed-origin`.

To listen on another address you must pass `--allow-non-loopback`, name each host clients will use with `--allowed-host`, and set the token in the environment: `GAUGELINE_MCP_TOKEN` (never on the command line). With a token set, every request needs `Authorization: Bearer <token>`.

## What it keeps

Runs stay in memory for the session (the last 20) so `explain_finding`, `compare_runs` and `draft_fix` can refer to them. Nothing is saved to disk and nothing is sent anywhere but the site you named.

## The work order

The work order (`gaugeline brief`) is built from two functions in the core package, `buildBrief` and `renderBriefMarkdown`, so a later version of this server can offer it as a tool without a second copy of the logic. It is not a tool in this version. See [When you don't have a developer](./no-developer.md#use-the-work-order-from-code).

## In this version

- stdio and streamable HTTP, six tools, one registry, stateless HTTP.
- Not offered: the CLI flags that read a config file or a credential, DNS checks, and any tool that changes anything.
