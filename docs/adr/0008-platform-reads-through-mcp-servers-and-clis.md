# ADR-0008: Platform reads through MCP servers and CLIs: a named allowlist, a read-only credential, and never the hint alone

Status: proposed Date: 2026-11-11

**STOP: waiting for the owner's decision; MCP-03 is not built.** This record proposes; it changes no
code, no flag and no line of CLAUDE.md. Nothing in MCP-03 (`mcp/platform-reads`) starts until the
owner accepts one of the options below (or another). Branch `mcp/adr-platform-reads`, open question 64.
ADR-0007 (#214, XF-04) is also waiting; this record takes the next number after it, and `pnpm adr:check`
fails on a gap until 0007 has merged.

## Context

ADR-0001 makes Gaugeline read-only by construction. ADR-0005 added notifications, ADR-0006 added a
`POST` that carries a read-only query, through `fetcher.query`. Platforms now ship their own MCP
(Model Context Protocol) servers and command-line tools, and the owner asked (11 Nov 2026) whether
Gaugeline may read Vercel, Netlify, Cloudflare, Supabase and Shopify through them, and WordPress through
WP-CLI "only where it is the only way in": "only tools on a named allowlist, each marked `readOnlyHint`
and backed by a read-only credential; never trust the hint alone."

What an MCP server is, in the terms that matter here. A client sends JSON-RPC messages: `initialize`,
`tools/list`, `tools/call`. A tool has a name, an input schema and optional `annotations`:
`readOnlyHint` (default false), `destructiveHint` (default true), `idempotentHint` and `openWorldHint`
(default true). The specification calls every annotation a hint: "They are not guaranteed to provide a
faithful description of tool behavior" and "clients MUST consider tool annotations to be untrusted
unless they come from trusted servers." Its security section tells clients to validate tool results,
set timeouts and log tool use. A 2026 revision lets a server answer a call with a request for more
input; Gaugeline has no one to ask. Two transports matter. With stdio, "the client launches the MCP
server as a subprocess" (Gaugeline would run someone else's program). With Streamable HTTP the server is
remote, each message is an HTTP `POST`, and authentication is by OAuth or a bearer token.

What the repository already does. `packages/core/src/sources/salesforce-mcp.ts` is an MCP read source:
two tools only (`READ_TOOLS`), a word list for tool names that can write (`writeCapableTool`), a cap of
8 calls, and a transport injected from outside because the connection needs `POST`. It ships without
the connection, waiting for a decision like ADR-0006's. Every adapter reads with `GET`, or with a
`POST` query on an allowlist (ADR-0006), and keys never reach a log, finding or report (CLAUDE.md rule 6).

What the vendors ship, checked on 11 Nov 2026. The vendors' documentation sites could not be reached
from the build session (every host answered 403 from the proxy), so the facts below come from what the
vendors publish on GitHub and npm, read directly. Where only a search summary or memory supports a
line, it is marked uncited. The Sources section has the lines.

| Platform   | What exists                                                                                                                                                            | Transport and credential                                                                                                                                       | A read-only credential?                                                                                            | Verdict                                              |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------- |
| Supabase   | Official hosted server, `https://mcp.supabase.com/mcp`. URL options `project_ref`, `read_only=true`, `features`. 23 of its tools say `readOnlyHint`.                   | Streamable HTTP. A person signs in with OAuth; a bearer personal access token is uncited.                                                                      | No. The login is account-wide. The server has a read-only mode (the URL option), so the guarantee is the server's. | Eligible, the one to start with, as `server-mode`.   |
| Cloudflare | Official API server, `https://mcp.cloudflare.com/mcp`: by default a few tools (`search`, `execute`) that run code; `?codemode=false` gives one tool per API operation. | Streamable HTTP. OAuth, or a bearer API token with the permissions chosen when it is made.                                                                     | Yes: an API token made with Read permissions only; the API refuses a write (the permission names are uncited).     | Eligible, but its REST API answers `GET`; see below. |
| Netlify    | Official `@netlify/mcp` 1.21.0 (stdio, run with `npx`). A hosted server that uses Netlify's OAuth connection exists.                                                   | Stdio, so a spawned process. `NETLIFY_PERSONAL_ACCESS_TOKEN`, or the server runs `netlify login`.                                                              | None found. A personal access token acts as the person (uncited).                                                  | Not eligible.                                        |
| Vercel     | Official hosted server, `https://mcp.vercel.com` (third-party listings; Vercel's page unread).                                                                         | Streamable HTTP, OAuth (uncited).                                                                                                                              | None found, and no documented read-only mode (uncited).                                                            | Not eligible until the vendor documents one.         |
| Shopify    | An AI Toolkit plugin (docs, schemas, validation, store changes through the CLI). A Dev MCP for documentation (README unread: uncited).                                 | Plugin and CLI. The toolkit's own scripts send usage events, including the user's last message, to `shopify.dev`.                                              | Admin API scopes are read-only by name (uncited), but they belong to the REST/GraphQL adapter (C-17), not to MCP.  | Refused: telemetry (ADR-0003) and write capability.  |
| WordPress  | WP-CLI (`wp`), a local command.                                                                                                                                        | A local process, as the operating-system user that owns the site, using the database login in `wp-config.php`, and it loads the site's own plugins and themes. | None. There is no read-only mode.                                                                                  | Only as part B below, run locally by the owner.      |

Two things the vendors' own code shows.

- The hint cannot be the control. In `@supabase/mcp-server-supabase` 0.16.1 the tool `confirm_cost` says
  `readOnlyHint: true`, yet it belongs to the create-a-project flow and no verb list would stop it; and
  `execute_sql` and `run_notebook` change their hint from false to true when the server is started in read-only
  mode. In `@netlify/mcp` 1.21.0 one tool, `netlify-deploy-services-reader`, fronts many operations chosen
  by an argument (`operation: "get-deploy"`), and its hint is the aggregate of them. A name allowlist
  alone is not enough there: the argument value is part of what is allowed.
- Most of these servers are a thin wrapper over a REST API that already answers `GET`. For Cloudflare,
  Vercel, Netlify and Shopify a REST adapter under the existing rule 6 reads the same facts with fewer
  moving parts. MCP earns its place where REST has no obvious read: Supabase's table list and security advisors
  are tools, and the REST route to a table list is a SQL query (a `POST` of arbitrary text; uncited).

## Decision

Proposed. If accepted, a platform may be read through an MCP server or a command only when all the points
below hold. Part A covers remote MCP servers and is what MCP-03 builds. Part B covers a local command and is
specified here but not built until a user needs it.

### 1. How Gaugeline talks to it

**Part A: a remote server, through the fetcher.** `fetcher.query` (ADR-0006) gets one new body shape,
`mcp-jsonrpc`, so no other file opens a connection. An entry names the exact URL: the vendor's host (no
wildcard, no self-hosted address), the path, and the whole query string, where the value of each option
is either fixed (`read_only=true`) or the one the person configured (`project_ref`). The body must be one
JSON-RPC message whose method is `initialize`, `notifications/initialized`, `tools/list` or `tools/call`;
any other method (`resources/*`, `prompts/*`, `logging/*`, `tasks/*`) is refused. A `tools/call` is
accepted only when `params.name` is a tool on the entry and `params.arguments` passes the entry's
argument rules (point 2). Gaugeline never answers a request from the server (sampling, elicitation, roots,
or a request for more input): it ends the run for that platform as could-not-check. It does not open the
optional `GET` event stream and does not send `DELETE` to end a session; the session lapses. A reply that
arrives as an event stream is read only until the response to the request's id, under the fetcher's size cap
and timeout. A redirect is never followed.

**Part B: a local command, WP-CLI only.** A command is run only when all of these hold. Nothing here is
built by MCP-03.

- One file, `packages/core/src/sources/local-command.ts`, calls `child_process.spawn`. It is the only
  file allowed to; an `eslint` rule and the AST scan (see Tests) forbid it everywhere else.
- No shell: `spawn(file, args, { shell: false })`. The file is an absolute path the person gave in
  the configuration, checked to be a regular file whose base name is on the allowlist (`wp`); there is no
  `PATH` search, so a `wp` earlier in the path cannot stand in for it.
- The argument vector is fixed by the entry, element by element. The only variable parts are values the
  person configured and an argument rule allows (a site path, validated as a directory that contains
  `wp-config.php`). No text from a page, a lead or a tool result becomes an argument. `--ssh` and
  `--exec` (the options that run something elsewhere or evaluate PHP) are never present, and a
  contract test pins this.
- The environment is built from nothing: `LANG=C`, `HOME` set to an empty temporary directory and a
  `PATH` holding only the directory of the configured `php` (`wp` is a PHP script), and nothing inherited.
  Gaugeline supplies no credential to WP-CLI: it uses the login in the site's own `wp-config.php`, which
  is full database access and cannot be narrowed (`kind: "local-account"` below). Stdin is
  closed. The working directory is the validated site path. The child runs with a timeout of 20 seconds,
  stdout is read to at most 1 MB and killed past it, and stderr is read to at most 64 KB and never
  shown.
- It runs on the person's own machine, as the person, only when the person's configuration names the
  command. It is never started because a site looks like WordPress.
- Gaugeline passes the entry's own switch to skip the site's plugins and themes (`--skip-plugins`,
  `--skip-themes`, uncited), so the command does not execute the site's PHP beyond `wp-config.php`.
  If a read needs a plugin loaded, the read is not on the allowlist.

**Refused in both parts:** any server or command found by looking at a site; a generic client that takes
any server a person names; `npx` or any command that downloads code when it runs (an installed, pinned
version is the only one used); and any server transport that is not an exact entry.

### 2. The allowlist

A named, versioned list per platform, written in the adapter's own file, registered at module load,
checked and frozen, exactly as ADR-0006 does for endpoints. An entry per tool (and, for a tool that fronts
many operations, per tool and selector value):

```ts
interface PlatformReadAllow {
  id: string; // "supabase.get_advisors": the id the request log records
  platform: "supabase" | "cloudflare" | "wp-cli";
  kind: "mcp-http" | "local-command";
  server?: {
    // mcp-http only
    host: string; // exact; no wildcard
    path: string;
    query: Record<string, { fixed: string } | { configured: string }>;
  };
  command?: { file: string; args: readonly (string | { configured: string })[] }; // local-command only
  tool: string; // the exact name (a subcommand for a command); the selector, if the server fronts operations:
  selector?: { argument: string; value: string };
  documentation: { url: string; checked: string | null }; // null prints "uncited"
  vendorVersion: string; // the server or package version a person read
  semantics: string; // the vendor's own words for what the tool reads, one line
  hints: { readOnlyHint: true; destructiveHint: false; openWorldHint: false }; // must all be advertised
  credential: {
    env: string; // the environment variable; never argv, never a config file
    scope: string; // the narrowest scope that works, in the vendor's words
    kind: "read-only-credential" | "server-mode" | "local-account"; // see point 3
    verifiedBy: "platform" | "listing" | "none"; // what Gaugeline can check
  };
  arguments: Record<string, ArgumentRule>; // closed: an argument not listed is refused
  output: Record<string, OutputRule>; // the fields Gaugeline keeps; all others dropped
  listingHash: string; // sha256 of the canonical name, annotations and inputSchema (not description)
  limits: { maxResultBytes: number; maxCalls: number; timeoutMs: number };
}
type ArgumentRule =
  | { type: "const"; value: string | number | boolean }
  | { type: "enum"; values: readonly string[] }
  | { type: "integer"; min: number; max: number }
  | { type: "id"; pattern: string; maxLength: number } // a project ref, a site id
  | { type: "configured"; name: string }; // a value the person set; validated as an id
// There is no free-form string rule. Nothing from a page, a finding or a server reaches a tool.
```

A tool is called only if **all** of these hold at the moment of the call:

1. it is on the entry list, by exact name (and selector value);
2. `tools/list` advertises `readOnlyHint: true`, `destructiveHint` not true and `openWorldHint: false`
   explicitly (the specification's default for a missing `openWorldHint` is true, so silence is a refusal);
3. the listing's name, annotations and input schema hash to the entry's `listingHash`. A vendor change
   to a tool fails closed: that tool is not called, and the check says "could not check: the vendor
   changed this tool and Gaugeline has not reviewed the new one". The hash leaves out the description,
   which vendors rewrite often and Gaugeline never reads;
4. the arguments pass the entry's rules, and the request is built by Gaugeline, not copied from anywhere;
5. the credential is the entry's read-only credential (point 3).

A tool on the server but not on the list is never called, whatever it says about itself. The hint is
required and never sufficient: it is one of five locks.

### 3. Credentials

The token is an environment variable named in the entry (proposed: `SUPABASE_ACCESS_TOKEN`), read by
the one function that builds the request and by nothing else. It is never a flag, never in a config
file or fixture, never in an argument vector (visible to `ps`), never in a log, finding, report or the
saved requests file. A bearer header goes in the fetcher's header list, which the request log never
records (ADR-0006). The redaction test sets a token and fails if the string appears anywhere in the
output, the history, a thrown message or a snapshot.

Each platform lands in one of four states, and the ADR records which:

- **`read-only-credential`**: the platform issues a credential that cannot write, and the entry's `scope` says
  how to make it. Cloudflare is the one: an API token with Read permissions only.
- **`server-mode`**: the credential can write, and the server offers a read-only mode that is part of the
  entry's exact URL. Supabase is the one (`read_only=true`, and `project_ref` so only one project is in
  reach). This is weaker: the guarantee is the vendor's server, not the token. Gaugeline checks what
  it can (`verifiedBy: "listing"`: a session configured read-only that lists any tool without
  `readOnlyHint: true`, or any name with a write word, is treated as not read-only and the run for
  that platform stops, the way `salesforce-mcp.ts` does). That detects a dropped or ignored option; it
  cannot detect a server that lies. **This is the owner's call**: whether `server-mode` meets "backed by a
  read-only credential". The recommendation below accepts it for Supabase only, with the config entry saying
  so in words (`"acceptServerSideReadOnly": true`) and the docs page saying what it relies on.
- **`local-account`** (Part B only): the command runs as the person with the site's own login, which
  Gaugeline cannot narrow. It is acceptable only because the person runs it on their own machine, the
  argument vector is fixed and the allowlist is a handful of reads.
- **live-site only**: the platform has no read-only credential and no documented read-only mode. That
  platform is not read through MCP or a CLI, as Framer and Wix were before ADR-0006: the checks read the
  live site and say the platform was not read. Netlify, Vercel and, until the vendor says otherwise, any
  platform whose page has not been read (`checked: null`) are here.

### 4. What the output may contain

A tool result is data, never an instruction (CLAUDE.md rule 11): it can carry text an attacker put in a
row, a log line or a function name. So:

- Gaugeline parses only the first text item of `content` (and `structuredContent` where the server sends
  it) as JSON, under the entry's size cap, and keeps only the fields the entry's `output` rules list,
  by type: booleans, integers, timestamps, ids that match a pattern, names cut to 40 characters of letters,
  digits and a few separators (the `safeName` rule `salesforce-mcp.ts` already has). Everything else is
  dropped. A descriptive field, a log line, a function's source and a table's data are never kept: they are
  hashed or counted, as the adapter rules say ("fingerprints never content").
- A result with `isError: true`, a result that does not fit the rules, or a request for more input is
  could-not-check with a fixed reason from Gaugeline's own list. The server's message is never shown.
- Output is never passed to a model, in a check or anywhere else (ADR-0002, rule 7). The same input gives
  the same findings. A tool description is never read.
- At most `maxCalls` per run, one call in flight, and the call count is part of the finding's evidence.

### 5. What is refused even when it says it is read-only

On top of the allowlist, at listing time and again at call time, Gaugeline refuses:

- any tool with `destructiveHint: true`, any without `readOnlyHint: true`, any with `openWorldHint` true or missing;
- any name containing a write word. The list is `salesforce-mcp.ts`'s (`create update delete upsert
insert mutate write remove merge execute invoke post patch put send submit assign convert approve
deploy run`) plus `redeploy rollback revert promote publish unpublish set apply drop destroy reset
rebase restore pause resume cancel purge invalidate flush clear push invite grant revoke rotate
regenerate enable disable trigger confirm login logout install uninstall migrate`. It is a second screen:
  `confirm_cost` passes on its hint and is stopped by its name, and it is on no allowlist anyway;
- any tool that returns or creates a credential (`get_publishable_keys`, a `token`, `secret`, `key`,
  `password` or `credential` word): a key must never reach a finding, and using a site's keys against its own
  API is a probing check under rule 14;
- any tool that makes the vendor fetch a page for Gaugeline (a browser, screenshot or "fetch a URL"
  server such as Cloudflare's Browser Run server), because every request to a checked site goes
  through the fetcher (rule 6);
- code-execution tools (Cloudflare's default `execute`), which cannot be allowlisted: what they do is the
  code they are sent.

### 6. How it fits

- **Adapters:** a platform read is a `sources/` adapter like `salesforce-mcp.ts`, reading through
  `fetcher.query`; the shared guard (`writeCapableTool`, the screens above, `safeName`, the call cap) moves to
  one module `packages/core/src/sources/mcp-guard.ts` and Salesforce's source uses it too. That finishes the
  Salesforce transport, which is blocked today only by the missing connection.
- **Enablement is config-only:** a `gaugeline.platforms.json` entry names the platform, the project and the
  environment variable. A token in the environment does nothing without the entry, and the entry does nothing
  without the token. There is no auto-detection from a site, no default, no new flag. A platform read is
  not a probing check (it asks the vendor about the person's own project with the person's own credential, and
  requests no non-public path of the site), so `--owner-consent` is not required; the docs say "use a
  credential you are allowed to use".
- **Contract suite:** `adapters/__tests__/contract.ts` is extended: every platform entry lists the frozen
  entries its file exports, and the suite checks each is the registered object, every `tools/call` in a
  recording matches an entry, and the arguments pass the rules.
- **Boundary scan:** `post-scan.ts` gains a `spawn` category (Part B) and the `query` category covers
  `registerPlatformRead`. See Tests.
- **Docs:** one page per platform (`docs/sources/<platform>.md`) with the allowlist table as the docs show
  it (tool, what it reads, scope, date checked), a runnable example with recorded output, and "what is not
  verified". New findings need their checks-reference entries as usual.

## Recommendation

Approve a narrow design:

1. **Part A only, now:** remote Streamable HTTP through `fetcher.query`, with the `mcp-jsonrpc` body shape,
   exact-URL entries, the five locks and the refusals above. No process is spawned by MCP-03.
2. **One platform first: Supabase**, as `server-mode`, read-only mode and `project_ref` in the URL. Start with
   about four tools of the 23 that say read-only: `get_project` (status and region), `list_tables` (names and
   whether row-level security is on, verbose off), `get_advisors` (the vendor's security and performance
   findings, kept as codes, severity and counts) and `list_migrations` (names and times). Never
   `execute_sql`, `get_logs`, `query_logs`, `get_edge_function`, `list_notebooks`, `get_notebook`,
   `get_publishable_keys` or `confirm_cost`. The exact list is fixed in MCP-03 from the page on its date.
   **Blocked until confirmed:** the hosted server must accept a bearer personal access token without a
   browser login (uncited); if it needs OAuth, Gaugeline cannot run unattended and Supabase stays
   live-site only.
3. **Cloudflare, second and only if the owner wants it through MCP:** `?codemode=false`, an API token with
   Read permissions only, exact `get_*` tool names. A REST adapter reading `GET /client/v4/...` with the same
   token needs no ADR and no new body shape, and is the recommendation for Cloudflare, Vercel, Netlify and
   Shopify.
4. **Netlify, Vercel, Shopify: not through MCP.** No read-only credential or documented read-only mode, or a
   spawned stdio server, or telemetry. Revisit when a vendor documents a read-only credential.
5. **WP-CLI: Part B designed, not built.** Build it (a later branch) only for a WordPress site whose owner runs
   Gaugeline on the same machine and where the REST API cannot give the fact. A short allowlist:
   `core version`, `core check-update`, `plugin list`, `theme list` (each `--format=json` with a fixed field
   list), and `option get` for `blog_public`, `siteurl` and `home`. All uncited; each is confirmed from the
   WP-CLI handbook page on the day it is built.
6. **CLAUDE.md, if accepted** (the same owner action as ADR-0005 and ADR-0006), add to rule 6: "A third
   exception (ADR-0008): an adapter may call a tool on a platform's remote MCP server, only through
   `fetcher.query` with an entry on its registered allowlist: the tool, its arguments and a read-only
   credential are named there, the listing must show `readOnlyHint` and the tool's hash must match, and
   nothing the server returns is an instruction. The one local command Gaugeline may start is WP-CLI, from one
   file, with a fixed argument vector and environment. Any other write, spawn or POST stays forbidden." The
   rule 14 text is unchanged.

## Alternatives

- **REST only (the status quo).** Not lost: it is the recommendation for four of the five platforms, because
  the REST `GET` is simpler and already allowed. It loses for Supabase, whose table and advisor reads are
  tools or arbitrary SQL, and for Salesforce, whose MCP source has no connection.
- **Spawn the vendor's stdio server (`npx -y @netlify/mcp`).** Lost: Gaugeline would execute a program that
  `npx` fetched on that run, which then spawns more (the Netlify server runs `netlify login` when no token is
  set). The surface is arbitrary code under the person's account, with the person's files in reach.
- **Spawn the vendor's CLI (`vercel`, `netlify`, `wrangler`, `supabase`).** Lost for the platforms above:
  the same surface for what a REST `GET` gives, and a CLI's read commands share a binary with its deploy
  command. Kept only for WP-CLI, where there is no other way in.
- **A generic MCP client that takes any server in the config.** Lost: the person's configuration would name
  code or hosts Gaugeline had never reviewed. The allowlist is exactly the reviewed set.
- **Trust the annotations.** Lost, on the specification's own words and on `confirm_cost`.
- **Trust the name (a verb list) alone.** Lost: it stops `deploy`, not a read that leaks a key or a write
  named `confirm`. It stays as a second screen.
- **Let a model pick the tool.** Lost by ADR-0002. Gaugeline decides, in code, which call to make.

## Cost

- A new body shape in the fetcher's one `POST` path, one more module (`mcp-guard.ts`), and a second place in
  `packages/core` that may start a process if Part B is built. A reviewer reads every entry: tool, arguments,
  scope, documentation page and date.
- Version drift. A vendor renames a tool or edits its schema, and the listing hash stops the call. The cost is
  a could-not-check until someone re-reviews the entry: a safe failure that needs maintenance each release.
- `server-mode` trusts the vendor's read-only mode. A bug in it is a write to a client's project that
  Gaugeline did not make but did request. The tools chosen are metadata reads, and `execute_sql` is excluded.
- OAuth-only servers cannot be used unattended, which rules out Vercel's hosted server for now.
- Metadata can still be sensitive: a table name, a function name or an advisor message names the client's
  system. Output is trimmed to the entry's fields, and reports show names and counts, not content.
- Documentation we could not read. Every entry marks `checked: null` until a person reads the vendor's own
  page; MCP-03 may not claim a tool is read-only from a README or a package alone.

## Failure modes, and what is re-checked each release

- The vendor adds a write tool to the read-only mode: it is not on the allowlist, so it is never called; and a
  session that lists it fails the verification, so the run stops.
- The vendor's hint is wrong on an allowlisted tool: the review of its documentation (the first lock) and the
  credential (the fifth) hold. This is why the hint is one of five.
- A tool result carries instructions: it is data; only the entry's fields are kept, the rest is dropped.
- The token leaks into output: the redaction test, plus no key in an argument or a log.
- Before each release, a person re-reads each entry's page, updates `checked` and `vendorVersion`, and re-records
  the `tools/list` fixture. The run prints a note when an entry is over 120 days old. A release with an entry
  that has not been re-read says so in its changelog, or the entry is removed.

## What would change it

A vendor that documents a read-only token (Netlify, Vercel) would move that platform out of live-site
only. A vendor that documents a tool as read-only and is found to change something would remove its
entry and reopen `server-mode`. An MCP revision that lets a server push requests Gaugeline cannot refuse
would reopen the transport. A need for a second local command would need its own entry and a decision, not a
config line. The owner declining `server-mode` leaves Part A with Cloudflare only, which REST already reads, and
Supabase live-site only.

## Enforced by

Nothing new, because nothing is built. What already holds, and what a built version would sit on:

- `packages/core/src/fetcher.ts` (every request to a checked site is a `GET` or a `HEAD`; `fetcher.query` is
  the one path for a `POST`; private, loopback, link-local and metadata addresses are refused)
- `packages/core/src/sources/salesforce-mcp.ts` (the model: `READ_TOOLS`, `writeCapableTool`, the call cap, the
  injected transport)
- `packages/core/src/__tests__/post-boundary.test.ts` and `packages/core/src/__tests__/post-scan.ts` (no file
  but the allowed ones sends a write, opens a connection or registers an endpoint)
- `packages/core/src/adapters/__tests__/contract.ts` (the contract suite MCP-03 extends)
- `eslint.config.js` (`no-restricted-imports` keeps connections in one file; a `node:child_process` rule would
  join it for Part B)

### Tests MCP-03 must write first

Unit: the argument rules (no free-form string; a value from a page is refused); the screens (every write word,
`confirm_cost`, `get_publishable_keys`, a missing `openWorldHint`, a hint with no `readOnlyHint`); the listing
hash (a changed schema fails closed; a changed description does not); the answer parser (an oversized answer, a
non-JSON answer, `isError`, an unexpected field dropped, a request for more input ends the run); redaction (the
token appears nowhere). Integration: a recorded `tools/list` and `tools/call` for each entry through
`fetcher.query`; a server that lists a tool not on the allowlist (never called); a redirect (refused); a
session in read-only mode that lists a write tool (the run stops). End to end: a run with
`gaugeline.platforms.json` and the token set reads the fixture and prints the invented project's findings; with
no entry or no token nothing is requested. Edge cases: a server that changes a tool's annotations between
`tools/list` and the call; a tool name with different case or Unicode lookalikes; the `project_ref` that is not an
id. The scan: `post-scan.ts` fails any file but the adapter that builds a `tools/call`, registers a platform read,
or (Part B) calls `spawn`, `exec`, `execFile` or `fork` or sets `shell: true`; its self-test runs each way of
evading it. A contract test asserts every entry has `documentation`, `vendorVersion`, a `listingHash` and
`hints` as above, and that no entry has a write word in `tool`.

## Sources

Every vendor page below was unreachable from the build session (proxy 403), so each is cited from the vendor's
own GitHub README or npm package, which is what its docs link to, and marked [docs]. A line with no vendor text
behind it is uncited.

- Model Context Protocol specification, Tools (2025-06-18 and 2026-07-28), `docs/specification/*/server/tools.mdx`
  in `modelcontextprotocol/modelcontextprotocol`: "clients MUST consider tool annotations to be untrusted unless
  they come from trusted servers"; Security Considerations. [docs]
- MCP schema 2025-06-18, `ToolAnnotations`: "all properties in ToolAnnotations are hints"; defaults `readOnlyHint`
  false, `destructiveHint` true, `openWorldHint` true. [docs]
- MCP specification, Transports (2025-06-18): "The client launches the MCP server as a subprocess" (stdio); Streamable
  HTTP: the server "MUST validate the Origin header", "SHOULD implement proper authentication". [docs]
- Supabase MCP server README, `supabase-community/supabase-mcp`: `https://mcp.supabase.com/mcp`, options
  `project_ref`, `read_only=true`, `features`; "`readOnly`: When `true`, excludes mutating tools"; login prompt (OAuth).
  [docs]. Package `@supabase/mcp-server-supabase` 0.16.1 (npm): the tool names and annotations read in
  `src/tools/*` (23 with `readOnlyHint: true`; `execute_sql` and `run_notebook` adapt to read-only mode). [docs]
  Supabase's own guide (`supabase.com/docs/guides/ai-tools/mcp`): "`read_only=true` runs all queries as a read-only
  Postgres user" and "not for production data", via a search summary only. uncited. Bearer personal access token
  for the hosted server, the security-advisor and RLS fields of `get_advisors` and `list_tables`: uncited.
- Cloudflare MCP servers README, `cloudflare/mcp-server-cloudflare` and `cloudflare/mcp`: server URLs, OAuth or
  an API token "with the permissions you need", `?codemode=false` registers a tool per API method (`get_workers_scripts`),
  Browser Run server fetches pages. [docs]. That a Read-only token makes the API refuse a write, and the
  permission names: uncited.
- Netlify MCP server README and package `@netlify/mcp` 1.21.0 (npm): `npx -y @netlify/mcp`, Node 22,
  `NETLIFY_PERSONAL_ACCESS_TOKEN`, "create, manage, and deploy"; the reader/updater tools and their selector
  operations, `netlify login` when no token is set, in `dist/netlify-mcp.js`. [docs]. That a personal access token
  has no read-only form: uncited.
- Vercel: `mcp.vercel.com`, OAuth, no read-only mode found: third-party listings through a search; Vercel's page
  unread. uncited. (`vercel/mcp-adapter`'s README is for building servers on Vercel and says nothing of Vercel's own.)
- Shopify AI Toolkit README, `Shopify/shopify-ai-toolkit`: store management "through the CLI's store execute
  capabilities"; scripts send usage events, including the user's last message, to `https://shopify.dev/mcp/usage`.
  [docs]. Shopify Dev MCP and Storefront MCP: uncited.
- WP-CLI README, `wp-cli/wp-cli`: "update plugins, configure multisite installations, and much more". [docs]. The
  absence of a read-only mode, `--skip-plugins`, `--skip-themes`, `--ssh` and the subcommands named: uncited.
- This repository: `packages/core/src/sources/salesforce-mcp.ts`, `docs/sources/salesforce-mcp.md`, ADR-0001,
  ADR-0002, ADR-0003, ADR-0005, ADR-0006, CLAUDE.md rules 6, 7, 11, 13 and 14. [repository]
