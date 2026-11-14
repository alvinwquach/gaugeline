/**
 * A fix proposal (X70): the finding it answers, the file it changes, the exact change as a unified diff,
 * and how the change will be checked again. A proposal is data. Nothing in core or the CLI sends it
 * anywhere: a person reads the diff, and a separate approved step (ADR-0010) may turn it
 * into a draft pull request. The file that holds proposals is versioned and validated like every other
 * file core reads.
 */
import { createHash } from "node:crypto";
import * as z from "zod";
import { applyDiff, unifiedDiff } from "./diff.js";

export const PROPOSAL_VERSION = 1 as const;

/** The fixers that exist. A proposal names the one that made it. */
export const FIXERS = ["redirect", "structured-data", "performance"] as const;
export type Fixer = (typeof FIXERS)[number];

/** A fixer that is not certain says why and makes no proposal. */
export interface Refusal {
  refused: string;
}
export const isRefusal = (x: unknown): x is Refusal =>
  typeof x === "object" && x !== null && "refused" in x;

/** One changed file: its path in the repository, its text before and after. */
export interface FileChange {
  path: string;
  before: string;
  after: string;
}

/** A path inside a repository: relative, forward slashes, no "." or ".." segment. */
const repoPath = z
  .string()
  .min(1)
  .max(300)
  .refine(
    (p) =>
      !p.startsWith("/") &&
      !p.includes("\\") &&
      !p.includes("\0") &&
      p.split("/").every((s) => s !== "" && s !== "." && s !== ".."),
    "must be a relative path inside the repository",
  );

const sha256 = z.string().regex(/^[0-9a-f]{64}$/);

export const proposalSchema = z.strictObject({
  version: z.literal(PROPOSAL_VERSION),
  /** px_ and 16 hex digits of a hash of what the proposal changes: the same change has the same id. */
  id: z.string().regex(/^px_[0-9a-f]{16}$/),
  fixer: z.enum(FIXERS),
  /** One line a person reads first (the draft's title). */
  summary: z.string().min(1).max(200),
  /** The finding this answers, as the run reported it. */
  finding: z.strictObject({
    checkId: z.string().min(1).max(100),
    url: z.string().min(1).max(2000),
    evidence: z.string().max(2000),
  }),
  /** The repository ("owner/name") when the person said which, and the file inside it. */
  target: z.strictObject({
    repository: z
      .string()
      .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/)
      .nullable(),
    path: repoPath,
  }),
  /** The exact change, and the hashes of the file's text before and after it. */
  change: z.strictObject({ diff: z.string().min(1), beforeSha256: sha256, afterSha256: sha256 }),
  /** The check that ran on the original problem, and what to do to run it again on the change. */
  recheck: z.strictObject({ checkId: z.string().min(1).max(100), how: z.string().min(1).max(500) }),
});
export type Proposal = z.infer<typeof proposalSchema>;

export const proposalFileSchema = z.strictObject({
  version: z.literal(PROPOSAL_VERSION),
  proposals: z.array(proposalSchema).max(500),
});
export type ProposalFile = z.infer<typeof proposalFileSchema>;

export interface ProposalInput extends Omit<FileChange, "path"> {
  fixer: Fixer;
  summary: string;
  finding: Proposal["finding"];
  target: { repository: string | null; path: string };
  recheck: Proposal["recheck"];
}

const hash = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

/** The id: the fixer, the finding, the file and the diff, so the same change always has the same id. */
function proposalId(p: Pick<Proposal, "fixer" | "finding" | "target" | "change">): string {
  const material = JSON.stringify([
    p.fixer,
    p.finding.checkId,
    p.finding.url,
    p.target.path,
    p.change.diff,
  ]);
  return `px_${hash(material).slice(0, 16)}`;
}

/** Build a proposal from a file's text before and after a fix. Throws when the pieces are not valid. */
export function buildProposal(input: ProposalInput): Proposal {
  const diff = unifiedDiff(input.target.path, input.before, input.after);
  if (diff === "")
    throw new Error("A proposal needs a change: the text is the same before and after.");
  const body = {
    version: PROPOSAL_VERSION,
    fixer: input.fixer,
    summary: input.summary,
    finding: input.finding,
    target: input.target,
    change: { diff, beforeSha256: hash(input.before), afterSha256: hash(input.after) },
    recheck: input.recheck,
  };
  return proposalSchema.parse({ ...body, id: proposalId(body) });
}

export function proposalFile(proposals: readonly Proposal[]): ProposalFile {
  return { version: PROPOSAL_VERSION, proposals: [...proposals] };
}

/**
 * Read a proposals file: its shape, then that every id and diff is the one the proposal's own content
 * gives (a proposal edited by hand is refused, not trusted).
 */
export function parseProposalFile(input: unknown): ProposalFile {
  const file = proposalFileSchema.parse(input);
  for (const p of file.proposals) {
    if (proposalId(p) !== p.id)
      throw new Error(
        `Proposal ${p.id} does not match its own content: it was changed after it was made.`,
      );
    if (!p.change.diff.startsWith(`--- a/${p.target.path}\n+++ b/${p.target.path}\n`))
      throw new Error(`Proposal ${p.id} does not match its diff: the diff is for another file.`);
  }
  return file;
}

/** The text a proposal's diff makes of `before`, or undefined when the diff does not fit that text. */
export function applyProposal(before: string, proposal: Proposal): string | undefined {
  if (hash(before) !== proposal.change.beforeSha256) return undefined;
  const after = applyDiff(before, proposal.change.diff);
  return after !== undefined && hash(after) === proposal.change.afterSha256 ? after : undefined;
}
