// check-community: allow-email (invented addresses at reserved example domains, used by the test)
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { afterEach, describe, expect, it } from "vitest";
import { checkForm, checkLinks, findEmails } from "../lib/community.js";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const read = (p: string) => {
  try {
    return readFileSync(join(repoRoot, p), "utf8");
  } catch {
    return undefined;
  }
};

describe("check-community: unit", () => {
  it('an issue form missing "body" fails, naming the file', () => {
    expect(checkForm(".github/ISSUE_TEMPLATE/x.yml", "name: X\ndescription: Y\n")).toEqual([
      '.github/ISSUE_TEMPLATE/x.yml: the issue form has no "body".',
    ]);
  });

  it("bug.yml has a required checkboxes field", () => {
    const form = parse(read(".github/ISSUE_TEMPLATE/bug.yml") ?? "") as {
      body: { type: string; attributes: { options?: { label: string; required?: boolean }[] } }[];
    };
    const box = form.body.find((f) => f.type === "checkboxes");
    expect(box?.attributes.options).toEqual([
      {
        label: "I removed keys, webhook addresses and private URLs from this report",
        required: true,
      },
    ]);
  });

  it("a relative link to a file that does not exist fails, naming the link", () => {
    expect(checkLinks("CONTRIBUTING.md", "See [x](docs/nope.md).", read)).toEqual([
      'CONTRIBUTING.md: the link "docs/nope.md" points at docs/nope.md, which does not exist.',
    ]);
  });

  it("a file containing something shaped like name@host.tld fails, naming file and line", () => {
    expect(
      findEmails("scripts/x.ts", "const a = 1;\nconst b = 'someone@company.example';\n"),
    ).toEqual([
      'scripts/x.ts:2: looks like an email address. Remove it, or mark the file with "check-community: allow-email" and a reason.',
    ]);
  });
});

describe("check-community: integration", () => {
  it("the real CONTRIBUTING.md, SECURITY.md and both forms pass", () => {
    for (const f of ["bug.yml", "check-request.yml"])
      expect(checkForm(f, read(`.github/ISSUE_TEMPLATE/${f}`) ?? "")).toEqual([]);
    for (const f of ["CONTRIBUTING.md", "SECURITY.md", "CODE_OF_CONDUCT.md"])
      expect(checkLinks(f, read(f) ?? "", read)).toEqual([]);
    const config = parse(read(".github/ISSUE_TEMPLATE/config.yml") ?? "") as {
      blank_issues_enabled: boolean;
      contact_links: { name: string; url: string }[];
    };
    expect(config.blank_issues_enabled).toBe(false);
    expect(config.contact_links[0]).toMatchObject({
      name: "Report a security problem",
      url: expect.stringContaining("SECURITY.md"),
    });
  });

  it("the whole repository passes the community check", () => {
    const r = spawnSync(
      process.execPath,
      [
        join(repoRoot, "node_modules/tsx/dist/cli.mjs"),
        join(repoRoot, "scripts/check-community.ts"),
      ],
      { encoding: "utf8" },
    );
    expect(r.status, r.stderr).toBe(0);
  }, 30_000);

  it("every command quoted in CONTRIBUTING.md exists as a root package.json script", () => {
    const scripts = (
      JSON.parse(read("package.json") ?? "{}") as { scripts: Record<string, string> }
    ).scripts;
    const builtins = new Set(["install", "add", "exec", "vitest", "run"]);
    const quoted = [
      ...new Set(
        [...(read("CONTRIBUTING.md") ?? "").matchAll(/\bpnpm ([a-z][a-z:-]*)/g)].map(
          (m) => m[1] ?? "",
        ),
      ),
    ].filter((c) => !builtins.has(c));
    for (const c of ["test", "new:check", "gen:checks", "changeset"]) expect(quoted).toContain(c);
    for (const c of quoted) expect(scripts[c], `pnpm ${c}`).toBeDefined();
  });
});

const temps: string[] = [];
afterEach(() => {
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});

describe("check-community: edge cases", () => {
  it("an address in a fixture page is allowed under packages/fixtures only", () => {
    expect(
      findEmails(
        "packages/fixtures/sites/clean/contact.html",
        "<a href='mailto:user@example.com'>",
      ),
    ).toEqual([]);
    expect(findEmails("packages/core/src/x.ts", "user@example.com")).toHaveLength(1);
  });

  it("a link with an anchor: the file is checked, and the anchor against its headings", () => {
    expect(checkLinks("CONTRIBUTING.md", "[x](STABILITY.md#semver-rules)", read)).toEqual([]);
    expect(checkLinks("CONTRIBUTING.md", "[x](STABILITY.md#no-such-heading)", read)).toEqual([
      'CONTRIBUTING.md: the link "STABILITY.md#no-such-heading" names the heading #no-such-heading, which STABILITY.md does not have.',
    ]);
  });

  it("the changesets changelog includes no git author emails", () => {
    const config = JSON.parse(read(".changeset/config.json") ?? "{}") as { changelog: string };
    expect(config.changelog).toBe("@changesets/cli/changelog");
    const dir = mkdtempSync(join(tmpdir(), "gaugeline-cl-"));
    temps.push(dir);
    mkdirSync(join(dir, "packages/gaugeline"), { recursive: true });
    mkdirSync(join(dir, ".changeset"));
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "r", private: true }));
    writeFileSync(join(dir, "pnpm-workspace.yaml"), 'packages:\n  - "packages/*"\n');
    writeFileSync(
      join(dir, "packages/gaugeline/package.json"),
      JSON.stringify({ name: "gaugeline", version: "0.0.2" }),
    );
    writeFileSync(
      join(dir, ".changeset/config.json"),
      JSON.stringify({ ...config, fixed: [], ignore: [] }),
    );
    writeFileSync(join(dir, ".changeset/a.md"), '---\n"gaugeline": patch\n---\n\nFixes a thing.\n');
    writeFileSync(join(dir, ".gitignore"), "node_modules\n");
    symlinkSync(join(repoRoot, "node_modules"), join(dir, "node_modules"), "junction");
    const git = (...a: string[]) =>
      execFileSync(
        "git",
        ["-c", "user.email=author@private.example", "-c", "user.name=Someone", ...a],
        { cwd: dir, stdio: "ignore" },
      );
    git("init", "-q", "-b", "main");
    git("add", "-A");
    git("commit", "-qm", "x");
    const r = spawnSync(
      process.execPath,
      [join(repoRoot, "node_modules/@changesets/cli/bin.js"), "version"],
      { cwd: dir, encoding: "utf8" },
    );
    expect(r.status, r.stderr).toBe(0);
    const log = readFileSync(join(dir, "packages/gaugeline/CHANGELOG.md"), "utf8");
    expect(log).toContain("Fixes a thing.");
    expect(log).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
  }, 60_000);

  it("a form with a duplicate field id fails", () => {
    const form =
      "name: X\ndescription: Y\nbody:\n  - type: input\n    id: version\n  - type: input\n    id: version\n";
    expect(checkForm("x.yml", form)).toEqual(['x.yml: the field id "version" is used twice.']);
  });
});
