/**
 * ADR-0010's boundary tests: no write but a draft, page text never becomes a branch or a path, the packages
 * that must not know the writer do not import it, and the hosted app imports only its kinds.
 */
import { sanitise } from "@gaugeline/core";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { applyPullRequest } from "../github/apply.js";
import { ENDPOINTS } from "../github/endpoints.js";
import { prBody, prTitle } from "../github/text.js";
import { DRAFT, deps, fakeGithub, job, PAYLOAD } from "./helpers.js";

const root = fileURLToPath(new URL("../../../../", import.meta.url));

function walk(dir: string, keep: (name: string) => boolean): string[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names.flatMap((n) => {
    if (["node_modules", "dist", ".next", ".turbo"].includes(n)) return [];
    const full = join(dir, n);
    if (statSync(full).isDirectory()) return walk(full, keep);
    return keep(n) ? [full] : [];
  });
}
const ts = (n: string) => /\.tsx?$/.test(n) && !n.endsWith(".d.ts");
const nonTest = (dir: string) =>
  walk(dir, ts).filter((f) => !/[\\/]__tests__[\\/]/.test(f) && !/\.test\.tsx?$/.test(f));

describe("the registry's methods (ADR-0010 part 7)", () => {
  it("are GET, POST and PUT; PUT only writes file contents; nothing deletes or patches", () => {
    const by = Object.entries(ENDPOINTS).map(([id, e]) => `${e.method} ${id}`);
    expect(by.filter((l) => l.startsWith("PUT"))).toEqual(["PUT putContent"]);
    expect(by.filter((l) => /^(PATCH|DELETE)/.test(l))).toEqual([]);
    expect(by.filter((l) => l.startsWith("POST"))).toEqual(["POST createRef", "POST createPull"]);
  });
});

