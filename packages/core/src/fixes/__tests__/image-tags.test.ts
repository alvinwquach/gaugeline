/**
 * The image-tag scanner (PERF-04 review): a tag is found and read one attribute at a time, never with a pattern over
 * the file. A tag with an expression, a comment around it, or any doubt is refused with a reason and no diff is made;
 * a tag of plain attributes is fixed; and the scan is linear, so a hostile file cannot stall it.
 */
import { describe, expect, it } from "vitest";
import { applyProposal, isRefusal, type Proposal } from "../index.js";
import { fixImageTag, imageTags, performanceProposals } from "../performance.js";
import { MAX_TAG, modeOf, readTag, scanImageTags } from "../image-tags.js";
import type { RepoFile } from "../redirect.js";

const SRC = "https://quillfeather.example/hero.jpg";
const LAZY = `The first large image, ${SRC}, is lazy-loaded, so the browser waits to fetch it: it is probably what the page's largest paint waits for.`;
const LATE = `The first large image, ${SRC}, is not preloaded and has no fetchpriority="high", so the browser finds it late: it is probably what the page's largest paint waits for.`;
const finding = (evidence: string) => ({
  checkId: "perf-lcp-image",
  url: "https://quillfeather.example/",
  evidence,
});
const run = (path: string, text: string, evidence = LAZY) =>
  performanceProposals([{ path, text }], finding(evidence));
const refusalOf = (out: ReturnType<typeof run>): string => {
  expect(out).toHaveLength(1);
  const [r] = out;
  if (!r || !isRefusal(r)) throw new Error(`expected a refusal, got ${JSON.stringify(out)}`);
  return r.refused;
};
const proposalOf = (out: ReturnType<typeof run>): Proposal => {
  const [p] = out;
  if (out.length !== 1 || !p || isRefusal(p))
    throw new Error(`expected a proposal: ${JSON.stringify(out)}`);
  return p;
};

describe("a tag with an expression is never patched (it used to give invalid JSX)", () => {
  it.each([
    [
      "an arrow function in an event handler",
      '<img src="/hero.jpg" onLoad={() => go()} loading="lazy" />',
    ],
    ["a > in a conditional", '<img src="/hero.jpg" loading={a > b ? "lazy" : "eager"} />'],
    ["a spread", '<img src="/hero.jpg" {...props} loading="lazy" />'],
    ["a template literal in a prop", '<img src={`/hero.jpg`} loading="lazy" />'],
    ["an object in a style", '<img src="/hero.jpg" style={{ width: 4 }} loading="lazy" />'],
  ])("%s in a .tsx file: a reason, no diff", (_n, tag) => {
    expect(refusalOf(run("src/Hero.tsx", `export const A = () => (\n  ${tag}\n);\n`))).toMatch(
      /expression|plain|certain|more than one|not found/i,
    );
  });

  it('a > inside a quoted value, in plain HTML, is refused too (onload="a=>b")', () => {
    for (const tag of [
      '<img src="/hero.jpg" onload="a=>b" loading="lazy">',
      '<img src="/hero.jpg" alt="a > b" loading="lazy">',
      "<img src='/hero.jpg' title='x<y' loading='lazy'>",
    ])
      expect(refusalOf(run("a.html", `<main>${tag}</main>`)), tag).toMatch(/< or >|certain/);
  });

  it("the reason names the problem when the tag is the one the finding is about", () => {
    const why = refusalOf(
      run("Hero.tsx", '<img src="/hero.jpg" onLoad={() => go()} loading="lazy" />'),
    );
    expect(why).toMatch(/\{ \} expression/);
  });

  it("a plain tag in the same .tsx file is still fixed, and the result is valid", () => {
    const text =
      'export const A = () => (\n  <img src="/hero.jpg" alt="Hero" loading="lazy" />\n);\n';
    const p = proposalOf(run("Hero.tsx", text));
    expect(applyProposal(text, p)).toBe(
      'export const A = () => (\n  <img src="/hero.jpg" alt="Hero" fetchPriority="high" />\n);\n',
    );
  });
});

