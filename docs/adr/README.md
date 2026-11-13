# Decision records

Each record says what was decided, what it was chosen over, what it costs, what would change it,
and what enforces it. A record is never edited after it is accepted: a later decision supersedes it
with a new record.

| Number                                                      | Title                                                                                                        | Status   | Date       |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | -------- | ---------- |
| [0001](0001-read-only-by-construction.md)                   | Read-only by construction                                                                                    | accepted | 2026-11-05 |
| [0002](0002-plain-rules-no-model-calls.md)                  | Plain rules, no model calls                                                                                  | accepted | 2026-11-05 |
| [0003](0003-no-telemetry-nothing-sent.md)                   | No telemetry, nothing sent                                                                                   | accepted | 2026-11-05 |
| [0004](0004-requests-the-checked-page-names.md)             | Requests to addresses the checked page names                                                                 | accepted | 2026-11-05 |
| [0005](0005-notifications-post-to-your-own-channels.md)     | Notifications post to your own channels                                                                      | accepted | 2026-11-06 |
| [0006](0006-read-only-post-queries.md)                      | A POST is allowed for a documented read-only query                                                           | accepted | 2026-11-11 |
| [0007](0007-open-image-optimizers.md)                       | Open image optimizers: read the config, probe only with consent and your own address                         | proposed | 2026-11-11 |
| [0008](0008-platform-reads-through-mcp-servers-and-clis.md) | Platform reads through MCP servers and CLIs: a named allowlist, a read-only credential, never the hint alone | proposed | 2026-11-11 |
| [0009](0009-rendered-checks.md)                             | Rendered checks: local Playwright by default, a microVM for the hosted tier, Firecrawl only when asked for   | proposed | 2026-11-12 |
| [0010](0010-approve-then-act-writes.md)                     | Approve-then-act writes: a person approves one proposal, the customer's own worker writes one draft          | accepted | 2026-11-12 |
| [0011](0011-listing-watch.md)                               | Listing watch is the listings checks on a schedule, not a new reader                                         | proposed | 2026-11-12 |
| [0012](0012-platform-checks.md)                             | Creator platform checks: one adapter per platform, and a test account before a line is written               | proposed | 2026-11-12 |
| [0013](0013-self-hosting.md)                                | Self-hosting waits for a hosted schema that has stopped moving                                               | proposed | 2026-11-12 |
| [0014](0014-agent-safety-model.md)                          | Agent safety model: registered agents, drafts only, deny by default, every call traced                       | proposed | 2026-11-13 |

Start a new record from [0000-template.md](0000-template.md).
