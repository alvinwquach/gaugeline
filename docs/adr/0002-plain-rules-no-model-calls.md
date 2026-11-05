# ADR-0002: Plain rules, no model calls

Status: accepted Date: 2026-11-05

## Context

The FAQ answers "Does it use AI?" with "Not to find problems. Checks are plain rules, so the same
site gets the same answer every time." CI pipelines gate deploys on Gaugeline's exit code, so a
finding that comes and goes between two runs of the same page would fail a build at random. This
record is about finding problems; the product describes assistants and agents elsewhere (drafting
fixes, an MCP server), and those are separate decisions.

## Decision

A check is a pure function from a snapshot (and what the fetcher returned) to findings. No check
calls a language model, directly or through a dependency, and `packages/core` depends on no model
SDK. The same input gives the same findings, in the same order.

## Alternatives

- **Model-written findings.** Lost because the output would vary between runs, could not be tested
  against fixtures, and could invent problems that are not there.
- **Model-ranked findings** (rules find, a model orders them). Lost because the order decides what
  "Fix this first" means and therefore the exit code; it must be the same every time.

## Cost

Some problems a person can see at a glance (a confusing headline, an off-brand image) cannot be
found, because no plain rule describes them. Every check needs a rule precise enough to test.

## What would change it

A class of problems that people need found, that no plain rule can find, and that can be reported
outside the deterministic exit-code path without making the same input give a different answer.

## Enforced by

- `packages/core/src/__tests__/no-model-calls.test.ts` (no model SDK in `packages/core`'s
  dependencies or imports; a full check of each fixture run twice gives identical findings)
- `packages/core/src/checks/__tests__/runner.test.ts` (fixed sort order)