describe("only real attributes are read", () => {
  it("does not read loading='lazy' out of an alt text: only a fetchpriority is added", () => {
    const text = `<img src="/hero.jpg" alt="x loading='lazy'" width="9">`;
    const p = proposalOf(run("a.html", text, LATE));
    expect(applyProposal(text, p)).toBe(
      `<img src="/hero.jpg" alt="x loading='lazy'" width="9" fetchpriority="high">`,
    );
    // and a lazy finding on a tag whose only "loading" is inside the alt text has nothing to remove
    expect(refusalOf(run("a.html", text, LAZY))).toMatch(/does not say loading="lazy"/);
  });

  it("does not read src out of another attribute's value", () => {
    expect(imageTags(`<img data-x="src='/hero.jpg'" alt="y">`, "/hero.jpg", "html").length).toBe(0);
  });

  it("removes only the loading attribute, in any quote style, and keeps every other byte", () => {
    for (const [loading, rest] of [
      ['loading="lazy"', ""],
      ["loading='lazy'", ""],
      ["loading=lazy", ""],
      ['LOADING="LAZY"', ""],
    ] as const) {
      const text = `<p>\n<img  src="/hero.jpg"   ${loading}  alt="a"${rest}>\n</p>`;
      const p = proposalOf(run("a.html", text));
      expect(applyProposal(text, p), loading).toBe(
        `<p>\n<img  src="/hero.jpg"  alt="a" fetchpriority="high">\n</p>`,
      );
    }
  });

  it.each([
    'fetchpriority="high"',
    'fetchpriority="low"',
    'FETCHPRIORITY="low"',
    "fetchPriority='high'",
    "FetchPriority=auto",
  ])("a tag that already has %s is left to a person, with no diff", (attr) => {
    const why = refusalOf(run("a.html", `<img src="/hero.jpg" ${attr} loading="lazy">`));
    expect(why).toMatch(/already sets a fetch priority/);
  });

  it("two loading attributes, or a loading that is not lazy, are left to a person", () => {
    expect(
      refusalOf(run("a.html", '<img src="/hero.jpg" loading="lazy" loading="eager">')),
    ).toMatch(/plain text/);
    expect(refusalOf(run("a.html", '<img src="/hero.jpg" loading="eager">'))).toMatch(/plain text/);
  });
});

describe("a tag that is only shown, or commented out, is not the page's image", () => {
  const tag = '<img src="/hero.jpg" loading="lazy" alt="Hero">';
  it.each([
    ["an HTML comment", "a.html", `<!-- ${tag} -->`],
    ["an HTML comment over lines", "a.html", `<!--\n${tag}\n-->`],
    ["a JSX comment", "A.tsx", `const a = <div>{/* ${tag} */}</div>;`],
    ["a block comment", "A.tsx", `/* ${tag} */\nconst a = 1;`],
    ["a line comment in .tsx", "A.tsx", `// ${tag}\nconst a = 1;`],
    ["a template literal in .tsx", "A.tsx", `const html = \`<main>${tag}</main>\`;`],
    [
      "a nested template literal in .tsx",
      "A.tsx",
      "const h = `a ${`<b>${1}</b>` + `" + tag + "`}`;",
    ],
    ["a string in .tsx", "A.tsx", `const html = '${tag}';`],
    ["a script body", "a.html", `<script>const t = '${tag}';</script>`],
    ["a style body", "a.html", `<style>/* ${tag} */</style>`],
    ["a pre block", "a.html", `<pre>${tag}</pre>`],
    ["a code block", "a.html", `<p><code>${tag}</code></p>`],
    ["a textarea", "a.html", `<textarea>${tag}</textarea>`],
    ["a markdown fence", "a.md", "Use:\n\n```html\n" + tag + "\n```\n"],
    ["a markdown fence at the top", "a.md", "```html\n" + tag + "\n```\n"],
    ["a markdown inline code span", "a.md", `Write \`${tag}\` for it.`],
  ])("%s: not found, so no diff", (_n, path, text) => {
    expect(refusalOf(run(path, text))).toMatch(/not found/);
  });

  it("the same tag outside the comment is still found", () => {
    const text = `<!-- ${tag} -->\n<main>${tag}</main>`;
    const found = imageTags(text, "/hero.jpg", "html");
    expect(found).toHaveLength(1);
    expect(found[0]?.index).toBe(text.indexOf("<main>") + 6);
  });

  it("a comment that is never closed hides the rest, and nothing is invented from it", () => {
    expect(refusalOf(run("a.html", `<!-- ${tag}`))).toMatch(/not found/);
  });

  it("an img after a // in a URL is still found (only a // that starts a comment is skipped)", () => {
    const text = `const u = "https://x.example/a"; const a = <img src="/hero.jpg" loading="lazy" />;`;
    expect(imageTags(text, "/hero.jpg", "jsx")).toHaveLength(1);
  });
});

