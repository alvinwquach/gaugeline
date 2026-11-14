import { describe, expect, it } from "vitest";
import { installedVersions } from "../installed-version.js";
import { treeOf } from "./helpers.js";

const input = (files: Record<string, string>, over = {}) => ({
  kind: "local-source" as const,
  tree: treeOf(files, over),
});
const manifest = (deps: Record<string, string>) => JSON.stringify({ dependencies: deps });

const PNPM = `lockfileVersion: '9.0'

importers:

  .:
    dependencies:
      zod:
        specifier: ^4.0.0
        version: 4.6.5
      next:
        specifier: ^16.0.0
        version: 16.4.0(react-dom@19.0.0(react@19.0.0))(react@19.0.0)

  apps/web:
    dependencies:
      zod:
        specifier: ^3.22.0
        version: 3.25.76

packages:

  zod@4.6.5:
    resolution: {integrity: sha512-x}
`;

describe("installedVersions: unit", () => {
  it("returns nothing for a package no package.json declares", () => {
    expect(
      installedVersions(input({ "package.json": manifest({ react: "^19.0.0" }) }), "zod"),
    ).toEqual([]);
    expect(installedVersions(input({}), "zod")).toEqual([]);
  });

  it("reads the version from pnpm-lock.yaml, for the importer that declares it", () => {
    const files = {
      "package.json": manifest({ zod: "^4.0.0", next: "^16.0.0" }),
      "apps/web/package.json": manifest({ zod: "^3.22.0" }),
      "pnpm-lock.yaml": PNPM,
    };
    const zod = installedVersions(input(files), "zod");
    expect(zod.map((r) => [r.declaredIn, r.state === "version" ? r.version : r.reason])).toEqual([
      ["apps/web/package.json", "3.25.76"],
      ["package.json", "4.6.5"],
    ]);
    const next = installedVersions(input(files), "next");
    expect(next).toMatchObject([{ state: "version", version: "16.4.0", from: "pnpm-lock.yaml" }]);
  });

  it("reads package-lock.json (version 3), the nested copy before the hoisted one", () => {
    const lock = JSON.stringify({
      lockfileVersion: 3,
      packages: {
        "": {},
        "node_modules/zod": { version: "4.6.7" },
        "apps/web/node_modules/zod": { version: "4.6.5" },
      },
    });
    const files = {
      "package.json": manifest({ zod: "^4.0.0" }),
      "apps/web/package.json": manifest({ zod: "^4.0.0" }),
      "package-lock.json": lock,
    };
    const got = installedVersions(input(files), "zod").map((r) =>
      r.state === "version" ? r.version : r.reason,
    );
    expect(got).toEqual(["4.6.5", "4.6.7"]);
  });

  it("reads package-lock.json (version 1) and yarn.lock (classic and berry)", () => {
    const v1 = JSON.stringify({ lockfileVersion: 1, dependencies: { zod: { version: "4.6.1" } } });
    expect(
      installedVersions(
        input({ "package.json": manifest({ zod: "^4.0.0" }), "package-lock.json": v1 }),
        "zod",
      ),
    ).toMatchObject([{ state: "version", version: "4.6.1" }]);
    const classic = `# yarn lockfile v1\n\n"zod@^3.0.0", zod@^4.0.0:\n  version "4.6.2"\n  resolved "https://example.test/zod.tgz"\n`;
    expect(
      installedVersions(
        input({ "package.json": manifest({ zod: "^4.0.0" }), "yarn.lock": classic }),
        "zod",
      ),
    ).toMatchObject([{ state: "version", version: "4.6.2", from: "yarn.lock", line: 4 }]);
    const berry = `__metadata:\n  version: 8\n\n"zod@npm:^4.0.0":\n  version: 4.6.3\n  resolution: "zod@npm:4.6.3"\n`;
    expect(
      installedVersions(
        input({ "package.json": manifest({ zod: "^4.0.0" }), "yarn.lock": berry }),
        "zod",
      ),
    ).toMatchObject([{ state: "version", version: "4.6.3" }]);
  });

  it("uses a lockfile in a parent folder for a workspace package", () => {
    const files = {
      "packages/site/package.json": manifest({ zod: "^4.0.0" }),
      "pnpm-lock.yaml": PNPM.replace("apps/web:", "packages/site:").replace("3.25.76", "4.6.6"),
    };
    expect(installedVersions(input(files), "zod")).toMatchObject([
      { state: "version", version: "4.6.6", from: "pnpm-lock.yaml" },
    ]);
  });

  it("takes an exact version from package.json when there is no lockfile", () => {
    expect(
      installedVersions(input({ "package.json": manifest({ zod: "4.6.5" }) }), "zod"),
    ).toMatchObject([{ state: "version", version: "4.6.5", from: "package.json" }]);
  });

  it("is not sure about a range with no lockfile, and says what it needs", () => {
    const r = installedVersions(input({ "package.json": manifest({ zod: "^4.0.0" }) }), "zod");
    expect(r).toMatchObject([{ state: "unsure", declaredIn: "package.json" }]);
    expect(r[0]).toMatchObject({
      reason: expect.stringContaining("no lockfile was read"),
    });
  });

  it("is not sure when the lockfile does not list the package, or was not read", () => {
    const missing = installedVersions(
      input({
        "package.json": manifest({ zod: "^4.0.0" }),
        "package-lock.json": JSON.stringify({ lockfileVersion: 3, packages: { "": {} } }),
      }),
      "zod",
    );
    expect(missing).toMatchObject([{ state: "unsure" }]);
    const skipped = installedVersions(
      input(
        { "package.json": manifest({ zod: "^4.0.0" }) },
        { skipped: { "pnpm-lock.yaml": "too-large" } },
      ),
      "zod",
    );
    expect(skipped[0]).toMatchObject({
      state: "unsure",
      reason: expect.stringContaining("pnpm-lock.yaml was not read"),
    });
  });

  it("is not sure about a link, a catalog or a git address, and about a package.json it cannot parse", () => {
    for (const spec of ["catalog:", "workspace:*", "github:example/zod", "latest"]) {
      const r = installedVersions(input({ "package.json": manifest({ zod: spec }) }), "zod");
      expect(r, spec).toMatchObject([{ state: "unsure" }]);
    }
    const broken = installedVersions(
      input({ "package.json": `{ "dependencies": { "zod": ` }),
      "zod",
    );
    expect(broken).toMatchObject([{ state: "unsure", reason: expect.stringContaining("JSON") }]);
  });

  it("is not sure when an override may change the version and no lockfile was read", () => {
    const files = {
      "package.json": JSON.stringify({
        dependencies: { zod: "4.6.5" },
        overrides: { zod: "4.6.7" },
      }),
    };
    expect(installedVersions(input(files), "zod")).toMatchObject([{ state: "unsure" }]);
  });

  it("never puts file text in a result beyond versions and paths", () => {
    const r = installedVersions(
      input({
        "package.json": manifest({ zod: "^4.0.0" }),
        "pnpm-lock.yaml": PNPM + "\n# token: do-not-print-this\n",
      }),
      "zod",
    );
    expect(JSON.stringify(r)).not.toContain("do-not-print-this");
  });
});
