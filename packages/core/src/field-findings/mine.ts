/**
 * The field-findings miner (AG-15): proposes new check candidates from review notes, as a DRAFT for a person.
 * Counting and grouping are plain code (a Map from pattern tag to the notes and lines it was seen in); no model
 * is called and the same notes always give the same draft. A pattern becomes a candidate when it recurs in at
 * least two notes and the notes give it a failing and a passing example. The draft names no note, holds no
 * check and no code. The scrub then fails the draft if any line the miner read holds a client name, an address,
 * an email or a phone number; it reports the kind and the line and never the value.
 */
import * as z from "zod";
import { sanitise } from "../untrusted.js";
import { parseNotes, isPatternTag, type NoteFinding, type ParsedNotes } from "./notes.js";
import {
  LEAK_LABEL,
  compileDenyList,
  leakKindsOnLine,
  scanForLeaks,
  type DenyList,
  type LeakKind,
} from "./scrub.js";
import { renderFieldFindingsMarkdown } from "./render.js";

/** A pattern must be seen in this many different notes to be proposed. */
export const MIN_RECURRENCE = 2;
/** Most candidates in one draft; the rest are counted. */
export const MAX_CANDIDATES = 50;
/** Most leaks a failing report lists; all are counted. */
export const MAX_LEAKS_LISTED = 50;
const NO_WORDS = "Seen in the notes with no description.";
const TEXT_MAX = 320;

const count = z.number().int().min(0);
const text = z.string().min(1).max(TEXT_MAX);
export const fieldFindingsCandidateSchema = z
  .object({
    /** The pattern's tag, which is also its id: a person names the real check. */
    pattern: z.string().refine(isPatternTag, "not a pattern tag"),
    seenIn: count,
    mentions: count,
    summary: text,
    failing: text,
    passing: text,
  })
  .strict();
/** The draft's shape. The eval harness parses a model's answer with the same schema, then the scrub. */
export const fieldFindingsDraftSchema = z
  .object({
    status: z.literal("draft"),
    notesRead: count,
    linesRead: count,
    candidates: z.array(fieldFindingsCandidateSchema).max(MAX_CANDIDATES),
    notProposed: z
      .object({
        belowThreshold: count,
        missingFixture: count,
        instructionLines: count,
        badTags: count,
        omitted: count,
      })
      .strict(),
    scrub: z.object({ ok: z.literal(true), linesChecked: count }).strict(),
  })
  .strict();
export type FieldFindingsDraft = z.infer<typeof fieldFindingsDraftSchema>;
export type FieldFindingsCandidate = FieldFindingsDraft["candidates"][number];

/** One leak in a failing report: the kind, the note and the line in it. Never the text. */
export interface ScrubLeak {
  kind: LeakKind;
  file: string;
  line: number;
}
export type MineResult =
  | { ok: true; draft: FieldFindingsDraft; markdown: string }
  | { ok: false; leaks: ScrubLeak[]; leakCount: number; linesChecked: number };

/** The most common value, ties to the one that sorts first, so no input order shows. Undefined when none. */
function commonest(values: readonly string[]): string | undefined {
  const n = new Map<string, number>();
  for (const v of values) n.set(v, (n.get(v) ?? 0) + 1);
  let best: string | undefined;
  for (const [v, c] of [...n].sort((a, b) => (a[0] < b[0] ? -1 : 1)))
    if (best === undefined || c > n.get(best)!) best = v;
  return best;
}