describe("the tag that is meant, and only that one", () => {
  it("matches the whole src, not its ending: /cdn/x/hero.jpg is another image", () => {
    expect(refusalOf(run("a.html", '<img src="/cdn/x/hero.jpg" loading="lazy">'))).toMatch(
      /not found/,
    );
  });
  it("a relative src is not matched: where it points depends on the page", () => {
    for (const src of ["hero.jpg", "./hero.jpg", "../hero.jpg"])
      expect(refusalOf(run("a.html", `<img src="${src}" loading="lazy">`)), src).toMatch(
        /not found/,
      );
  });
  it("an address on another site is not the finding's image", () => {
    expect(
      refusalOf(run("a.html", '<img src="https://cdn.other.example/hero.jpg" loading="lazy">')),
    ).toMatch(/not found/);
  });
  it("an address on the finding's own site is", () => {
    const text = '<img src="https://quillfeather.example/hero.jpg" loading="lazy">';
    expect(proposalOf(run("a.html", text)).target.path).toBe("a.html");
  });
  it("a custom element whose name starts with img is not an img", () => {
    expect(
      refusalOf(run("a.html", '<img-zoom src="/hero.jpg" loading="lazy"></img-zoom>')),
    ).toMatch(/not found/);
    expect(imageTags('<imgx src="/hero.jpg">', "/hero.jpg")).toHaveLength(0);
  });
  it("a component named Img or IMG in JSX is not the DOM img, and <IMG> in HTML is", () => {
    expect(imageTags('<Img src="/hero.jpg" />', "/hero.jpg", "jsx")).toHaveLength(0);
    expect(imageTags('<IMG SRC="/hero.jpg">', "/hero.jpg", "html")).toHaveLength(1);
  });
  it("two src attributes, or a src that is an expression, are not a certain match", () => {
    expect(imageTags('<img src={x} alt="y">', "/hero.jpg")).toHaveLength(0);
    const two = imageTags('<img src="/hero.jpg" src="/other.jpg">', "/hero.jpg");
    expect(two[0]?.refusal).toMatch(/more than one src/);
  });
});

describe("readTag: the end of the tag is found by reading, not by the first >", () => {
  const end = (t: string) => {
    const r = readTag(t, 0);
    return r.ok ? t.slice(0, r.tag.end) : r.reason;
  };
  it("stops at the real end of a plain tag, however its attributes are quoted", () => {
    expect(end('<img src="/a.jpg" alt=\'a "b" c\' data-x=y>rest')).toBe(
      '<img src="/a.jpg" alt=\'a "b" c\' data-x=y>',
    );
    expect(end('<img src="/a.jpg"/>rest')).toBe('<img src="/a.jpg"/>');
    expect(end('<img\n  src="/a.jpg"\n  hidden\n/>')).toContain("hidden");
  });
  it.each([
    ['<img src="/a.jpg" onload={() => go()}>', /expression/],
    ['<img src="/a.jpg" alt="{{ x }}">', /expression/],
    ['<img src="/a.jpg" alt="a > b">', /< or >/],
    ['<img src="/a.jpg" alt="a', /read to its end/],
    ['<img src="/a.jpg" <b>', /< or >/],
    ['<img src="/a.jpg" :alt="x">', /framework/],
    ['<img src="/a.jpg" v-if="x">', /framework/],
    ['<img src="/a.jpg" @load="x">', /framework/],
    ["<img src=/a.jpg/>", /read to its end/],
    ["<img src=a=b>", /< or >/],
    ["<img / src='/a.jpg'>", /read to its end/],
    ["<img", /read to its end/],
  ])("reads %s as not certain", (t, why) => {
    const r = readTag(t, 0);
    expect(r.ok).toBe(false);
    expect(r.ok ? "" : r.reason).toMatch(why);
  });
  it("does not read a tag longer than the limit", () => {
    const r = readTag(`<img alt="${"x".repeat(MAX_TAG)}">`, 0);
    expect(r.ok).toBe(false);
    expect(r.ok ? "" : r.reason).toMatch(/longer than/);
  });
});

