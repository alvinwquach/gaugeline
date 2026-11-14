/**
 * Fixer 3 (PERF-04): the speed causes a framework leaves behind, as proposals. A proposal is a diff against a
 * file in the project, made only where the change is certain; where it is not, the fixer says why and makes no
 * proposal, as the other two do. It reads the finding's evidence and the project's files, and writes nothing:
 * a person reads the diff, and the approved step of ADR-0010 may turn it into a draft pull request.
 *
 * Certain today: the first large image (perf-lcp-image). Its `<img>` tag is found in exactly one file by the end
 * of its src, and the change is two attribute edits on that tag: `loading="lazy"` removed, and
 * `fetchpriority="high"` added (`fetchPriority` in JSX). Left to a person, with the reason: the oversized width
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
import type { RepoFile } from "./redirect.js";

const refuse = (refused: string): Refusal => ({ refused });

/** Folders a file is never taken from, and the files whose text can hold an img tag. */
const SKIPPED = /(^|\/)(node_modules|\.git|dist|build|out|\.next|\.vercel|\.netlify)\//;
const SOURCE = /\.(html?|[cm]?[jt]sx|astro|vue|svelte|mdx?|php|liquid|njk|hbs)$/i;
const JSX = /\.[cm]?[jt]sx$/i;

const TAG = /<img\b[^>]*>/gi;
const SRC = /\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)')/i;

export interface ImageTag {
  /** Where the tag starts in the file's text. */
  index: number;
  text: string;
}

/** The `<img>` tags of `text` whose src (without its query string) ends with `pathname`. */
export function imageTags(text: string, pathname: string): ImageTag[] {
  const out: ImageTag[] = [];
  if (!pathname.startsWith("/")) return out;
  for (const m of text.slice(0, 1_000_000).matchAll(TAG)) {
    const src = SRC.exec(m[0]);
    const value = (src?.[1] ?? src?.[2] ?? "").split(/[?#]/)[0] ?? "";
    if (value.endsWith(pathname)) out.push({ index: m.index ?? 0, text: m[0] });
  }
  return out;
}

const LOADING = /\sloading\s*=\s*(?:"([^"]*)"|'([^']*)'|(\{[^}]*\}))/i;
const PRIORITY = /\sfetch[Pp]riority\s*=\s*(?:"([^"]*)"|'([^']*)'|(\{[^}]*\}))/;

/**
 * The tag after the fix, or why it is not certain. `lazy` removes `loading="lazy"`; either problem then adds
 * fetchpriority high unless the tag already has it.
 */
export function fixImageTag(
  tag: string,
  problems: { lazy: boolean; late: boolean },
  jsx: boolean,
): string | Refusal {
  if (/\{\s*\.\.\./.test(tag))
    return refuse(
      "The image tag spreads props into itself, so what it loads is not written there.",
    );
  let out = tag;
  if (problems.lazy) {
    const loading = LOADING.exec(out);
    if (!loading || (loading[1] ?? loading[2])?.toLowerCase() !== "lazy")
      return refuse(
        'The image tag does not say loading="lazy" in plain text (it is set by an expression or another value), so it is left to a person.',
      );
    out = out.replace(LOADING, "");
  }
  const priority = PRIORITY.exec(out);
  if (priority) {
    const value = priority[1] ?? priority[2];
    if (value?.toLowerCase() !== "high")
      return refuse(
        "The image tag already sets a fetch priority that is not high, which a person put there on purpose.",
      );
    return out;
  }
  const name = jsx ? "fetchPriority" : "fetchpriority";
  return out.replace(/\s*(\/?)>$/, (_, slash: string) => ` ${name}="high"${slash ? " />" : ">"}`);
}

const FIRST =
  /^The first large image, (\S+), (.*?): it is probably what the page's largest paint waits for\.?$/s;

/** The address path of the image a finding names, as it is written in the project. */
function pathOf(src: string): string | undefined {
  try {
    const u = new URL(src);
    // A Next.js image address names the original in its url parameter.
    const next = u.pathname === "/_next/image" ? u.searchParams.get("url") : null;
    const path = next ? new URL(next, u.origin).pathname : u.pathname;
    return decodeURIComponent(path);
  } catch {
    return undefined;
  }
}

/** What a perf-lcp-image finding's evidence says: the image's path and which problems it names. */
export function readLcpEvidence(
  evidence: string,
): { path: string; lazy: boolean; late: boolean; width?: string } | undefined {
  const m = FIRST.exec(evidence);
  const src = m?.[1];
  const what = m?.[2] ?? "";
  const path = src === undefined ? undefined : pathOf(src);
  if (!path) return undefined;
  const width = /is asked for at (\d+) pixels wide/.exec(what)?.[1];
  return {
    path,
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
  const { path, lazy, late, width } = read;
  const out: (Proposal | Refusal)[] = [];
  const tags = files
    .filter((f) => !SKIPPED.test(f.path) && SOURCE.test(f.path))
    .flatMap((file) => imageTags(file.text, path).map((tag) => ({ file, tag })));
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
      const fixed = fixImageTag(tag.text, { lazy, late }, JSX.test(file.path));
      if (isRefusal(fixed)) out.push(fixed);
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
