import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { adaptersConfigSchema } from "../config.js";
import { GIT_CONTENT_LIMITS } from "../git-content-source-read.js";
import { JEKYLL_STYLES, PERMALINK_TOKENS } from "../shared/permalink.js";
import { BUILT_ADAPTERS } from "../registry.js";
import { CONTENT_MARKERS } from "./git-content-fixture.js";
import {
  LANTERN_SETTINGS,
  NETTLE_SETTINGS,
  lanternReads,
  nettleReads,
} from "./git-content-docs-example.js";

const root = new URL("../../../../../", import.meta.url);
const read = (path: string): string =>
  readFileSync(fileURLToPath(new URL(path, root)), "utf8").replace(/\r\n/g, "\n");
const page = read("docs/integrations/git-content.md");
const index = read("docs/integrations/index.md");

const block = (lang: string, title: string): string[] =>
  [
    ...page.matchAll(new RegExp("```" + lang + " title=" + title + "\\n([\\s\\S]*?)\\n```", "g")),
  ].map((m) => m[1] ?? "");

/** The rows of the table that starts with this header cell: trimmed cells, header and rule left out. */
function rows(md: string, firstHeader: string): string[][] {
  const lines = md.split("\n");
  const start = lines.findIndex((l) => l.startsWith(`| ${firstHeader}`));
  const out: string[][] = [];
  for (let i = start + 2; i < lines.length && lines[i]?.startsWith("|"); i++)
    out.push(
      (lines[i] ?? "")
        .split("|")
        .slice(1, -1)
        .map((c) => c.trim()),
    );
  return out;
}

describe("docs/integrations/git-content.md", () => {
  const built = BUILT_ADAPTERS.get("git-content");

  it("says first that a folder needs no key and GitHub takes one token with Contents: read, and names the variable", () => {
    const top = page.split("## ")[0] ?? "";
    expect(top).toContain("needs no key at all");
    expect(top).toContain("**Contents: read**");
    expect(top).toContain("`GAUGELINE_GITHUB_TOKEN`");
    expect(top).toContain("`api.github.com` only");
    expect(top).toContain(`\`${built?.describe.keyKind}\``);
  });

  it("is honest that the platform's pages were not read, and marks the citation [docs]", () => {
    expect(page).toContain("were not read while this page was written");
    expect(page).toContain("[docs]");
  });

  it("the settings it shows are valid and are the ones the examples read with", () => {
    const shown = block("json", "gaugeline\\.adapters\\.json");
    expect(shown).toHaveLength(2);
    expect(adaptersConfigSchema.parse(JSON.parse(shown[0] ?? "null"))).toEqual({
      adapters: [NETTLE_SETTINGS],
    });
    expect(adaptersConfigSchema.parse(JSON.parse(shown[1] ?? "null"))).toEqual({
      adapters: [LANTERN_SETTINGS],
    });
  });

  it("the reads it shows are what the adapter reads", async () => {
    const outputs = block("json", "Output");
    expect(outputs).toEqual([await nettleReads(), await lanternReads()]);
  });

  it("shows no text from the content", () => {
    for (const marker of Object.values(CONTENT_MARKERS)) expect(page).not.toContain(marker);
  });

  it("lists every token the code has, in the same order, and every Jekyll style", () => {
    const named = rows(page, "Token").map((r) => r[0]);
    expect(named).toEqual(Object.keys(PERMALINK_TOKENS).map((t) => `\`${t}\``));
    for (const [token, meaning] of Object.entries(PERMALINK_TOKENS))
      expect(rows(page, "Token").find((r) => r[0] === `\`${token}\``)?.[1]).toBe(meaning);
    for (const [name, pattern] of Object.entries(JEKYLL_STYLES))
      expect(page).toContain(`\`${name}\` is \`${pattern}\``);
  });

  it("lists the two endpoints it uses and the bounds it keeps", () => {
    expect(page).toContain("GET /repos/{owner}/{repo}/git/trees/{ref}?recursive=1");
    expect(page).toContain("GET /repos/{owner}/{repo}/git/blobs/{sha}");
    const n = (v: number) => v.toLocaleString("en-US");
    expect(rows(page, "Limit").map((r) => r[1])).toEqual([
      n(GIT_CONTENT_LIMITS.files),
      n(GIT_CONTENT_LIMITS.githubFiles),
      n(GIT_CONTENT_LIMITS.githubFilesAnonymous),
      "1 MiB",
      n(GIT_CONTENT_LIMITS.depth),
    ]);
    expect(GIT_CONTENT_LIMITS.fileBytes).toBe(1024 * 1024);
  });

  it("its settings table matches the settings the schema takes for this adapter", () => {
    const fields = rows(page, "`gaugeline.adapters.json` field").map((r) => r[0] ?? "");
    expect(fields).toEqual([
      "`adapters[].id`",
      "`adapters[].path`",
      "`adapters[].github`",
      "`adapters[].folders`",
      "`adapters[].fingerprint`",
    ]);
  });

  it("is linked from the content systems page, as built, with the same name the registry has", () => {
    const row = rows(index, "Content system").find((r) => r[0] === built?.describe.name);
    expect(row?.[1]).toBe("built");
    expect(row?.[2]).toContain("read-only");
    expect(row?.[3]).toContain("/docs/integrations/git-content");
  });
});
