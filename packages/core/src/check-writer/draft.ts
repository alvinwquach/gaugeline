/**
 * The check writer (AG-16): drafts a check, its fixtures and its registry entries from an advisory or a docs
 * page a person saved as a LOCAL file, for a person to review. The reading is plain parsing (input.ts); no model
 * is called, no address is fetched, nothing in the file is run, and the same file always gives the same draft.
 * The draft is claims: every package, affected version and fixed version (the floor) carries the line of the file
 * that states it, copied word for word. The scrub refuses the draft when a claim has no cited line, when a cited
 * line does not hold its claim or is not in the file, or when a cited line holds a client name, a private
 * address, an email, a phone number or words that give an order to an assistant. The draft edits nothing: not
 * the registry, a lock, the checks reference nor any source file.
 */
import * as z from "zod";
import { compareVersions, coreOf, parseVersion } from "../libraries/version.js";
import { PACKAGE_ADVISORIES, inRange, type Advisory } from "../libraries/advisories.js";
import { compileDenyList, type DenyList } from "../field-findings/scrub.js";
import {
  MAX_CITE_CHARS,
  MAX_FLOORS,
  MAX_NOT_UNDERSTOOD,
  MAX_TITLE_CHARS,
  NOT_UNDERSTOOD_REASONS,
  SHAPES,
  isNpmName,
  readAdvisory,
  type Claim,
  type NotUnderstood,
  type ParsedAdvisory,
} from "./input.js";
import { PROBLEM_KINDS, textProblems, type ProblemKind } from "./scrub.js";
import { renderCheckWriterMarkdown } from "./render.js";

/** How a proposed entry sits next to the registry (packages/core/src/data/library-advisories.json). */
export const REGISTRY_STATES = [
  "new-package",
  "new-advisory",
  "already-listed",
  "range-differs",
  "raises-floor",
  "same-floor",
  "below-floor",
] as const;
export type RegistryState = (typeof REGISTRY_STATES)[number];

const count = z.number().int().min(0);
const version = z.string().refine((v) => parseVersion(v) !== undefined, "not a version");
const cite = z
  .object({
    line: z.number().int().min(1),
    text: z.string().min(1, "no cited line").max(MAX_CITE_CHARS),
  })
  .strict();
const claim = <T extends z.ZodType<string>>(value: T) => z.object({ value, cite }).strict();

export const checkWriterDraftSchema = z
  .object({
    status: z.literal("draft"),
    shape: z.enum(SHAPES),
    source: z
      .object({
        title: claim(z.string().min(1).max(MAX_TITLE_CHARS)),
        url: claim(
          z
            .string()
            .regex(/^https?:\/\/\S+$/i, "not a web address")
            .max(500),
        ),
      })
      .strict(),
    /** The advisory's id. Null for a docs page, which has none. */
    advisoryId: claim(z.string().min(1).max(64)).nullable(),
    floors: z
      .array(
        z
          .object({
            package: claim(z.string().refine(isNpmName, "not an npm package name")),
            introduced: claim(version).nullable(),
            fixed: claim(version),
            registry: z.enum(REGISTRY_STATES),
            /** Invented versions for the two fixtures: one in the affected range, and the fixed version. */
            fixture: z.object({ failing: version, passing: version }).strict().nullable(),
          })
          .strict(),
      )
      .min(1)
      .max(MAX_FLOORS),
    notUnderstood: z
      .array(
        z
          .object({
            line: z.number().int().min(1).nullable(),
            reason: z.enum(NOT_UNDERSTOOD_REASONS),
          })
          .strict(),
      )
      .max(MAX_NOT_UNDERSTOOD),
    notProposed: z
      .object({ notUnderstood: count, omittedFloors: count, instructionLines: count })
      .strict(),
    scrub: z.object({ ok: z.literal(true), claimsChecked: count }).strict(),
  })
  .strict()
  .superRefine((d, ctx) => {
    for (const c of claimsOf(d))
      if (c.cite.text.trim() !== "" && !holds(c.cite.text, c.value))
        ctx.addIssue({
          code: "custom",
          path: c.path.split("."),
          message: "cited line does not hold the claim",
        });
    d.floors.forEach((f, i) => {
      if (!f.fixture) return;
      const fixed = coreOf(f.fixed.value);
      const range = {
        ...(f.introduced ? { introduced: f.introduced.value } : {}),
        fixed: f.fixed.value,
      };
      if (f.fixture.passing !== fixed || !inRange(f.fixture.failing, range))
        ctx.addIssue({
          code: "custom",
          path: ["floors", String(i), "fixture"],
          message: "fixture does not match the floor",
        });
    });
  });
