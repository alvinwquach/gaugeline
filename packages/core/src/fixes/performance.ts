/**
 * Fixer 3 (PERF-04): the speed causes a framework leaves behind, as proposals. A proposal is a diff against a
 * file in the project, made only where the change is certain; where it is not, the fixer says why and makes no
 * proposal, as the other two do. It reads the finding's evidence and the project's files, and writes nothing:
 * a person reads the diff, and the approved step of ADR-0010 may turn it into a draft pull request.
 *
 * Certain today: the first large image (perf-lcp-image). Its `<img>` tag is found in exactly one file by its whole
 * src (the same path, on the site's own address), read by a scanner and not a pattern (image-tags.ts), and the
 * change is two attribute edits on a tag made only of plain attributes: `loading="lazy"` removed, and
 * `fetchpriority="high"` added (`fetchPriority` in JSX). A tag with an expression, a comment around it, a
 * fetchpriority already there or any other doubt is left to a person, with the reason. Left to a person, with the reason: the oversized width
 * (it comes from an address or an image component's settings), a 3D scene that starts at load, an animation that
 * moves layout, and a missing low-end fallback (each needs a design choice no patch can make for every site).
 */
import {
  buildProposal,
  isRefusal,
  type FileChange,
  type Proposal,
  type Refusal,
} from "./proposal.js";
import { MAX_SCANNED, modeOf, readTag, scanImageTags, type ScanMode } from "./image-tags.js";
import { editGate } from "./edit-gate.js";
import type { RepoFile } from "./redirect.js";

const refuse = (refused: string): Refusal => ({ refused });

/** Folders a file is never taken from, and the files whose text can hold an img tag. */
const SKIPPED = /(^|\/)(node_modules|\.git|dist|build|out|\.next|\.vercel|\.netlify)\//;
const SOURCE = /\.(html?|[cm]?[jt]sx|astro|vue|svelte|mdx?|php|liquid|njk|hbs)$/i;
const JSX = /\.[cm]?[jt]sx$/i;

export interface ImageTag {
  /** Where the tag starts in the file's text. */
  index: number;
  text: string;
  /** Why this tag cannot be changed with certainty, when it names the image but is not plain. */
  refusal?: string;
}