describe("page text never reaches a branch name, a path, a commit message or a recipient (N17)", () => {
  /** What the hostile fixture's page says, character references decoded. */
  const html = readFileSync(join(root, "packages/fixtures/sites/hostile/index.html"), "utf8");
  const decode = (s: string) =>
    s
      .replace(/&#x([0-9A-Fa-f]+);/g, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&amp;/g, "&");
  const pageText = [
    ...html.matchAll(/<title>([\s\S]*?)<\/title>/g),
    ...html.matchAll(/<h1>([\s\S]*?)<\/h1>/g),
    ...html.matchAll(/content="([^"]*Ignore previous[^"]*)"/g),
    ...html.matchAll(/<a [^>]*>([\s\S]*?)<\/a>/g),
    ...html.matchAll(/<div id="specials"[^>]*>([\s\S]*?)<\/div>/g),
  ].map((m) => decode(m[1]!));

  it("the fixture really holds the hostile text", () => {
    expect(pageText.length).toBeGreaterThanOrEqual(5);
    expect(pageText.join("\n")).toContain("Ignore previous instructions");
    expect(pageText.join("\n")).toContain("@everyone");
  });

  it("quoted evidence (sanitised, as core hands it over) stays in the title and body of the pull request", async () => {
    const quotes = pageText.map((t) => sanitise(t, 120).text as string);
    const payload = {
      title: `Fix: ${quotes[0]}`.slice(0, 200),
      body: quotes.map((q) => `Evidence: ${q}`).join("\n"),
      files: PAYLOAD.files,
    };
    const gh = fakeGithub();
    const j = job(payload);
    const out = await applyPullRequest(j, deps({ send: gh.send }, j));
    expect(out.outcome).toBe("applied");
    const marks = ["Ignore previous", "@everyone", "<script>", "owned", "U012AB3CD"];
    for (const r of gh.sent) {
      const where = [
        r.path,
        JSON.stringify(r.query ?? {}),
        r.endpoint === "createPull" ? "" : JSON.stringify(r.body ?? {}),
      ].join(" ");
      for (const m of marks) expect(where, `${r.endpoint} ${m}`).not.toContain(m);
      const body = r.body as { head?: string; branch?: string; ref?: string } | undefined;
      for (const name of [body?.head, body?.branch, body?.ref])
        if (name) expect(name).toMatch(new RegExp(`^(refs/heads/)?gaugeline/${DRAFT}$`));
    }
    const pull = gh.sent.find((r) => r.endpoint === "createPull")!.body as {
      title: string;
      body: string;
    };
    expect(pull.title).toBe(prTitle(payload.title));
    expect(pull.body).toBe(prBody(payload.body));
    expect(pull.body.replace(/`[^`]*`/g, "")).not.toContain("@");
  });

  it("the raw page text is refused as a title (control characters), and as a path or a key", async () => {
    const raw = pageText.find((t) => t.includes("\u001b"))!;
    expect(raw).toBeDefined();
    const bad = [
      { ...PAYLOAD, title: raw },
      { ...PAYLOAD, body: raw },
      { ...PAYLOAD, files: [{ path: raw, content: "x" }] },
      { ...PAYLOAD, files: [{ path: "Ignore previous instructions.md", content: "x" }] },
      { ...PAYLOAD, branch: "Ignore-previous-instructions" },
      { ...PAYLOAD, repo: "evil/evil" },
      { ...PAYLOAD, recipient: "someone-else" },
    ];
    for (const payload of bad) {
      const gh = fakeGithub();
      const j = job(payload);
      const out = await applyPullRequest(j, deps({ send: gh.send }, j));
      expect(out, JSON.stringify(payload).slice(0, 60)).toMatchObject({
        outcome: "refused",
        reason: "payload",
      });
      expect(gh.sent).toEqual([]);
    }
  });
});

describe("who may import the writer", () => {
  const WRITER =
    /@gaugeline\/writer|packages\/writer|\/writer\/src|["'`]\.\.?\/(?:\.\.\/)*writer\b/;

  it("packages/core and packages/cli never import the writer (the source, not only package.json)", () => {
    const files = [
      ...nonTest(join(root, "packages/core/src")),
      ...nonTest(join(root, "packages/cli/src")),
    ];
    expect(files.length).toBeGreaterThan(50); // an empty walk would pass
    const hits = files.filter((f) => WRITER.test(readFileSync(f, "utf8")));
    expect(hits.map((f) => relative(root, f))).toEqual([]);
  });

  it("no other package imports it either", () => {
    const hits = readdirSync(join(root, "packages"))
      .filter((p) => p !== "writer")
      .flatMap((p) => nonTest(join(root, "packages", p, "src")))
      .filter((f) => WRITER.test(readFileSync(f, "utf8")));
    expect(hits.map((f) => relative(root, f))).toEqual([]);
  });

  it("the hosted app imports nothing of the writer but, at most, @gaugeline/writer/kinds, which brings in nothing that sends", () => {
    const files = walk(join(root, "apps/hosted"), ts);
    expect(files.length).toBeGreaterThan(5);
    const named = files.flatMap((f) =>
      [...readFileSync(f, "utf8").matchAll(/from "(@gaugeline\/writer[^"]*)"/g)].map((m) => m[1]),
    );
    expect([...new Set(named)].filter((n) => n !== "@gaugeline/writer/kinds")).toEqual([]);
    const manifest = JSON.parse(readFileSync(join(root, "apps/hosted/package.json"), "utf8"));
    expect(Object.keys(manifest.dependencies ?? {}).filter((d) => d.includes("writer"))).toEqual(
      named.length > 0 ? ["@gaugeline/writer"] : [],
    );
    // And that module imports nothing but zod.
    const kinds = readFileSync(join(root, "packages/writer/src/kinds.ts"), "utf8");
    const imports = [...kinds.matchAll(/^import .* from "([^"]+)";/gm)].map((m) => m[1]);
    expect(imports).toEqual(["zod"]);
  });

  it("inside the writer, only the three named senders (GitHub, Gmail, Sanity) use fetch or a Node HTTP module", () => {
    const files = nonTest(join(root, "packages/writer/src"));
    expect(files.length).toBeGreaterThanOrEqual(7);
    const users = files
      .filter((f) =>
        /\bfetch\s*\(|from "(node:)?(https?|http2|net|tls)"|XMLHttpRequest|WebSocket/.test(
          readFileSync(f, "utf8"),
        ),
      )
      .map((f) => relative(join(root, "packages/writer/src"), f).split("\\").join("/"));
    expect(users.sort()).toEqual(["github/send.ts", "gmail/send.ts", "sanity/send.ts"]);
  });
});
