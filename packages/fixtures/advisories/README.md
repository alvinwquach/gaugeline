# Invented advisories and docs pages for the check writer (AG-16)

Every package, advisory id, address and detail here is made up (rule 12). The addresses use example.org, which
is reserved for examples. `golden/` is the files the docs page runs; `hostile/`, `not-understood/`, `partly/`,
`malformed/` and the `leaky-*` folders are the known-bad and edge cases the tests read. `deny-list.txt` is the
example owner's list of names that must never reach a draft. The same text is in
`packages/core/src/check-writer/example.ts`, and a test keeps the two equal.

Two files are saved as `.txt` on purpose: `advisory-menu-embed.txt` is JSON on ONE long line (so the cited line is
an excerpt of it) and `advisory-truncated.txt` is JSON that stops half way; the formatter would rewrite the first
and cannot read the second. The writer reads the content of a file, never its extension.
