import { describe, expect, it } from "vitest";
import { nextSanityRemovedApi } from "../next-sanity-removed-api.js";
import { starterLicenceNoticeMissing } from "../starter-licence-notice-missing.js";
import { fixtureTree, runOne, treeOf } from "./helpers.js";

const MIT = `Copyright (c) 2026 Example\n\nPermission is hereby granted, free of charge, to any person obtaining a copy\nof this software.`;
const ISC = `Copyright (c) 2026 Example\n\nPermission to use, copy, modify, and/or distribute this software for any purpose with or without fee is hereby granted.`;
const pkg = (extra: object = {}) => JSON.stringify({ name: "site", ...extra });
const licence = (files: Record<string, string>, over = {}) =>
  runOne(starterLicenceNoticeMissing, treeOf(files, over));

describe("starter-licence-notice-missing: fixtures", () => {
  it("fails a project that declares MIT and says it is based on a starter, with no licence text", async () => {
    const out = await runOne(
      starterLicenceNoticeMissing,
      await fixtureTree("starter-licence-notice-missing", "fail"),
    );
    expect(out.passed).toEqual([]);
    expect(out.findings.map((f) => f.evidence)).toEqual([
      "package.json:4: package.json declares the MIT licence, and no file in the folder holds the MIT or ISC licence text.",
      "README.md:5: the README says the project was made from a starter or template, and no file in the folder holds the MIT or ISC licence text.",
    ]);
    expect(out.findings[0]).toMatchObject({
      checkId: "starter-licence-notice-missing",
      severity: "medium",
    });
  });

  it("passes the same project with the MIT text in LICENSE (a file with no extension)", async () => {
    const out = await runOne(
      starterLicenceNoticeMissing,
      await fixtureTree("starter-licence-notice-missing", "pass"),
    );
    expect(out.findings).toEqual([]);
    expect(out.passed).toEqual(["starter-licence-notice-missing"]);
  });

  it("is not sure when there is no notice and nothing says where the code came from", async () => {
    const out = await runOne(
      starterLicenceNoticeMissing,
      await fixtureTree("starter-licence-notice-missing", "unsure"),
    );
    expect(out.findings).toEqual([]);
    expect(out.passed).toEqual([]);
    expect(out.couldNotCheck[0]?.reason).toContain("cannot tell whether a notice was removed");
  });
});

describe("starter-licence-notice-missing: the patterns", () => {
  it.each([
    ["LICENSE", MIT],
    ["LICENSE.md", ISC],
    ["NOTICE", MIT],
    ["THIRD_PARTY_LICENSES.txt", ISC],
    ["README.md", `# Site\n\n## Licence\n\n${MIT}`],
    ["lib/vendor/button.ts", `/*\n${ISC}\n*/\nexport const x = 1;`],
  ])("finds the notice in %s, so it passes", async (file, text) => {
    const out = await licence({
      "package.json": pkg({ license: "MIT" }),
      [file]: text,
    });
    expect(out.findings).toEqual([]);
    expect(out.passed).toEqual(["starter-licence-notice-missing"]);
  });

  it("reads the license field as a string or an object, in any case, and only MIT and ISC", async () => {
    for (const license of ["mit", "ISC", { type: "MIT" }]) {
      const out = await licence({ "package.json": pkg({ license }) });
      expect(out.findings, JSON.stringify(license)).toHaveLength(1);
    }
    const other = await licence({ "package.json": pkg({ license: "Apache-2.0" }) });
    expect(other.findings).toEqual([]);
    expect(other.passed).toEqual([]);
  });

  it.each([
    "This site is based on a starter.",
    "Forked from a public template repository.",
    "Our boilerplate for client sites.",
    "The project was built with the corner template.",
  ])("takes %s as a sign that a starter was used", async (line) => {
    const out = await licence({ "package.json": pkg(), "README.md": `# Site\n\n${line}\n` });
    expect(out.findings.map((f) => f.source)).toEqual([{ file: "README.md", line: 3 }]);
  });

  it("does not read an email template or a theme as a starter", async () => {
    const out = await licence({
      "package.json": pkg(),
      "README.md": "Edit the email template in lib/mail.\n",
    });
    expect(out.findings).toEqual([]);
    expect(out.passed).toEqual([]);
  });

  it("is not sure about a licence file with other text, a licence file it did not read, and a truncated folder", async () => {
    const other = await licence({
      "package.json": pkg({ license: "MIT" }),
      LICENSE: "All rights reserved.",
    });
    expect(other.passed).toEqual([]);
    expect(other.couldNotCheck[0]?.reason).toContain("not MIT or ISC");
    const skipped = await licence(
      { "package.json": pkg({ license: "MIT" }) },
      { skipped: { LICENSE: "too-large" } },
    );
    expect(skipped.couldNotCheck[0]?.reason).toContain("LICENSE was not read");
    const truncated = await licence(
      { "package.json": pkg({ license: "MIT" }) },
      { truncated: true },
    );
    expect(truncated.findings).toEqual([]);
    expect(truncated.passed).toEqual([]);
  });

  it("never prints the text of a file", async () => {
    const out = await licence({
      "package.json": pkg({ license: "MIT" }),
      "README.md": "based on do-not-print-this\n",
    });
    expect(JSON.stringify(out)).not.toContain("do-not-print-this");
  });
});

const lock = (version: string) =>
  JSON.stringify({
    lockfileVersion: 3,
    packages: { "": {}, "node_modules/next-sanity": { version } },
  });
