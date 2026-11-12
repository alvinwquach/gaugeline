# Supabase through its own MCP server

Available from the next release.

Find out whether the Supabase database behind a client's site has a table anyone can read, by asking Supabase itself, through the MCP server Supabase hosts, in its read-only mode, for one project only.

A pop-up bar takes bookings on a Next.js site that saves them to a Supabase table. If row-level security is off on that table, the public key the site ships to every visitor can read the whole guest list. The live site cannot show you that; Supabase's own table list and security advisor can. This page is for the freelancer who built the site and has been given access to the project. Gaugeline reads. It never runs SQL, never changes a setting and never calls a tool that can write.

::: warning Not verified against the live server yet
The read, the checks and the tests are built against a recorded, invented copy of the server's answers. Two things are uncited until the owner confirms them on a real project: that the hosted server takes a personal access token as a bearer header without a browser login, and the exact tool list it shows in read-only mode. Until the real tool list is recorded, a live run stops with "could not check: the vendor changed this tool and Gaugeline has not reviewed the new one". It never passes on a guess.
:::

## What it checks

| Check                                       | Catches                                                               |
| ------------------------------------------- | --------------------------------------------------------------------- |
| [`supabase-rls-off`](/docs/checks)          | A table in the `public` schema has row-level security off             |
| [`supabase-security-advisor`](/docs/checks) | Supabase's own security advisor reports a lint at ERROR or WARN level |

Both are in the Security & email area. A read that stopped, a tool that was not read, or a value that is not a plain yes or no is listed under "could not check", never as a pass.

## Set it up

1. Make a personal access token in the Supabase dashboard (Account, Access Tokens), with an account you are allowed to use for this client. Supabase has no read-only token that we know of (uncited), so Gaugeline narrows what the token can do in two other ways, both in the address it sends to: `read_only=true`, the server's read-only mode, and `project_ref`, the one project you name. The fetcher refuses any other address.
2. Put the token in the environment, never in a file: `SUPABASE_ACCESS_TOKEN`.
3. Name the project in `gaugeline.platforms.json`, in the folder you run Gaugeline from. The project ref is the 20-character id in Project Settings. A key in this file is refused.

```json title=gaugeline.platforms.json
{
  "supabase": { "projectRef": "abcdefghijklmnopqrst" }
}
```

## Example: a pop-up bar's bookings

Night Market Pop-Up keeps its Friday guest list in `public.bookings` and its menu in `public.menu_items`. Row-level security was switched on for the menu and forgotten for the bookings.

```sh title=Terminal untested="Needs a Supabase project and a token, which a docs runner must not use. packages/cli/src/__tests__/platform-supabase.test.ts runs this command against a stand-in for Supabase's server (an invented project, no key) and compares the output with the block below."
$ npx gaugeline platform
```

```text title=Output
Supabase project abcdefghijklmnopqrst, read-only through Supabase's MCP server (6 requests)
Read: 2 tables in public; 3 security lints; 2 migrations, the newest 20261101093000

✗ A Supabase table has row-level security off
    public.bookings: row-level security is off (about 214 rows).
! Supabase's security advisor reports a problem
    Supabase's security advisor reports function_search_path_mutable (WARN, facing EXTERNAL) 1 time.

2 to look at, 1 to fix first.
```

`--json` prints the schema 2 result and nothing else; `--ci` exits 1 when a high finding is printed.

## What Gaugeline sends, and what it keeps

- Only these messages, to `https://mcp.supabase.com/mcp?read_only=true&project_ref=<yours>`: `initialize` (declaring nothing a server could use to ask Gaugeline a question), the initialized notice, `tools/list` (every page), and three tool calls with fixed arguments: `list_tables` for the `public` schema, `get_advisors` for security, and `list_migrations`. Never `execute_sql`, logs, functions or keys. Every request goes through the fetcher, which refuses anything else before it is sent.
- Before calling anything, Gaugeline reads the server's whole tool list. Every tool must be marked read-only and not destructive. The three it calls, and the two it knows the read-only server also shows and never calls (`get_publishable_keys`, `search_docs`), must each appear once, with their marks, name and schema exactly as reviewed. Any other tool, a tool named like a write, or a changed one stops the read.
- From the answers it keeps table names (cleaned and cut to 40 characters), whether row-level security is on, row estimates, lint codes and levels, and a count of migrations. Descriptions, comments and the advisor's text are dropped. Nothing from the server is treated as an instruction.
- The token goes in one request header and nowhere else: not in an address, a log, a finding, a report or an error.

## Not verified

- That the hosted server accepts a personal access token without a browser login (uncited).
- The exact tool list of the read-only server, and the advisor's lint levels: the stored hashes are placeholders from the invented recording.
- The real read-only server also lists `execute_sql`, marked read-only. Its name says it runs SQL, so Gaugeline does not tolerate it, and a live read stops until that is decided.

Use a credential you are allowed to use, for a project you look after.
