---
notReleased: true
---

# MCP server

Let AI assistants check before they change anything.

| Tool       | Does                                                      |
| ---------- | --------------------------------------------------------- |
| `impact`   | Lists everything a change would touch                     |
| `check`    | Checks one page against its content                       |
| `plan_fix` | Prepares a fix and returns a link for a person to approve |

Assistants can plan a fix but never approve their own. It works alongside Sanity's own MCP server, which does the editing.

## The work order

The server's `brief` tool, planned with the server, makes the work order from a result with the same two functions as `gaugeline brief`: `buildBrief` returns the items as data and `renderBriefMarkdown` makes the text. An assistant that works with a freelancer on a clinic's site can edit the items (drop one the clinic will not pay for, add a note to the evidence) before the text is made. The data is a `Brief`, published as `packages/core/schema/brief.v1.json` so the tool can describe its own output. See [When you don't have a developer](./no-developer.md#use-the-work-order-from-code).