const snippet = (s: string): string => sanitise(s.replace(/`/g, "'"), 300).text;

/**
 * Builds the draft from parsed notes, WITHOUT the scrub: the draft a miner with no scrub would write. The eval
 * set replays it as the known-bad answer; mineFieldFindings is what runs, and it scrubs first.
 */
export function buildFieldFindingsDraft(parsed: ParsedNotes): FieldFindingsDraft {
  // A Map from tag to its findings: one pass groups, and a pattern's notes are found without a search.
  const groups = new Map<string, NoteFinding[]>();
  for (const f of parsed.findings) {
    const g = groups.get(f.tag);
    if (g) g.push(f);
    else groups.set(f.tag, [f]);
  }
  let belowThreshold = 0;
  let missingFixture = 0;
  const candidates: FieldFindingsCandidate[] = [];
  for (const [pattern, found] of groups) {
    const seenIn = new Set(found.map((f) => f.note)).size;
    if (seenIn < MIN_RECURRENCE) {
      belowThreshold += 1;
      continue;
    }
    const failing = commonest(found.flatMap((f) => (f.fail ? [snippet(f.fail.text)] : [])));
    const passing = commonest(found.flatMap((f) => (f.pass ? [snippet(f.pass.text)] : [])));
    if (!failing || !passing) {
      missingFixture += 1;
      continue;
    }
    const summary = commonest(
      found.flatMap((f) => (f.text === "" ? [] : [sanitise(f.text, 300).text])),
    );
    candidates.push({
      pattern,
      seenIn,
      mentions: found.length,
      summary: summary ?? NO_WORDS,
      failing,
      passing,
    });
  }
  // Most notes first, then most mentions, then name: a total order, so the notes' order never shows.
  candidates.sort(
    (a, b) => b.seenIn - a.seenIn || b.mentions - a.mentions || (a.pattern < b.pattern ? -1 : 1),
  );
  return {
    status: "draft",
    notesRead: parsed.notes,
    linesRead: parsed.findings.length,
    candidates: candidates.slice(0, MAX_CANDIDATES),
    notProposed: {
      belowThreshold,
      missingFixture,
      instructionLines: parsed.instructionLines,
      badTags: parsed.badTags,
      omitted: Math.max(0, candidates.length - MAX_CANDIDATES),
    },
    scrub: { ok: true, linesChecked: parsed.readLines.length },
  };
}

/** The strings of a draft that came from notes, each with the path a person can find it by. */
function draftStrings(d: FieldFindingsDraft): { path: string; text: string }[] {
  return d.candidates.flatMap((c, i) =>
    (["pattern", "summary", "failing", "passing"] as const).map((k) => ({
      path: `candidates.${i}.${k}`,
      text: c[k],
    })),
  );
}

/**
 * The scrub over a finished draft: every string that came from the notes. Returns "path: kind" problems, one per
 * leak, with no text. This is what the eval harness runs on a recorded answer, so a model that writes a client
 * name into a candidate fails the same way a careless note does.
 */
export function scanDraft(draft: FieldFindingsDraft, deny?: DenyList): string[] {
  return draftStrings(draft).flatMap(({ path, text }) =>
    scanForLeaks(text, deny).map((l) => `${path}: contains ${LEAK_LABEL[l.kind]}`),
  );
}

/**
 * Mines the notes. Throws NotesInputError (an unusable list of notes) or DenyListError (an unusable deny-list).
 * Returns the draft and its Markdown, or, when any line the miner read holds a client name, a web address, an
 * email, a domain, an IP address or a phone number, the leaks (kind, note, line) and NO draft.
 */
export function mineFieldFindings(files: unknown, opts: { denyList?: string } = {}): MineResult {
  const deny = opts.denyList === undefined ? undefined : compileDenyList(opts.denyList);
  const parsed = parseNotes(files);
  const all: ScrubLeak[] = [];
  for (const r of parsed.readLines)
    for (const kind of leakKindsOnLine(r.text, deny))
      all.push({ kind, file: r.file, line: r.line });
  if (all.length > 0)
    return {
      ok: false,
      leaks: all.slice(0, MAX_LEAKS_LISTED),
      leakCount: all.length,
      linesChecked: parsed.readLines.length,
    };
  const draft = buildFieldFindingsDraft(parsed);
  const markdown = renderFieldFindingsMarkdown(draft);
  // The backstop: the finished draft is scrubbed once more, so a change to how a draft is built cannot let a
  // leak through. It reports against the draft, as no note line is behind it.
  const late = scanDraft(draft, deny).length + scanForLeaks(markdown, deny).length;
  if (late > 0)
    return {
      ok: false,
      leaks: scanForLeaks(markdown, deny)
        .slice(0, MAX_LEAKS_LISTED)
        .map((l) => ({ kind: l.kind, file: "the draft", line: l.line })),
      leakCount: late,
      linesChecked: parsed.readLines.length,
    };
  return { ok: true, draft, markdown };
}
