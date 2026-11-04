# How we build Gaugeline

1. One prompt, one branch, one pull request. Branch names are phase/description. If a diff passes about 400 lines, split it.
2. Before using any library or platform API, query the Grounded Code MCP server for its documentation.
   Do not write the call from memory. If the server has nothing, say so in the pull request and link the official page you used.
3. Every pull request description has a "Sources" section: for each decision, the document title, the URL or
   Grounded Code reference, and the line that supports it. A decision with no source is marked "uncited" so a reviewer sees it.
4. Every pull request has an "Architecture notes" section: what was chosen, what it was chosen over, and what it costs.
   Name the data structure and why (Map over array, Set over list, integers over floats).
5. Write the tests listed in the prompt before the implementation: unit, integration, end-to-end, then edge cases.
   A branch is done when they pass on Node 18.17, 20 and 22.
6. Gaugeline is read-only. Requests to a checked site are GET or HEAD only and go through the fetcher.
   Keys come from the environment and never reach a log, a finding or a report.
7. Checks are plain rules. No model calls in a check. The same input gives the same findings.
8. Packages/core never imports from the CLI and never calls process.exit.
9. A feature is not done until its docs and changelog ship in the same pull request:
   - the docs page named in the prompt is written or updated, with a runnable example and its real output
   - a changeset file says patch, minor or none, with one line a user would understand
   - a new check has its entry in the checks reference (what it catches, why it matters, how to fix it, technical line)
   - a new flag appears in docs/options and in --help, and a test asserts the two lists match
   CI fails a pull request that changes packages/*/src without a changeset or a docs change, unless labelled internal.
