/**
 * The draft as Markdown (AG-16): plain text a person reads, edits and decides on. A pure function of the draft:
 * no clock, no network. Every word that came from the file is escaped (its text is data, never a heading, a link
 * or a table) and every quoted line sits in a code span that its own text cannot close. The draft proposes
 * registry entries and fixtures as TEXT: nothing is applied, and a person adopts what they accept.
 */
import { forMarkdown } from "../untrusted-output.js";
import type { CheckWriterDraft, CheckWriterFloor, RegistryState } from "./draft.js";
import { NOT_UNDERSTOOD_WORDS, type Shape } from "./input.js";

const MAX_TITLE = 200;
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const code = (s: string) => `\`${s.replace(/`/g, "'")}\``;
const fenced = (lang: string, body: string): string[] => [
  `\`\`\`${lang}`,
  body.replace(/`/g, "'"),
  "```",
];
/** JSON for a fenced block: a backtick in a string is written as an escape, so it cannot close the fence. */
const json = (v: unknown): string => JSON.stringify(v, null, 2).replace(/`/g, "\\u0060");

const SHAPE_WORDS: Readonly<Record<Shape, string>> = {
  "osv-json": "an OSV-style JSON advisory",
  "github-json": "a GitHub-style JSON advisory",
  "advisory-markdown": "an advisory page saved as Markdown",
  "docs-markdown": "a docs page saved as Markdown",
};
const STATE_WORDS: Readonly<Record<RegistryState, string>> = {
  "new-package":
    "the registry lists no advisory for this package; adding one also means adding the package to the registry's closed list of packages and writing its check",
  "new-advisory": "the registry has this package but not this advisory",
  "already-listed": "the registry already lists this advisory with this range",
  "range-differs": "the registry lists this advisory with a different range: compare them",
  "raises-floor": "the page's floor is higher than any fixed version the registry lists",
  "same-floor": "the page's floor equals the highest fixed version the registry lists",
  "below-floor": "the page's floor is lower than a fixed version the registry already lists",
};

const slug = (pkg: string): string =>
  pkg
    .replace(/^@/, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
const cited = (label: string, c: { value: string; cite: { line: number; text: string } }): string =>
  `- ${label}: ${code(c.value)}. Line ${c.cite.line}: ${code(c.cite.text)}`;

function lockfile(pkg: string, version: string): string {
  const spec = `^${version}`;
  return json({
    name: "fixture-site",
    lockfileVersion: 3,
    requires: true,
    packages: {
      "": { name: "fixture-site", dependencies: { [pkg]: spec } },
      [`node_modules/${pkg}`]: { version },
    },
  });
}
const manifest = (pkg: string, version: string): string =>
  json({ name: "fixture-site", private: true, dependencies: { [pkg]: `^${version}` } });

function floorSection(d: CheckWriterDraft, f: CheckWriterFloor, n: number): string[] {
  const pkg = f.package.value;
  const lines = [
    "",
    `## Floor ${n}: ${pkg}, fixed in ${f.fixed.value}`,
    "",
    cited("Package", f.package),
    ...(f.introduced ? [cited("First affected version", f.introduced)] : []),
    cited(f.introduced ? "Fixed in (the floor)" : "Floor: this version or later", f.fixed),
    `- Registry: ${STATE_WORDS[f.registry]}.`,
    "",
    "### Proposed registry entry (DRAFT, not applied)",
    "",
    `For \`packages/core/src/data/library-advisories.json\`, under the package ${code(pkg)}. It is not applied. \`verified\` stays false until a person has compared the entry with its page.`,
    "",
    ...fenced(
      "json",
      json({
        package: pkg,
        advisory: {
          id: d.advisoryId?.value ?? null,
          summary:
            d.source.title.value.length <= 80
              ? d.source.title.value
              : "TODO: shorten the page title to under 80 characters",
          affects: [
            { ...(f.introduced ? { introduced: f.introduced.value } : {}), fixed: f.fixed.value },
          ],
          source: d.source.url.value,
          verified: false,
        },
      }),
    ),
  ];
  if (!d.advisoryId)
    lines.push(
      "",
      "A docs page is not an advisory: it has no CVE or GHSA id, so the id is left for a person.",
    );
  if (!f.fixture)
    lines.push(
      "",
      "No fixtures were drafted: no version inside the affected range could be named.",
    );
  else {
    lines.push(
      "",
      `### Failing fixture: ${pkg} ${f.fixture.failing} (in the affected range)`,
      "",
      "An invented site folder whose lockfile installs a version below the floor. `package.json`:",
      "",
      ...fenced("json", manifest(pkg, f.fixture.failing)),
      "",
      "`package-lock.json`:",
      "",
      ...fenced("json", lockfile(pkg, f.fixture.failing)),
      "",
      `### Passing fixture: ${pkg} ${f.fixture.passing} (the floor)`,
      "",
      "The same folder with the lockfile at the floor. `package.json`:",
      "",
      ...fenced("json", manifest(pkg, f.fixture.passing)),
      "",
      "`package-lock.json`:",
      "",
      ...fenced("json", lockfile(pkg, f.fixture.passing)),
    );
  }
  lines.push(
    "",
    "### Check outline",
    "",
    `- Id: ${code(`${slug(pkg)}-version-advisory`)}`,
    `- Title: ${code(`The installed ${pkg} version has a published security advisory`)}`,
    `- What: the version of ${code(pkg)} that the lockfile installs is below ${f.fixed.value}${d.advisoryId ? `, the version that fixes ${code(d.advisoryId.value)}` : ", the minimum the page states"}.`,
    `- Why: a person writes this. The source's own title is: ${forMarkdown(d.source.title.value, MAX_TITLE)}`,
    `- Fix: update ${code(pkg)} to ${f.fixed.value} or later and commit the lockfile.`,
    "- Technical line: static, reads package.json and the lockfile as text and makes no request; the installed version is the lockfile's, never the range in package.json.",
  );
  return lines;
}
export function renderCheckWriterMarkdown(d: CheckWriterDraft): string {
  const lines = [
    "# Check draft (DRAFT)",
    "",
    "A person reviews this draft. Nothing here is applied: no check, registry entry, lock, checks reference or source file was edited, no address in the file was fetched, no model was called and nothing was sent anywhere. Every claim below carries the line of the file that states it, copied word for word; a claim with no cited line is refused.",
    "",
    `Read ${SHAPE_WORDS[d.shape]}. The scrub checked ${plural(d.scrub.claimsChecked, "cited line", "cited lines")} and found no client name, private address, email, phone number or order to an assistant.`,
    "",
    "## Source",
    "",
    `- Title: ${forMarkdown(d.source.title.value, MAX_TITLE)} (line ${d.source.title.cite.line})`,
    `- Address, as given in the file: ${code(d.source.url.value)} (line ${d.source.url.cite.line})`,
    ...(d.advisoryId
      ? [`- Advisory: ${code(d.advisoryId.value)} (line ${d.advisoryId.cite.line})`]
      : ["- Advisory id: none (a docs page)"]),
  ];
  d.floors.forEach((f, i) => lines.push(...floorSection(d, f, i + 1)));
  const n = d.notProposed;
  const left = [
    ...d.notUnderstood.map(
      (u) =>
        `${u.line === null ? "The file" : `Line ${u.line}`}: ${NOT_UNDERSTOOD_WORDS[u.reason]}.`,
    ),
    n.notUnderstood > d.notUnderstood.length
      ? `${plural(n.notUnderstood - d.notUnderstood.length, "more entry", "more entries")} not listed.`
      : "",
    n.omittedFloors > 0
      ? `${plural(n.omittedFloors, "more floor", "more floors")} left out to keep the draft short.`
      : "",
    n.instructionLines > 0
      ? `${plural(n.instructionLines, "line", "lines")} that gave an order to an assistant, ignored and never copied.`
      : "",
  ].filter((x) => x !== "");
  if (left.length > 0)
    lines.push("", "## Not understood or not used", "", ...left.map((x) => `- ${x}`));
  lines.push(
    "",
    "Nothing here is final: a person decides what becomes a check or a registry entry.",
  );
  return `${lines.join("\n")}\n`;
}
