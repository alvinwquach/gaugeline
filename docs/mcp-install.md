# Add the MCP server to your assistant

Set up `gaugeline-mcp` in Claude Desktop, Claude Code, Cursor, VS Code, Windsurf or Codex, so your assistant can check a site you are building.

Every snippet below starts the same server: `npx -y gaugeline-mcp`, over stdio, with no key and no environment variable. Each one is started by a test in this repository (`packages/mcp/src/__tests__/install-docs.test.ts`) exactly as the client would start it: the same command and arguments, an initialize, the tool list below, and one check of an invented bar's site that only sends `GET` and `HEAD`. For what the tools do and what the server will and will not reach, see [the MCP server page](./mcp.md).

You need Node 22 or newer, because the client runs `npx` for you.

## What you should see

Once a client is connected it lists these tools. `plan_check` is not offered until you turn it on (see [the MCP server page](./mcp.md#plan-check-is-off-until-you-turn-it-on)).

```json title=Output tools-list untested="Checked against the live server by packages/mcp/src/__tests__/install-docs.test.ts."
["compare_runs", "draft_fix", "explain_finding", "list_checks", "run_check"]
```

If the client shows no tools, or shows the server as failed, run the server by hand to see its message: `npx -y gaugeline-mcp --help` prints its options and exits.

## How each client is documented here

A claim marked **[docs]** links the vendor's page that says it. Where we could not reach the vendor's page when this was written, the claim is marked **uncited**, we give only the snippet (the shape every MCP client reads: a server name, a `command` and its `args`), and we do not say where the file lives: check the client's documentation. Vendors rename menus and move files, so read the vendor's page for the place to put it.

## Claude Desktop

**[docs]** [Connect to local MCP servers](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/docs/2025-11-25/develop/connect-local-servers.mdx) (the Model Context Protocol project's guide, read from its source on GitHub): the file is `claude_desktop_config.json`, at `~/Library/Application Support/Claude/claude_desktop_config.json` on macOS and `%APPDATA%\Claude\claude_desktop_config.json` on Windows. In the app: open Settings from the Claude menu in the system menu bar, choose the Developer tab, and click Edit Config, which creates the file if it does not exist. The top-level key is `mcpServers`; each server has a `command`, `args` and an optional `env`. Add the server inside `mcpServers`:

```json title=claude_desktop_config.json client=claude-desktop untested="Started by packages/mcp/src/__tests__/install-docs.test.ts."
{
  "mcpServers": {
    "gaugeline": { "command": "npx", "args": ["-y", "gaugeline-mcp"] }
  }
}
```

The same guide says that on Windows, `npx` can keep failing if npm is not installed globally (a `%APPDATA%\npm` folder shows it is).

To check a site running on your own computer, such as a Next.js dev server, add `--allow-private`. This opens your own machine and network and nothing else; the cloud-metadata addresses stay closed (see [what the server can reach](./mcp.md#what-the-server-can-reach)):

```json title="claude_desktop_config.json, to check your own machine" client=claude-desktop-local untested="Started by packages/mcp/src/__tests__/install-docs.test.ts."
{
  "mcpServers": {
    "gaugeline": { "command": "npx", "args": ["-y", "gaugeline-mcp", "--allow-private"] }
  }
}
```

Probing checks (the ones that ask for non-public paths such as `/.env`) stay off. Only you can turn them on, for a site you own, by adding `--allow-probing` and `--probing-origin https://your-site.example` to `args`; an assistant cannot ask for them (see [probing checks](./mcp.md#probing-checks-need-the-operator-every-time)).

## Claude Code

**[docs]** [Claude Code: connect to tools with MCP](https://code.claude.com/docs/en/mcp): `claude mcp add [options] name -- command [args...]`. For a stdio server, "the `--` (double dash) separates Claude's own options, such as `--transport`, `--env`, and `--scope`, from the command and arguments that run the server." The scope (`-s` or `--scope`) is `local` (the default: you, in the current project), `project` (everyone in the project, through a `.mcp.json` file) or `user` (you, in every project).

```sh title=Terminal client=claude-code untested="Changes your Claude Code settings; started by packages/mcp/src/__tests__/install-docs.test.ts."
$ claude mcp add --transport stdio gaugeline -- npx -y gaugeline-mcp
```

To share it with a client's team through the repository, add `--scope project`, which writes `.mcp.json`. That file uses the same `mcpServers` shape as the Claude Desktop snippet above; the page says an entry with no `type` is read as a stdio server.

## Cursor

**Uncited.** We could not reach Cursor's documentation when this was written, so we do not say where its MCP settings file lives or which menu opens it: check the client's documentation. The shape is the usual one:

```json title="Cursor MCP settings" client=cursor untested="Started by packages/mcp/src/__tests__/install-docs.test.ts."
{
  "mcpServers": {
    "gaugeline": { "command": "npx", "args": ["-y", "gaugeline-mcp"] }
  }
}
```

## VS Code

**[docs]** [MCP configuration reference](https://raw.githubusercontent.com/microsoft/vscode-docs/main/docs/agents/reference/mcp-configuration.md) (VS Code's documentation, read from its source on GitHub): the workspace file is `.vscode/mcp.json`, and a user-profile `mcp.json` holds servers for every workspace. The top-level key is `servers` (not `mcpServers`), and a stdio server needs `type` set to `"stdio"`, a `command` on your path, and optional `args` and `env`.

```json title=".vscode/mcp.json" client=vscode untested="Started by packages/mcp/src/__tests__/install-docs.test.ts."
{
  "servers": {
    "gaugeline": { "type": "stdio", "command": "npx", "args": ["-y", "gaugeline-mcp"] }
  }
}
```

The same page gives a command that adds a server to your user profile:

```sh title=Terminal client=vscode-command untested="Changes your VS Code settings; started by packages/mcp/src/__tests__/install-docs.test.ts."
$ code --add-mcp '{"name":"gaugeline","type":"stdio","command":"npx","args":["-y","gaugeline-mcp"]}'
```

That page also says this `servers` format belongs to VS Code's older local agent, and that newer Copilot setups read `mcpServers` files instead (`~/.copilot/mcp-config.json`, or `.mcp.json` at the workspace root). If your VS Code is newer, check the client's documentation for which file it reads.

## Windsurf

**Uncited.** We could not reach Windsurf's documentation when this was written, so we do not say where its MCP file lives or how to open it: check the client's documentation. The shape is the usual one:

```json title="Windsurf MCP settings" client=windsurf untested="Started by packages/mcp/src/__tests__/install-docs.test.ts."
{
  "mcpServers": {
    "gaugeline": { "command": "npx", "args": ["-y", "gaugeline-mcp"] }
  }
}
```

## Codex

**Uncited.** We could not reach OpenAI's Codex documentation when this was written, so we do not say where its configuration file lives or whether it has a command that adds a server: check the client's documentation. Codex reads TOML, not JSON; the shape we expect is a table per server:

```toml title="Codex configuration" client=codex untested="Started by packages/mcp/src/__tests__/install-docs.test.ts."
[mcp_servers.gaugeline]
command = "npx"
args = ["-y", "gaugeline-mcp"]
```

## Keys and environment variables

The stdio server needs none, so no snippet has an `env` block and no snippet contains a key. If you start the server over HTTP instead (see [over HTTP](./mcp.md#over-http)), the token comes from the environment as `GAUGELINE_MCP_TOKEN`, set in your shell or your process manager and never written into a client's configuration file or a repository. The test fails if a snippet's `env` holds anything but empty values or `${NAME}` references.

## An example: a corner bar's new site

A freelancer has moved a corner bar's site to Next.js and put a preview on Vercel. With the server added, in any of the clients above:

> Check https://corner-bar-preview.example with Gaugeline and tell me what a customer or Google would trip over before we send the owner the link.

The assistant calls `run_check` on that address, reads the findings and calls `explain_finding` for any it should explain. For a preview on a public address that needs no flag. For a dev server on your laptop it needs the `--allow-private` snippet above. Nothing is changed on the site: the server sends `GET` and `HEAD` only, and `draft_fix` returns text for you to apply. The shape of what comes back is on [the MCP server page](./mcp.md#an-example-a-bindery-s-staging-site).
