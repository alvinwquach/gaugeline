import { readFileSync, statSync } from "node:fs";
import {
  buildPrComment,
  commentTargetFrom,
  createCommentSender,
  type CommentFailure,
  type CommentFinding,
  type CommentSender,
  type FindingsBaseline,
} from "@gaugeline/core";

/** The event file is a few kilobytes; anything near this is not one. */
const MAX_EVENT_BYTES = 10 * 1024 * 1024;

/** Why a post failed, in the words of the one plain line. The token and GitHub's own words are never in it. */
const FAILURE: Readonly<Record<CommentFailure, string>> = Object.freeze({
  refused: "refused before anything was sent",
  "read-only-token": "read-only token",
  "rate-limited": "rate limited",
  "bad-token": "token not accepted",
  "not-found": "pull request not found, or the token cannot see it",
  rejected: "GitHub did not accept it",
  redirect: "unexpected redirect, not followed",
  outage: "GitHub is not answering",
  "blocked-address": "the name resolved to a private address",
  unreachable: "could not reach api.github.com",
  other: "unexpected answer",
});

export interface PrCommentRun {
  /** The environment the workflow gives the step: GITHUB_EVENT_NAME, GITHUB_REPOSITORY, GITHUB_EVENT_PATH, GITHUB_TOKEN. */
  env: Readonly<Record<string, string | undefined>>;
  /** This run's findings that were not muted, including the ones the baseline already knows. */
  findings: readonly CommentFinding[];
  /** The baseline file the run was given, when it exists. */
  baseline?: FindingsBaseline;
  exitCode: 0 | 1;
  /** How many findings fail the run, as main.ts decided it (the number the exit code comes from). */
  failing: number;
  couldNotCheck: number;
  /** Tests hand in a sender that goes to a local server. */
  send?: CommentSender;
}

/**
 * Posts the one summary comment, and says how it went in one plain line for stderr. It never throws and never
 * changes the run's result: a pull request from a fork has a read-only token, GitHub answers 403, and the check
 * carries on. At most one request is made, and none outside a `pull_request` event with a token.
 */
export async function postPrComment(run: PrCommentRun): Promise<string> {
  const { env } = run;
  let event: unknown;
  const path = env.GITHUB_EVENT_PATH;
  if (path) {
    try {
      if (statSync(path).size <= MAX_EVENT_BYTES) event = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      event = undefined;
    }
  }
  const target = commentTargetFrom({
    eventName: env.GITHUB_EVENT_NAME,
    repository: env.GITHUB_REPOSITORY,
    token: env.GITHUB_TOKEN,
    event,
  });
  if (!target.ok)
    return {
      "not-a-pull-request": "No comment posted: this run is not a pull_request event.",
      "no-token":
        "No comment posted: GITHUB_TOKEN is not set. The job needs permissions: pull-requests: write.",
      "bad-repository": "No comment posted: GITHUB_REPOSITORY is not owner/name.",
      "bad-event": "No comment posted: the event file does not name a pull request.",
    }[target.reason];
  const body = buildPrComment({
    findings: run.findings,
    ...(run.baseline ? { baseline: run.baseline } : {}),
    exitCode: run.exitCode,
    failing: run.failing,
    couldNotCheck: run.couldNotCheck,
  });
  const sent = await (run.send ?? createCommentSender())({
    // The token goes into the sender's one header and nowhere else.
    token: (env.GITHUB_TOKEN ?? "").trim(),
    target: target.target,
    body,
  });
  return sent.ok
    ? `Posted one summary comment on pull request #${target.target.pullNumber}.`
    : `could not post the comment (${FAILURE[sent.failure]})`;
}