export type CheckWriterDraft = z.infer<typeof checkWriterDraftSchema>;
export type CheckWriterFloor = CheckWriterDraft["floors"][number];

/** True when `cite` holds `value`: any case, spaces folded. */
const fold = (s: string): string => s.toLowerCase().replace(/\s+/g, " ");
const holds = (citeText: string, value: string): boolean => fold(citeText).includes(fold(value));

/** Every claim in a draft with the path a person can find it by. */
export function claimsOf(d: {
  source: { title: Claim; url: Claim };
  advisoryId: Claim | null;
  floors: readonly { package: Claim; introduced: Claim | null; fixed: Claim }[];
}): { path: string; value: string; cite: Claim["cite"] }[] {
  const out: { path: string; value: string; cite: Claim["cite"] }[] = [
    { path: "source.title", ...d.source.title },
    { path: "source.url", ...d.source.url },
  ];
  if (d.advisoryId) out.push({ path: "advisoryId", ...d.advisoryId });
  d.floors.forEach((f, i) => {
    out.push({ path: `floors.${i}.package`, ...f.package });
    if (f.introduced) out.push({ path: `floors.${i}.introduced`, ...f.introduced });
    out.push({ path: `floors.${i}.fixed`, ...f.fixed });
  });
  return out;
}

/** One problem a failing report lists: the kind, the claim's path and the line of the file. Never the text. */
export interface DraftProblem {
  kind: ProblemKind;
  path: string;
  line: number | null;
}

/**
 * The scrub over a finished draft: for every claim, a cited line that exists, that holds the claim and (when the
 * file's text is given) is in the file, and that holds no client name, private address, email, phone number or
 * order to an assistant. One problem per kind and claim, with no text. The eval harness runs it on a recorded
 * answer without the file; the writer runs it with the file.
 */
export function scrubCheckWriterDraft(
  draft: Parameters<typeof claimsOf>[0],
  opts: { fileText?: string; deny?: DenyList } = {},
): DraftProblem[] {
  const out: DraftProblem[] = [];
  for (const c of claimsOf(draft)) {
    const line = Number.isInteger(c.cite.line) ? c.cite.line : null;
    const add = (kind: ProblemKind): void => void out.push({ kind, path: c.path, line });
    if (c.cite.text.trim() === "") add("no-cite");
    else {
      if (!holds(c.cite.text, c.value)) add("cite-mismatch");
      if (opts.fileText !== undefined && !opts.fileText.includes(c.cite.text))
        add("cite-not-in-file");
      for (const kind of textProblems(c.cite.text, opts.deny)) add(kind);
    }
  }
  return out;
}

/** The scrub as the eval harness reads it: "path: problem" strings. */
export function scanCheckWriterDraft(
  draft: Parameters<typeof claimsOf>[0],
  deny?: DenyList,
): string[] {
  return scrubCheckWriterDraft(draft, deny ? { deny } : {}).map((p) => `${p.path}: ${p.kind}`);
}

// ---------------------------------------------------------------------------------------------------------

type Registry = Readonly<Record<string, readonly Advisory[]>>;

function registryState(
  registry: ReadonlyMap<string, readonly Advisory[]>,
  pkg: string,
  id: string | null,
  introduced: string | undefined,
  fixed: string,
): RegistryState {
  const known = registry.get(pkg);
  if (!known || known.length === 0) return "new-package";
  if (id !== null) {
    const same = known.find((a) => a.id.toLowerCase() === id.toLowerCase());
    if (!same) return "new-advisory";
    const equal = same.affects.some(
      (r) => r.fixed === fixed && (r.introduced ?? undefined) === introduced,
    );
    return equal ? "already-listed" : "range-differs";
  }
  // A docs page has no id: its floor is compared with the highest fixed version the registry lists.
  const highest = known
    .flatMap((a) => a.affects.map((r) => r.fixed))
    .filter((v): v is string => v !== null)
    .reduce<string | undefined>(
      (best, v) => (best === undefined || (compareVersions(v, best) ?? 0) > 0 ? v : best),
      undefined,
    );
  if (highest === undefined) return "new-advisory";
  const c = compareVersions(fixed, highest) ?? 0;
  return c > 0 ? "raises-floor" : c === 0 ? "same-floor" : "below-floor";
}

/**
 * Invented versions for the two fixtures: the fixed version itself, which passes, and one version inside the
 * affected range (one patch or minor release before the fixed version, or the first affected version), which
 * fails. null when the fixed version is a pre-release or no version in the range can be named.
 */
