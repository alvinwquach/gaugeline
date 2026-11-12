import type { ChangeLabel, Deploy, Revision, SourceRead } from "./types.js";

export interface Attribution {
  label: ChangeLabel;
  /** The revisions inside the window, oldest first. */
  revisions: Revision[];
  /** The deploys inside the window, oldest first, and the commit range they span when the host says it. */
  deploys: Deploy[];
  commitRange?: string;
  /** Why the label is "unknown": what each source said, in the words the report prints. */
  reasons: string[];
  /** For a label that is not unknown: a source that was not read, so the label rules nothing out about it. */
  notChecked: string[];
}

const inWindow = (time: string, after: string, upTo: string): boolean =>
  time > after && time <= upTo;

const short = (sha: string): string => sha.slice(0, 7);

/** What a source said, in words: read and empty, never asked, or asked and failed. */
const EDITS = {
  read: "no content edit is recorded in that time",
  none: "content edits were not checked (no document is named for this page in gaugeline.changes.json)",
  failed: (why: string) => `content edits could not be checked (${why})`,
};
const DEPLOYS = {
  read: "no deploy is recorded in that time",
  none: "deploys were not checked (no deploy host is set up in gaugeline.changes.json)",
  failed: (why: string) => `deploys could not be checked (${why})`,
};

/**
 * The attribution table. Two sources, each read, not configured, or could not be checked:
 *   revisions in the window, deploys in the window -> both
 *   revisions only                                 -> content-edit
 *   deploys only, edits read or never asked        -> code-deploy (never asked is said, not assumed)
 *   deploys only, edits could not be read          -> unknown: a content edit is not ruled out
 *   nothing found                                  -> unknown, saying for each source whether it was read
 * The window is (previous run, run where the finding appeared]. Nothing is inferred from names or times.
 */
export function attribute(args: {
  after: string;
  upTo: string;
  revisions: SourceRead<Revision>;
  deploys: SourceRead<Deploy>;
}): Attribution {
  const { revisions, deploys } = args;
  const revs =
    revisions.state === "read"
      ? revisions.items
          .filter((r) => inWindow(r.time, args.after, args.upTo))
          .sort((a, b) => a.time.localeCompare(b.time))
      : [];
  const all =
    deploys.state === "read"
      ? [...deploys.items].sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      : [];
  const deps = all.filter((d) => inWindow(d.createdAt, args.after, args.upTo));
  // The deploy live at the earlier run is the base of the commit range.
  const base = [...all].reverse().find((d) => d.createdAt <= args.after && d.commit !== undefined);
  const last = [...deps].reverse().find((d) => d.commit !== undefined);
  const commitRange =
    base?.commit && last?.commit ? `${short(base.commit)}..${short(last.commit)}` : undefined;

  const editsSaid =
    revisions.state === "read"
      ? EDITS.read
      : revisions.state === "not-configured"
        ? EDITS.none
        : EDITS.failed(revisions.reason);
  const deploysSaid =
    deploys.state === "read"
      ? DEPLOYS.read
      : deploys.state === "not-configured"
        ? DEPLOYS.none
        : DEPLOYS.failed(deploys.reason);

  const editsBlocked = revisions.state === "could-not-check";
  let label: ChangeLabel;
  let reasons: string[] = [];
  if (revs.length > 0 && deps.length > 0) label = "both";
  else if (revs.length > 0) label = "content-edit";
  else if (deps.length > 0 && !editsBlocked) label = "code-deploy";
  else {
    label = "unknown";
    reasons =
      deps.length > 0
        ? [editsSaid, "a deploy shipped in that time, but a content edit is not ruled out"]
        : [editsSaid, deploysSaid];
  }
  const notChecked: string[] = [];
  if (label !== "unknown") {
    if (revisions.state !== "read" && label !== "content-edit" && label !== "both")
      notChecked.push(editsSaid);
    if (deploys.state !== "read" && label !== "code-deploy" && label !== "both")
      notChecked.push(deploysSaid);
  }
  return {
    label,
    revisions: revs,
    deploys: deps,
    ...(commitRange ? { commitRange } : {}),
    reasons,
    notChecked,
  };
}
