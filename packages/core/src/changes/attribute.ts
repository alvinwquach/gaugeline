import type { ChangeLabel, Deploy, Revision, SourceRead } from "./types.js";

export interface Attribution {
  label: ChangeLabel;
  /** The revisions inside the window, oldest first. */
  revisions: Revision[];
  /** The deploys inside the window, oldest first, and the commit range they span when the host says it. */
  deploys: Deploy[];
  commitRange?: string;
  /** Why the label is "unknown" or less than it could be: every source that could not be read. */
  reasons: string[];
}

const inWindow = (time: string, after: string, upTo: string): boolean =>
  time > after && time <= upTo;

const short = (sha: string): string => sha.slice(0, 7);

/**
 * The attribution table. Two sources, each read, not configured, or could not be checked:
 *   revisions in the window, deploys in the window -> both
 *   revisions only                                 -> content-edit (deploys read or not configured)
 *   deploys only                                   -> code-deploy (revisions read or not configured)
 *   nothing, and every configured source read      -> unknown ("nothing recorded")
 *   a source could not be read                     -> never rules out the other kind: unknown with the reason
 * The window is (previous run, run where the finding appeared]. Nothing is inferred from names or times.
 */
export function attribute(args: {
  after: string;
  upTo: string;
  revisions: SourceRead<Revision>;
  deploys: SourceRead<Deploy>;
}): Attribution {
  const reasons: string[] = [];
  const revs =
    args.revisions.state === "read"
      ? args.revisions.items
          .filter((r) => inWindow(r.time, args.after, args.upTo))
          .sort((a, b) => a.time.localeCompare(b.time))
      : [];
  if (args.revisions.state === "could-not-check") reasons.push(args.revisions.reason);
  const all =
    args.deploys.state === "read"
      ? [...args.deploys.items].sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      : [];
  const deps = all.filter((d) => inWindow(d.createdAt, args.after, args.upTo));
  if (args.deploys.state === "could-not-check") reasons.push(args.deploys.reason);
  // The deploy live at the earlier run is the base of the commit range.
  const base = [...all].reverse().find((d) => d.createdAt <= args.after && d.commit !== undefined);
  const last = [...deps].reverse().find((d) => d.commit !== undefined);
  const commitRange =
    base?.commit && last?.commit ? `${short(base.commit)}..${short(last.commit)}` : undefined;
  const revisionsBlocked = args.revisions.state === "could-not-check";

  let label: ChangeLabel;
  if (revs.length > 0 && deps.length > 0) label = "both";
  else if (revs.length > 0) label = "content-edit";
  else if (deps.length > 0 && !revisionsBlocked) label = "code-deploy";
  else {
    label = "unknown";
    if (reasons.length === 0) {
      if (args.revisions.state === "not-configured" && args.deploys.state === "not-configured")
        reasons.push(
          "no content system and no deploy host is set up in gaugeline.changes.json, so there is no record to read",
        );
      else reasons.push("no content revision and no deploy is recorded between the two runs");
    }
    if (deps.length > 0 && revisionsBlocked)
      reasons.push("a deploy shipped, but a content edit is not ruled out");
  }
  return {
    label,
    revisions: revs,
    deploys: deps,
    ...(commitRange ? { commitRange } : {}),
    reasons,
  };
}
