export { applyDiff, splitLines, unifiedDiff } from "./diff.js";
export {
  FIXERS,
  PROPOSAL_VERSION,
  applyProposal,
  buildProposal,
  isRefusal,
  parseProposalFile,
  proposalFile,
  proposalFileSchema,
  proposalSchema,
} from "./proposal.js";
export type {
  FileChange,
  Fixer,
  Proposal,
  ProposalFile,
  ProposalInput,
  Refusal,
} from "./proposal.js";
export { fixRedirect, redirectProposal } from "./redirect.js";
export type { RedirectRequest, RepoFile } from "./redirect.js";
export { fixStructuredData, structuredDataProposals } from "./structured-data.js";
export type { Disagreement } from "./structured-data.js";
export { fixImageTag, imageTags, performanceProposals, readLcpEvidence } from "./performance.js";
export type { ImageTag } from "./performance.js";
export { toInboxDraft } from "./draft.js";
export type { InboxDraft, PullRequestPayload } from "./draft.js";