const sanity = (files: Record<string, string>, version?: string) =>
  runOne(
    nextSanityRemovedApi,
    treeOf({
      "package.json": JSON.stringify({ dependencies: { "next-sanity": "^13.0.0" } }),
      ...(version === undefined ? {} : { "package-lock.json": lock(version) }),
      ...files,
    }),
  );

describe("next-sanity-removed-api: fixtures", () => {
  it("fails a next-sanity 13 project that imports a removed hook and sets a removed prop", async () => {
    const out = await runOne(
      nextSanityRemovedApi,
      await fixtureTree("next-sanity-removed-api", "fail"),
    );
    expect(out.passed).toEqual([]);
    expect(out.findings.map((f) => f.evidence)).toEqual([
      "app/DebugStatus.tsx:2: useDraftModePerspective (a hook) was removed in next-sanity 13, and package.json:6 installs 13.4.0.",
      "app/layout.tsx:8: refreshOnFocus (a SanityLive prop) was removed in next-sanity 13, and package.json:6 installs 13.4.0.",
    ]);
    expect(out.findings[0]).toMatchObject({ checkId: "next-sanity-removed-api", severity: "low" });
  });

  it("passes the same project on the replacements", async () => {
    const out = await runOne(
      nextSanityRemovedApi,
      await fixtureTree("next-sanity-removed-api", "pass"),
    );
    expect(out.findings).toEqual([]);
    expect(out.passed).toEqual(["next-sanity-removed-api"]);
  });
});

describe("next-sanity-removed-api: the patterns", () => {
  const hook = (name: string, from = "next-sanity/hooks") =>
    `import { ${name} } from "${from}";\nexport const x = ${name};`;

  it.each(["useDraftModePerspective", "useIsLivePreview", "useDraftModeEnvironment"])(
    "finds %s imported from next-sanity/hooks and from next-sanity",
    async (name) => {
      for (const from of ["next-sanity/hooks", "next-sanity"]) {
        const out = await sanity({ "app/a.tsx": hook(name, from) }, "13.4.0");
        expect(out.findings, `${name} from ${from}`).toHaveLength(1);
      }
    },
  );

  it("finds a removed prop only on the SanityLive tag, whatever else is on it", async () => {
    const live = `export const a = <SanityLive action={async (t) => { 'use server'; return t > 0 }} refreshOnMount={false} tag="x" />;`;
    const out = await sanity({ "app/a.tsx": live }, "13.4.0");
    expect(out.findings.map((f) => f.evidence.split(" (")[0])).toEqual([
      "app/a.tsx:1: refreshOnMount",
      "app/a.tsx:1: tag",
    ]);
    const other = await sanity(
      {
        "app/a.tsx": `export const a = <Other refreshOnFocus tag="x" />; const b = <SanityLive action="refresh" />;`,
      },
      "13.4.0",
    );
    expect(other.findings).toEqual([]);
  });

  it("finds stega and fetchOptions written directly in defineLive, not nested in the client", async () => {
    const out = await sanity(
      {
        "lib/live.ts": `export const live = defineLive({ client, stega: false, fetchOptions: { revalidate: 60 } });`,
      },
      "13.4.0",
    );
    expect(out.findings.map((f) => f.evidence.split(" (")[0])).toEqual([
      "lib/live.ts:1: stega",
      "lib/live.ts:1: fetchOptions",
    ]);
    const nested = await sanity(
      {
        "lib/live.ts": `export const live = defineLive({ client: client.withConfig({ stega: { studioUrl: "/studio" } }) });`,
      },
      "13.4.0",
    );
    expect(nested.findings).toEqual([]);
    expect(nested.passed).toEqual(["next-sanity-removed-api"]);
  });

  it("is not a finding on next-sanity 12, where the APIs exist", async () => {
    const out = await sanity({ "app/a.tsx": hook("useIsLivePreview") }, "12.9.0");
    expect(out.findings).toEqual([]);
    expect(out.passed).toEqual(["next-sanity-removed-api"]);
  });

  it("is not sure when the version cannot be read or next-sanity is not declared, and the code uses a removed name", async () => {
    const range = await sanity({ "app/a.tsx": hook("useIsLivePreview") });
    expect(range.passed).toEqual([]);
    expect(range.couldNotCheck[0]?.reason).toContain("cannot read which next-sanity version");
    const none = await runOne(
      nextSanityRemovedApi,
      treeOf({ "package.json": pkgOnly(), "app/a.tsx": hook("useIsLivePreview") }),
    );
    expect(none.passed).toEqual([]);
    expect(none.couldNotCheck).toHaveLength(1);
  });

  it("passes code that uses none of the names, whatever the version, and ignores a comment and tests", async () => {
    const out = await sanity({
      "app/a.tsx": `// import { useIsLivePreview } from "next-sanity/hooks";\nexport const a = 1;`,
      "app/a.test.tsx": hook("useIsLivePreview"),
    });
    expect(out.passed).toEqual(["next-sanity-removed-api"]);
  });

  it("prints only the file, the line, the name and the version", async () => {
    const out = await sanity(
      { "app/a.tsx": `${hook("useIsLivePreview")}\n// do-not-print-this` },
      "13.4.0",
    );
    expect(JSON.stringify(out)).not.toContain("do-not-print-this");
  });
});

function pkgOnly(): string {
  return JSON.stringify({ dependencies: { react: "19.0.0" } });
}
