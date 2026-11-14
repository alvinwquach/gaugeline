/** Shared stand-ins for the writer's tests: a recording GitHub, an approvals table, a trail. No network. */
import { createHash } from "node:crypto";
import type { ApplyDeps } from "../github/apply.js";
import { checkRequest, type GithubRequest } from "../github/endpoints.js";
import type { Approval, ApplyJob, TrailEntry } from "../types.js";

export const DRAFT = "a1d10000-0000-4000-8000-0000000000a1";
export const ORG = "0a000000-0000-4000-8000-00000000000a";
export const SITE = "5e000000-0000-4000-8000-0000000000e5";
export const OTHER_ORG = "0b000000-0000-4000-8000-00000000000b";
export const OTHER_SITE = "5e000000-0000-4000-8000-0000000000e6";
export const NOW = new Date("2026-11-12T12:00:00Z");
export const HOUR = 60 * 60 * 1000;
export const TOKEN = ["ghp", "_", "invented0token0for0tests0only00000000"].join("");
export const PAYLOAD = {
  title: "Point the menu link at /drinks",
  body: "The menu page links to /drinks-2025, which returns 404.",
  files: [{ path: "app/menu/links.ts", content: 'export const drinks = "/drinks";\n' }],
};

export const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

export const job = (payload: unknown = PAYLOAD, over: Partial<ApplyJob> = {}): ApplyJob => {
  const payloadText = JSON.stringify(payload);
  return {
    orgId: ORG,
    siteId: SITE,
    draftId: DRAFT,
    decisionId: "42",
    kind: "pull_request",
    payloadText,
    payloadSha256: sha256(payloadText),
    ...over,
  };
};

/** The approval row that matches `j`, decided an hour before NOW. */
export const approvalFor = (j: ApplyJob, over: Partial<Approval> = {}): Approval => ({
  decisionId: j.decisionId,
  draftId: j.draftId,
  orgId: j.orgId,
  siteId: j.siteId,
  kind: j.kind,
  decision: "approved",
  payloadSha256: sha256(j.payloadText),
  decidedAt: new Date(NOW.getTime() - HOUR),
  later: [],
  ...over,
});

/** A stand-in GitHub: answers each registered endpoint and records what was asked. */
export function fakeGithub(
  options: {
    existingPull?: boolean;
    closedPull?: boolean;
    fileExists?: boolean;
    failOn?: string;
  } = {},
) {
  const sent: GithubRequest[] = [];
  const send = async (req: GithubRequest) => {
    checkRequest(req);
    sent.push(req);
    if (req.endpoint === options.failOn) return { status: 422, json: { message: "secret detail" } };
    switch (req.endpoint) {
      case "getRef":
        return { status: 200, json: { object: { sha: "b".repeat(40) } } };
      case "getContent":
        return options.fileExists
          ? { status: 200, json: { sha: "c".repeat(40) } }
          : { status: 404, json: {} };
      case "listPulls": {
        // state=all lists closed pull requests too; state=open would not.
        const open = options.existingPull;
        const closed = options.closedPull && req.query?.state === "all";
        return {
          status: 200,
          json: open || closed ? [{ html_url: "https://github.com/acme/site/pull/7" }] : [],
        };
      }
      case "createRef":
        return { status: 201, json: {} };
      case "putContent":
        return { status: 201, json: {} };
      case "createPull":
        return { status: 201, json: { html_url: "https://github.com/acme/site/pull/8" } };
    }
  };
  return { sent, send };
}

/**
 * Deps for one job: the approval table holds the row that matches `forJob` unless told otherwise
 * (`approval: null` for none, an object to change fields).
 */
export function deps(
  over: Partial<ApplyDeps> & { send: ApplyDeps["send"] },
  forJob: ApplyJob = job(),
  approval: Partial<Approval> | null = {},
): ApplyDeps & { log: TrailEntry[]; lookups: string[] } {
  const log: TrailEntry[] = [];
  const lookups: string[] = [];
  return {
    target: {
      orgId: ORG,
      siteId: SITE,
      owner: "northgate-studio",
      repo: "tidewater-bar",
      base: "main",
    },
    trail: { record: async (e) => void log.push(e) },
    approvals: {
      find: async (id) => {
        lookups.push(id);
        return approval === null ? null : approvalFor(forJob, approval);
      },
    },
    mode: "write",
    env: {},
    orgPaused: async () => false,
    now: () => NOW,
    log,
    lookups,
    ...over,
  };
}