describe("the scan is linear: a hostile file cannot stall it", () => {
  const time = (f: () => unknown): number => {
    const t = performance.now();
    expect(f).not.toThrow();
    return performance.now() - t;
  };
  const MB = 1_000_000;
  it.each([
    ["1 MB of <img  repeated", "<img ".repeat(MB / 5)],
    ['an unterminated <img src=" repeated', '<img src="'.repeat(MB / 10)],
    ['1 MB of <img src="/hero.jpg" with no end', '<img src="/hero.jpg" alt="' + "a".repeat(MB)],
    ["an open comment then 1 MB of tags", "<!-- " + '<img src="/hero.jpg">'.repeat(MB / 20)],
    ["nested templates and braces", "`${".repeat(MB / 3)],
    ["many quotes in code", "'\"`".repeat(MB / 3)],
    ["a million <", "<".repeat(MB)],
    ["a million </", "</".repeat(MB / 2)],
    ["script opens that never close", "<script>".repeat(MB / 8)],
  ])("%s takes well under a second, in every mode", (_n, text) => {
    for (const mode of ["html", "jsx", "hybrid", "markdown"] as const) {
      expect(
        time(() => scanImageTags(text, mode)),
        mode,
      ).toBeLessThan(1_000);
      expect(
        time(() => imageTags(text, "/hero.jpg", mode, "https://x.example")),
        mode,
      ).toBeLessThan(1_000);
    }
  });
  it("10 MB of <img  is cut at 1 MB and still takes well under a second", () => {
    const text = "<img ".repeat(2_000_000);
    expect(text.length).toBe(10_000_000);
    expect(time(() => imageTags(text, "/hero.jpg"))).toBeLessThan(1_000);
    expect(
      time(() => performanceProposals([{ path: "a.html", text }], finding(LAZY))),
    ).toBeLessThan(1_000);
  });
  it("only the first megabyte is read: a tag after it is not found", () => {
    const text = " ".repeat(1_000_000) + '<img src="/hero.jpg">';
    expect(imageTags(text, "/hero.jpg")).toHaveLength(0);
    const near = " ".repeat(999_000) + '<img src="/hero.jpg">';
    expect(imageTags(near, "/hero.jpg")).toHaveLength(1);
  });
  it("the scanner itself stops at the first megabyte, whoever calls it", () => {
    const text = " ".repeat(1_000_000) + '<img src="/hero.jpg">';
    expect(scanImageTags(text, "html")).toHaveLength(0);
    expect(scanImageTags(" ".repeat(999_000) + '<img src="/hero.jpg">', "html")).toHaveLength(1);
  });
  it("unreadable tags that name the image are returned with a reason, without a scan per tag", () => {
    const text = '<img src="/hero.jpg" onload={() => 1}>'.repeat(20_000);
    expect(time(() => imageTags(text, "/hero.jpg", "jsx"))).toBeLessThan(1_000);
  });
});

describe("modeOf: how a file is read, from its name", () => {
  it.each([
    ["a.html", "html"],
    ["a.php", "html"],
    ["a.tsx", "jsx"],
    ["a.jsx", "jsx"],
    ["a.mjsx", "jsx"],
    ["a.vue", "hybrid"],
    ["a.astro", "hybrid"],
    ["a.svelte", "hybrid"],
    ["a.md", "markdown"],
    ["a.mdx", "markdown"],
  ])("%s is %s", (path, mode) => expect(modeOf(path)).toBe(mode));
});

describe("fixImageTag on the text of a whole tag only", () => {
  it("refuses text that is more or less than one tag", () => {
    for (const t of ['<img src="/a.jpg"> trailing', '<img src="/a.jpg"', "x"])
      expect(isRefusal(fixImageTag(t, { lazy: false, late: true }, false)), t).toBe(true);
  });
  it("keeps a multi-line tag's layout and puts the attribute after the last one", () => {
    expect(
      fixImageTag('<img\n  src="/a.jpg"\n  alt="x"\n/>', { lazy: false, late: true }, false),
    ).toBe('<img\n  src="/a.jpg"\n  alt="x" fetchpriority="high"\n/>');
  });
  it("fixes a tag with no attributes but the lazy one", () => {
    expect(fixImageTag('<img loading="lazy">', { lazy: true, late: false }, false)).toBe(
      '<img fetchpriority="high">',
    );
  });
});

const _unused: RepoFile[] = [];
void _unused;
