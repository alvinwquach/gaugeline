/**
 * A proposal as the hosted inbox's `pull_request` draft (X70, ADR-0010). This only builds the JSON a draft
 * carries: `{ title, body, files: [{ path, content }] }`, the shape fixed by the inbox's kinds file (in the
 * hosted app) and by the kinds file of the package that applies approved drafts. It sends nothing and
 * imports neither of them: the repository, the branch and the draft flag are not in the payload, the
 * customer's own worker fixes them. A test under scripts/ parses every payload this makes with both parsers.
 *
 * A pull request's files carry whole new texts, not diffs, so the file's current text is needed: the
 * proposal's diff is applied to it, and a diff that does not fit that text (it moved on since the proposal
 * was made) is a refusal, never a guess.
 */
import { applyProposal, type Proposal, type Refusal } from "./proposal.js";

export interface PullRequestPayload {
  title: string;
  body: string;
  files: { path: string; content: string }[];
}

/** One draft for the inbox: its kind, the proposal it came from, and the payload a person approves. */
export interface InboxDraft {
  kind: "pull_request";
  proposalId: string;
  payload: PullRequestPayload;
}

/** The inbox's limits on a payload (the inbox's kinds file): title 200, body 20,000, a file 100,000. */
const MAX_TITLE = 200;
const MAX_BODY = 20_000;
const MAX_FILE = 100_000;
const MAX_PAYLOAD_BYTES = 16_384;

/**
 * Text with the characters a draft refuses taken out (page text is data): every control character but the
 * newline and the tab, the line and paragraph separators, and the bidirectional controls that make text
 * read in another order than it is written. Carriage returns become newlines.
 */
const plain = (text: string): string =>
  [...text.replace(/\r\n?/g, "\n")]
    .filter((ch) => {
      const c = ch.charCodeAt(0);
      if (ch === "\n" || ch === "\t") return true;
      const control = c < 0x20 || (c >= 0x7f && c <= 0x9f) || c === 0x2028 || c === 0x2029;
      const bidi = (c >= 0x202a && c <= 0x202e) || (c >= 0x2066 && c <= 0x2069) || c >= 0xfffe;
      return !control && !bidi;
    })
    .join("");

/** A fenced block whose fence is longer than any run of backticks inside, so the text cannot close it. */
function fenced(text: string, info = ""): string {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}${info}\n${text.replace(/\n$/, "")}\n${fence}`;
}

/** The pull request's description: the finding, its evidence, the file, the diff and how it is re-checked. */
function describe(p: Proposal): string {
  return [
    `Gaugeline proposes this change for the finding \`${plain(p.finding.checkId)}\` on ${plain(p.finding.url)}.`,
    "",
    "Evidence:",
    "",
    fenced(plain(p.finding.evidence)),
    "",
    `File: \`${plain(p.target.path)}\``,
    "",
    "The change:",
    "",
    fenced(plain(p.change.diff), "diff"),
    "",
    `How it is checked again: ${plain(p.recheck.how)}`,
    "",
    `Proposal ${p.id}. It is a draft: read the diff, change it if it is wrong, and merge it yourself.`,
  ].join("\n");
}

/**
 * The inbox draft for one proposal, given the target file's current text; or why there is none. The text
 * is the proposal's file as the repository has it now, so a diff made from an older text is refused.
 */
export function toInboxDraft(proposal: Proposal, current: string): InboxDraft | Refusal {
  const after = applyProposal(current, proposal);
  if (after === undefined)
    return {
      refused: `${proposal.target.path} is not the text proposal ${proposal.id} was made from: make the proposal again.`,
    };
  const title = plain(proposal.summary).replace(/\n/g, " ");
  const body = describe(proposal);
  if (title === "" || title.length > MAX_TITLE)
    return { refused: "The title is empty or over 200 characters." };
  if (body.length > MAX_BODY) return { refused: "The description is over 20,000 characters." };
  if (after.length > MAX_FILE)
    return { refused: `${proposal.target.path} would be over 100,000 characters.` };
  const draft: InboxDraft = {
    kind: "pull_request",
    proposalId: proposal.id,
    payload: { title, body, files: [{ path: proposal.target.path, content: after }] },
  };
  if (Buffer.byteLength(JSON.stringify(draft.payload), "utf8") > MAX_PAYLOAD_BYTES)
    return { refused: "The draft is over 16,384 bytes, more than the inbox keeps." };
  return draft;
}
