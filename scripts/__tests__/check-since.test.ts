// check-community: allow-email (an invented address at a reserved example domain, used for a throwaway git commit)
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import fc from "fast-check";
import { afterEach, describe, expect, it } from "vitest";
import { CATALOGUE_IDS } from "../lib/catalogue-ids.js";
import {
  checkSince,
  largestBump,
  loadSinceContext,
  nextVersion,
  sinceFor,
  stampRelease,
} from "../lib/check-since.js";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const temps: string[] = [];
afterEach(() => {
  for (const t of temps.splice(0))
    rmSync(t, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

/** The checks that shipped in 0.1.0 (release pull request #41). They never get another version. */
const SHIPPED_0_1_0 = [
  "ai-crawlers-blocked",
  "app-link-dead",
  "app-name-mismatch",
  "app-smart-banner-mismatch",
  "broken-links",
  "canonical-elsewhere",
  "canonical-missing",
  "feed-broken",
  "feed-invalid",
  "feed-oversized",
  "host-duplicate",
  "html-heavy",
  "html-huge",
  "image-width-absurd",
  "images-alt-empty",
  "images-alt-missing",
  "images-broken",
  "images-heavy",
  "images-legacy-format",
  "images-legacy-wp",
  "jsonld-404",
  "jsonld-invalid",
  "links-via-redirect",
  "llms-txt-broken-links",
  "llms-txt-stale-facts",
  "noindex",
  "og-image-missing",
  "og-image-relative",
  "og-url-mismatch",
  "page-heavy",
  "quotable-facts-disagree",
  "redirect-chain",
  "robots-block",
  "sitemap-dead",
  "sitemap-host",
  "sitemap-missing",
  "sitemap-redirects",
  "stega-leak",
  "structured-duplicate",
  "tel-format",
  "thin-html",
  "viewport",
];

describe("check since: unit", () => {
  it("the next version follows the largest pending bump", () => {
    expect(nextVersion("0.1.0", "patch")).toBe("0.1.1");
    expect(nextVersion("0.1.0", "minor")).toBe("0.2.0");
    expect(nextVersion("0.1.7", "minor")).toBe("0.2.0");
    expect(nextVersion("0.9.3", "major")).toBe("1.0.0");
    expect(nextVersion("1.4.2", "major")).toBe("2.0.0");
  });

  it("with no bump pending the next release is a patch", () => {
    expect(nextVersion("0.1.0", "none")).toBe("0.1.1");
  });

  it("largestBump picks the biggest and treats an empty list as none", () => {
    expect(largestBump(["patch", "minor", "none"])).toBe("minor");
    expect(largestBump(["patch", "major", "minor"])).toBe("major");
    expect(largestBump([])).toBe("none");
  });

  it("a released check shows its own version; an unreleased one shows the next version", () => {
    const lock = { noindex: "0.1.0" };
    expect(sinceFor("noindex", lock, "0.2.0")).toEqual({
      id: "noindex",
      version: "0.1.0",
      released: true,
    });
    expect(sinceFor("new-one", lock, "0.2.0")).toEqual({
      id: "new-one",
      version: "0.2.0",
      released: false,
    });
  });

  it("a release stamps only the ids that have no entry, and sorts the keys", () => {
    const { lock, added } = stampRelease({ b: "0.1.0" }, ["c", "b", "a"], "0.2.0");
    expect(added).toEqual(["a", "c"]);
    expect(Object.entries(lock)).toEqual([
      ["a", "0.2.0"],
      ["b", "0.1.0"],
      ["c", "0.2.0"],
    ]);
  });

  it("stamping never changes an entry that exists (any lock, any ids, any version)", () => {
    const id = fc.stringMatching(/^[a-z][a-z0-9-]{0,12}$/);
    const version = fc
      .tuple(fc.nat(9), fc.nat(30), fc.nat(30))
      .map(([a, b, c]) => `${a}.${b}.${c}`);
    fc.assert(
      fc.property(
        fc.dictionary(id, version, { maxKeys: 8 }),
        fc.array(id, { maxLength: 8 }),
        version,
        (lock, ids, v) => {
          const next = stampRelease(lock, ids, v).lock;
          for (const [k, was] of Object.entries(lock)) expect(next[k]).toBe(was);
          for (const k of ids) expect(next[k]).toBeDefined();
        },
      ),
    );
  });

  it("checkSince accepts a consistent lock", () => {
    expect(
      checkSince({
        lock: { a: "0.1.0" },
        registered: ["a", "b"],
        everShipped: ["a", "b"],
        packageVersion: "0.1.0",
        knownVersions: ["0.1.0"],
      }),
    ).toEqual([]);
  });

  it("checkSince names an entry for an id that was never registered, a version ahead of the package, an unknown version and a bad version", () => {
    const problems = checkSince({
      lock: { ghost: "0.1.0", a: "0.3.0", b: "0.1.5", c: "banana" },
      registered: ["a", "b", "c"],
      everShipped: ["a", "b", "c"],
      packageVersion: "0.1.0",
      knownVersions: ["0.1.0"],
    });
    expect(problems.join("\n")).toContain('"ghost"');
    expect(problems.join("\n")).toContain('"a" says 0.3.0');
    expect(problems.join("\n")).toContain('"b" says 0.1.5');
    expect(problems.join("\n")).toContain('"c" says banana');
  });

  it("checkSince fails when a released entry changed or was removed against the base", () => {
    const base = { a: "0.1.0", b: "0.1.0" };
    const problems = checkSince({
      lock: { a: "0.2.0" },
      registered: ["a"],
      everShipped: ["a", "b"],
      packageVersion: "0.2.0",
      knownVersions: ["0.1.0", "0.2.0"],
      base,
    });
    expect(problems.join("\n")).toContain('"a" was 0.1.0 and is now 0.2.0');
    expect(problems.join("\n")).toContain('"b" was 0.1.0 and was removed');
  });
});

describe("check since: the committed files", () => {
  const ctx = loadSinceContext(repoRoot);

  it("every registered check has a Since entry: released with its version, or the next version", () => {
    const ids = CATALOGUE_IDS();
    expect(ids.length).toBeGreaterThan(100);
    for (const id of ids) {
      const s = sinceFor(id, ctx.lock, ctx.next);
      expect(s.version, id).toMatch(/^\d+\.\d+\.\d+$/);
      if (s.released) expect(ctx.lock[id], id).toBe(s.version);
      else expect(ctx.lock[id], id).toBeUndefined();
    }
  });

  it("an unreleased check shows the next version, which is always ahead of the package", () => {
    expect(ctx.next).toBe(nextVersion(ctx.current, ctx.bump));
    const [a, b] = [ctx.current, ctx.next].map((v) => v.split(".").map(Number));
    expect((b?.[0] ?? 0) * 1e6 + (b?.[1] ?? 0) * 1e3 + (b?.[2] ?? 0)).toBeGreaterThan(
      (a?.[0] ?? 0) * 1e6 + (a?.[1] ?? 0) * 1e3 + (a?.[2] ?? 0),
    );
    expect(sinceFor("check-that-has-not-shipped", ctx.lock, ctx.next).released).toBe(false);
  });

  it("the checks that shipped in 0.1.0 keep 0.1.0 forever", () => {
    for (const id of SHIPPED_0_1_0) expect(ctx.lock[id], id).toBe("0.1.0");
  });

  it("the lock is consistent with the registry, the package version and the changelog", () => {
    const problems = checkSince({
      lock: ctx.lock,
      registered: CATALOGUE_IDS(),
      everShipped: JSON.parse(
        readFileSync(join(repoRoot, "docs/check-ids.lock.json"), "utf8"),
      ) as string[],
      packageVersion: ctx.current,
      knownVersions: (
        JSON.parse(readFileSync(join(repoRoot, "docs/changelog.data.json"), "utf8")) as {
          version: string;
        }[]
      ).map((e) => e.version),
    });
    expect(problems).toEqual([]);
  });

  it("the lock is sorted and written the way the script writes it", () => {
    const text = readFileSync(join(repoRoot, "docs/check-since.lock.json"), "utf8");
    expect(text).toBe(`${JSON.stringify(stampRelease(ctx.lock, [], "0.0.0").lock, null, 2)}\n`);
  });
});

/** A throwaway repository layout for the script: package version, changesets and a since lock. */
function tempRoot(opts: {
  version: string;
  lock: Record<string, string>;
  changesets?: Record<string, string>;
}): string {
  const dir = mkdtempSync(join(tmpdir(), "gaugeline-since-"));
  temps.push(dir);
  mkdirSync(join(dir, "docs"), { recursive: true });
  mkdirSync(join(dir, ".changeset"), { recursive: true });
  mkdirSync(join(dir, "packages/cli"), { recursive: true });
  writeFileSync(
    join(dir, "packages/cli/package.json"),
    JSON.stringify({ name: "gaugeline", version: opts.version }),
  );
  writeFileSync(join(dir, "docs/check-since.lock.json"), JSON.stringify(opts.lock));
  writeFileSync(
    join(dir, "docs/check-ids.lock.json"),
    readFileSync(join(repoRoot, "docs/check-ids.lock.json")),
  );
  for (const [f, body] of Object.entries(opts.changesets ?? {}))
    writeFileSync(join(dir, ".changeset", f), body);
  return dir;
}
const run = (args: string[]) =>
  spawnSync(
    process.execPath,
    [
      join(repoRoot, "node_modules/tsx/dist/cli.mjs"),
      join(repoRoot, "scripts/check-since.ts"),
      ...args,
    ],
    { encoding: "utf8", cwd: repoRoot },
  );

describe("check since: the script (temp repository)", () => {
  it("the committed repository passes", () => {
    const r = run([]);
    expect(r.status, r.stderr).toBe(0);
  }, 60_000);

  it("--release stamps every check without an entry with the new version and keeps the old ones", () => {
    const dir = tempRoot({ version: "0.2.0", lock: { noindex: "0.1.0" } });
    const r = run(["--release", "--root", dir]);
    expect(r.status, r.stderr).toBe(0);
    const lock = JSON.parse(
      readFileSync(join(dir, "docs/check-since.lock.json"), "utf8"),
    ) as Record<string, string>;
    expect(lock.noindex).toBe("0.1.0");
    expect(lock["broken-links"]).toBe("0.2.0");
    for (const id of CATALOGUE_IDS()) expect(lock[id], id).toBeDefined();
    // A second release run changes nothing.
    const before = readFileSync(join(dir, "docs/check-since.lock.json"), "utf8");
    expect(run(["--release", "--root", dir]).status).toBe(0);
    expect(readFileSync(join(dir, "docs/check-since.lock.json"), "utf8")).toBe(before);
  }, 60_000);

  it("a pending minor changeset moves the next version; the unreleased check shows it", () => {
    const dir = tempRoot({
      version: "0.4.1",
      lock: {},
      changesets: { "a.md": '---\n"gaugeline": minor\n---\n\nSomething new.\n' },
    });
    expect(loadSinceContext(dir).next).toBe("0.5.0");
    writeFileSync(
      join(dir, ".changeset/b.md"),
      '---\n"gaugeline": major\n---\n\nBREAKING: Something went.\n',
    );
    expect(loadSinceContext(dir).next).toBe("1.0.0");
  });

  it("with --base, a released entry that changed since the base fails and names the check", () => {
    const dir = tempRoot({ version: "0.2.0", lock: { noindex: "0.1.0" } });
    const git = (...a: string[]) =>
      execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", ...a], {
        cwd: dir,
        stdio: "ignore",
      });
    git("init", "-q", "-b", "main");
    git("add", "-A");
    git("commit", "-qm", "base");
    writeFileSync(join(dir, "docs/check-since.lock.json"), JSON.stringify({ noindex: "0.2.0" }));
    const r = run(["--root", dir, "--base", "HEAD"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('"noindex" was 0.1.0 and is now 0.2.0');
  }, 60_000);
});