/** The path (and, for an address with a host, the host) of a src, when it names `pathname` on `origin`. */
function sameImage(value: string, pathname: string, origin: string | undefined): boolean {
  let path: string;
  if (value.startsWith("/") && !value.startsWith("//")) path = value;
  else {
    if (origin === undefined) return false;
    let u: URL;
    try {
      u = new URL(value.startsWith("//") ? `https:${value}` : value);
    } catch {
      return false;
    }
    if (!/^https?:$/.test(u.protocol) || u.host !== new URL(origin).host) return false;
    path = u.pathname;
  }
  try {
    return decodeURIComponent(path.split(/[?#]/)[0] ?? "") === pathname;
  } catch {
    return false;
  }
}

/**
 * The `<img>` tags of `text` that name the image at `pathname` (on `origin`): the whole src has to be that path,
 * written root-relative or as an address on the site's own host, never merely ending the same way. A tag the
 * scanner cannot read with certainty but that writes the path inside it is returned with its `refusal`.
 */
export function imageTags(
  text: string,
  pathname: string,
  mode: ScanMode = "html",
  origin?: string,
): ImageTag[] {
  const out: ImageTag[] = [];
  if (!pathname.startsWith("/")) return out;
  const capped = text.length > MAX_SCANNED ? text.slice(0, MAX_SCANNED) : text;
  let nextPath = capped.indexOf(pathname);
  for (const found of scanImageTags(capped, mode)) {
    if (found.read.ok) {
      const srcs = found.read.tag.attributes.filter((a) => a.name.toLowerCase() === "src");
      const names = srcs.some((a) => a.value !== null && sameImage(a.value, pathname, origin));
      if (!names) continue;
      out.push({
        index: found.index,
        text: found.text,
        ...(srcs.length > 1
          ? {
              refusal:
                "The image tag has more than one src, so which one the page uses is not certain.",
            }
          : {}),
      });
    } else {
      // Unreadable: it counts if the image's path is written within its first lines, so a person is told.
      while (nextPath >= 0 && nextPath < found.index)
        nextPath = capped.indexOf(pathname, nextPath + 1);
      if (nextPath >= 0 && nextPath - found.index < 2_000)
        out.push({ index: found.index, text: found.text, refusal: found.read.reason });
    }
  }
  return out;
}

/**
 * The tag after the fix, or why it is not certain. `lazy` removes `loading="lazy"`; either problem then adds
 * fetchpriority high. The tag is read attribute by attribute, so a word that is only inside an attribute's value
 * (an alt text that says loading='lazy') is never an attribute, and a tag that already has a fetchpriority, in
 * any case and with any value, is left to a person.
 */
export function fixImageTag(
  tag: string,
  problems: { lazy: boolean; late: boolean },
  jsx: boolean,
): string | Refusal {
  const read = readTag(tag, 0);
  if (!read.ok) return refuse(read.reason);
  if (read.tag.end !== tag.length)
    return refuse("The text is not exactly one image tag, so it is left to a person.");
  const attrs = read.tag.attributes;
  const named = (name: string) => attrs.filter((a) => a.name.toLowerCase() === name);
  if (named("fetchpriority").length > 0)
    return refuse(
      "The image tag already sets a fetch priority (high or not), which a person put there on purpose, so it is left to a person.",
    );
  let out = tag;
  let lastEnd = attrs.length > 0 ? attrs[attrs.length - 1]!.end : read.tag.nameEnd;
  if (problems.lazy) {
    const loading = named("loading");
    const one = loading[0];
    if (loading.length !== 1 || one === undefined || one.value?.toLowerCase() !== "lazy")
      return refuse(
        'The image tag does not say loading="lazy" in plain text (it is set by an expression, another value or twice), so it is left to a person.',
      );
    let from = one.start;
    while (from > 0 && /\s/.test(tag[from - 1] ?? "")) from--;
    out = tag.slice(0, from) + tag.slice(one.end);
    if (one === attrs[attrs.length - 1])
      lastEnd = attrs.length > 1 ? attrs[attrs.length - 2]!.end : read.tag.nameEnd;
    else lastEnd -= one.end - from;
  }
  const name = jsx ? "fetchPriority" : "fetchpriority";
  return `${out.slice(0, lastEnd)} ${name}="high"${out.slice(lastEnd)}`;
}

const FIRST =
  /^The first large image, (\S+), (.*?): it is probably what the page's largest paint waits for\.?$/s;

/** The address path of the image a finding names, as it is written in the project. */
function pathOf(src: string): { path: string; origin: string } | undefined {
  try {
    const u = new URL(src);
    // A Next.js image address names the original in its url parameter.
    const next = u.pathname === "/_next/image" ? u.searchParams.get("url") : null;
    const path = next ? new URL(next, u.origin).pathname : u.pathname;
    return { path: decodeURIComponent(path), origin: u.origin };
  } catch {
    return undefined;
  }
}

/** What a perf-lcp-image finding's evidence says: the image's path and which problems it names. */
export function readLcpEvidence(
  evidence: string,
): { path: string; origin: string; lazy: boolean; late: boolean; width?: string } | undefined {
  const m = FIRST.exec(evidence);
  const src = m?.[1];
  const what = m?.[2] ?? "";
  const where = src === undefined ? undefined : pathOf(src);
  if (!where) return undefined;
  const width = /is asked for at (\d+) pixels wide/.exec(what)?.[1];
  return {
    path: where.path,
    origin: where.origin,
    lazy: /is lazy-loaded/.test(what),
    late: /is not preloaded and has no fetchpriority/.test(what),
    ...(width === undefined ? {} : { width }),
  };
}

function lcpImage(
  files: readonly RepoFile[],
  finding: Proposal["finding"],
  repository: string | null,
): (Proposal | Refusal)[] {
  const read = readLcpEvidence(finding.evidence);
  if (!read) return [refuse("The finding names no image this fixer can read from its evidence.")];
  const { path, origin, lazy, late, width } = read;
  const out: (Proposal | Refusal)[] = [];
  const tags = files
    .filter((f) => !SKIPPED.test(f.path) && SOURCE.test(f.path))
    .flatMap((file) =>
      imageTags(file.text, path, modeOf(file.path), origin).map((tag) => ({ file, tag })),
    );
  if (lazy || late) {
    if (tags.length === 0)
      out.push(refuse(`The image ${path} was not found in an img tag of the project's files.`));
    else if (tags.length > 1)
      out.push(
        refuse(
          `The image ${path} is written in more than one place (${[...new Set(tags.map((t) => t.file.path))].join(", ")}): a person says which one the page is fed from.`,
        ),
      );
    else {
      const { file, tag } = tags[0] as (typeof tags)[number];
      const fixed =
        tag.refusal !== undefined
          ? refuse(tag.refusal)
          : fixImageTag(tag.text, { lazy, late }, JSX.test(file.path));
      const unsafe = isRefusal(fixed) ? undefined : editGate(file.text, file.path, tag.index);
      if (isRefusal(fixed)) out.push(fixed);
      else if (unsafe !== undefined) out.push(refuse(unsafe));
      else if (fixed === tag.text)
        out.push(refuse(`The image ${path} already loads with high priority in ${file.path}.`));
      else {
        const change: FileChange = {
          path: file.path,
          before: file.text,
          after: `${file.text.slice(0, tag.index)}${fixed}${file.text.slice(tag.index + tag.text.length)}`,
        };
        out.push(
          buildProposal({
            ...change,
            fixer: "performance",
            summary:
              `Load the first large image ${path} first${lazy ? " (no lazy loading)" : ""}`.slice(
                0,
                200,
              ),
            finding,
            target: { repository, path: change.path },
            recheck: {
              checkId: "perf-lcp-image",
              how: `Run gaugeline on the pull request's preview: perf-lcp-image must not report ${path}.`,
            },
          }),
        );
      }
    }
  }
  if (width !== undefined)
    out.push(
      refuse(
        `The image is asked for at ${width} pixels wide but shown smaller: the width comes from the image address or the image component's settings, which differ by site, so the change is left to a person.`,
      ),
    );
  if (out.length === 0) out.push(refuse("The evidence names no problem this fixer can change."));
  return out;
}

const LEFT_TO_A_PERSON: Record<string, string> = {
  "perf-webgl-autostart":
    "Starting a 3D scene on a tap or when it scrolls into view changes how the page is built (a start step, a still picture shown first, the library loaded only then), which no one patch can write for every site, so it is left to a person: show a still picture first and start the scene when it is asked for.",
  "perf-animation-reflow":
    "Moving an animation from position, size or margin properties to transform and opacity changes how the element is laid out, which a patch cannot know is safe, so it is left to a person: animate transform and opacity, name the properties a transition changes, and read layout before writing it in a loop.",
  "perf-no-lowend-fallback":
    "Which heavy part to skip, and what to show instead, is a design choice, so it is left to a person: read navigator.connection.saveData, navigator.deviceMemory or navigator.hardwareConcurrency before starting it and show a still picture when they say the visitor is low on data or power (the Save-Data hint).",
};

/**
 * Proposals for a speed-cause finding: one per change this fixer is certain of, and one refusal, with the reason,
 * for each part it leaves to a person. Other findings give nothing.
 */
export function performanceProposals(
  files: readonly RepoFile[],
  finding: Proposal["finding"],
  options: { repository?: string | null } = {},
): (Proposal | Refusal)[] {
  if (finding.checkId === "perf-lcp-image")
    return lcpImage(files, finding, options.repository ?? null);
  const why = LEFT_TO_A_PERSON[finding.checkId];
  return why === undefined ? [] : [refuse(why)];
}