export function fixtureVersions(
  introduced: string | undefined,
  fixed: string,
): { failing: string; passing: string } | null {
  const f = parseVersion(fixed);
  if (!f || f.pre !== undefined) return null;
  const [major, minor, patch] = f.parts;
  const range = { ...(introduced === undefined ? {} : { introduced }), fixed };
  const candidates = [
    patch > 0 ? `${major}.${minor}.${patch - 1}` : "",
    minor > 0 ? `${major}.${minor - 1}.0` : "",
    major > 0 ? `${major - 1}.0.0` : "",
    introduced === undefined ? "" : (coreOf(introduced) ?? ""),
  ];
  const failing = candidates.find((c) => c !== "" && inRange(c, range));
  return failing === undefined ? null : { failing, passing: f.parts.join(".") };
}

/**
 * Builds the draft from a reading, WITHOUT the scrub: the draft a writer with no scrub would write. The eval set
 * replays it as the known-bad answer; writeCheckDraft is what runs, and it scrubs first. The reading must hold a
 * title, an address and at least one floor.
 */
export function buildCheckWriterDraft(
  parsed: ParsedAdvisory,
  registry: Registry = PACKAGE_ADVISORIES,
): CheckWriterDraft {
  if (!parsed.shape || !parsed.title || !parsed.url || parsed.floors.length === 0)
    throw new Error("The reading has no title, address or floor to build a draft from.");
  const known = new Map(Object.entries(registry));
  const id = parsed.id?.value ?? null;
  const draft: CheckWriterDraft = {
    status: "draft",
    shape: parsed.shape,
    source: { title: parsed.title, url: parsed.url },
    advisoryId: parsed.id,
    floors: parsed.floors.map((f) => ({
      package: f.package,
      introduced: f.introduced,
      fixed: f.fixed,
      registry: registryState(
        known,
        f.package.value,
        parsed.shape === "docs-markdown" ? null : id,
        f.introduced?.value,
        f.fixed.value,
      ),
      fixture: fixtureVersions(f.introduced?.value, f.fixed.value),
    })),
    notUnderstood: parsed.notUnderstood,
    notProposed: {
      notUnderstood: parsed.notUnderstoodCount,
      omittedFloors: parsed.omittedFloors,
      instructionLines: parsed.instructionLines,
    },
    scrub: { ok: true, claimsChecked: 0 },
  };
  draft.scrub.claimsChecked = claimsOf(draft).length;
  return draft;
}

export type WriteResult =
  | { ok: true; draft: CheckWriterDraft; markdown: string }
  | {
      ok: false;
      reason: "refused";
      problems: DraftProblem[];
      problemCount: number;
      claimsChecked: number;
    }
  | {
      ok: false;
      reason: "not-understood";
      notUnderstood: NotUnderstood[];
      notUnderstoodCount: number;
      instructionLines: number;
    };
/** Most problems a failing report lists; all are counted. */
export const MAX_PROBLEMS_LISTED = 50;

/**
 * Drafts from one file. Throws AdvisoryInputError (a file that cannot be read at all) or DenyListError (an
 * unusable deny-list). Returns the draft and its Markdown; or `refused` with the problems (kind, claim, line)
 * and NO draft; or `not-understood` with what was not read and NO draft. `registry` is for tests.
 */
export function writeCheckDraft(
  file: unknown,
  opts: { denyList?: string; registry?: Registry } = {},
): WriteResult {
  const deny = opts.denyList === undefined ? undefined : compileDenyList(opts.denyList);
  const parsed = readAdvisory(file);
  if (!parsed.shape || !parsed.title || !parsed.url || parsed.floors.length === 0)
    return {
      ok: false,
      reason: "not-understood",
      notUnderstood: parsed.notUnderstood,
      notUnderstoodCount: parsed.notUnderstoodCount,
      instructionLines: parsed.instructionLines,
    };
  const draft = buildCheckWriterDraft(parsed, opts.registry);
  const problems = scrubCheckWriterDraft(draft, {
    fileText: parsed.text,
    ...(deny ? { deny } : {}),
  });
  // The schema is the backstop: a change to how a draft is built cannot let a malformed one through.
  const shape = checkWriterDraftSchema.safeParse(draft);
  if (!shape.success)
    for (const i of shape.error.issues)
      problems.push({
        kind: i.message === "no cited line" ? "no-cite" : "cite-mismatch",
        path: i.path.join("."),
        line: null,
      });
  if (problems.length > 0)
    return {
      ok: false,
      reason: "refused",
      problems: problems.slice(0, MAX_PROBLEMS_LISTED),
      problemCount: problems.length,
      claimsChecked: draft.scrub.claimsChecked,
    };
  return { ok: true, draft, markdown: renderCheckWriterMarkdown(draft) };
}

export { PROBLEM_KINDS };
