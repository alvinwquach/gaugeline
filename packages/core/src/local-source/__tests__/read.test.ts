import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigError } from "../../errors.js";
import {
  SOURCE_LIMITS,
  isSecretLookingName,
  readLocalSource,
  sourcePaths,
  type SourceLimits,
} from "../read.js";

let root: string;
let outside: string;

/** Writes a file (and its folders) under `base`. */
function put(base: string, rel: string, text: string): void {
  const full = join(base, ...rel.split("/"));
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, text);
}

beforeEach(() => {
  // realpath: macOS tmpdir is a symlink, and the reader works on real paths.
  const base = realpathSync(mkdtempSync(join(tmpdir(), "gl-source-")));
  root = join(base, "site");
  outside = join(base, "elsewhere");
  mkdirSync(root);
  mkdirSync(outside);
});

afterEach(() => {
  rmSync(dirname(root), { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

const small = (over: Partial<SourceLimits>): SourceLimits => ({ ...SOURCE_LIMITS, ...over });

// A key-shaped string is built at run time: the repository's secret scanning refuses the literal.
const PEM = `-----BEGIN ${"RSA"} PRIVATE KEY-----\nbm90LWEtcmVhbC1rZXk=\n-----END ${"RSA"} PRIVATE KEY-----\n`;

describe("isSecretLookingName", () => {
  it.each([
    ".env",
    ".env.local",
    ".env.production",
    ".env.example",
    "deploy.pem",
    "signing.key",
    "store.p12",
    "id_rsa",
    "id_ed25519",
    ".npmrc",
    ".netrc",
    ".htpasswd",
    "credentials.json",
    "service-account.json",
    "secrets.yml",
    "app.secrets.yaml",
    "my-secret.txt",
  ])("%s is secret-looking", (name) => {
    expect(isSecretLookingName(name)).toBe(true);
  });

  it.each([
    "package.json",
    "tsconfig.json",
    "next.config.ts",
    "environment.ts",
    "robots.txt",
    "secrets.ts",
    "secret-store.tsx",
    "credentials.ts",
    "ci.yml",
  ])("%s is not", (name) => {
    expect(isSecretLookingName(name)).toBe(false);
  });
});

describe("readLocalSource: what is read", () => {
  it("reads source, manifests, a lockfile and CI files, under posix paths, in path order", async () => {
    put(root, "package.json", '{"name":"shop"}');
    put(root, "pnpm-lock.yaml", "lockfileVersion: '9.0'\n");
    put(root, "tsconfig.json", '{"compilerOptions":{"target":"es2022"}}');
    put(root, "next.config.ts", "export default {};\n");
    put(root, "app/layout.tsx", "export default function L() { return null }\n");
    put(root, "app/api/hook/route.ts", "export async function POST() {}\n");
    put(root, "public/robots.txt", "User-agent: *\nAllow: /\n");
    put(root, ".github/workflows/ci.yml", "name: ci\n");
    put(root, "logo.png", "not text and not a type the reader takes");

    const tree = await readLocalSource(root);

    expect(tree.kind).toBe("local-source");
    expect(tree.truncated).toBe(false);
    expect([...tree.files.keys()]).toEqual([
      ".github/workflows/ci.yml",
      "app/api/hook/route.ts",
      "app/layout.tsx",
      "next.config.ts",
      "package.json",
      "pnpm-lock.yaml",
      "public/robots.txt",
      "tsconfig.json",
    ]);
    expect(tree.files.get("package.json")).toBe('{"name":"shop"}');
    expect(tree.skipped.size).toBe(0);
  });

  it("keeps the folder as typed, for messages, and never the absolute path", async () => {
    put(root, "package.json", "{}");
    const tree = await readLocalSource(root, undefined, "./site");
    expect(tree.label).toBe("./site");
    expect(JSON.stringify([...tree.files.keys()])).not.toContain(root);
  });

  it("drops a byte order mark", async () => {
    put(root, "app/page.tsx", "\uFEFFexport default 1;\n");
    expect((await readLocalSource(root)).files.get("app/page.tsx")).toBe("export default 1;\n");
  });

  it("sourcePaths lists the paths a test accepts, sorted", async () => {
    put(root, "app/b/page.tsx", "x");
    put(root, "app/a/page.tsx", "x");
    put(root, "app/a/layout.tsx", "x");
    const tree = await readLocalSource(root);
    expect(sourcePaths(tree, (p) => p.endsWith("page.tsx"))).toEqual([
      "app/a/page.tsx",
      "app/b/page.tsx",
    ]);
    expect(sourcePaths(tree)).toHaveLength(3);
  });
});

describe("readLocalSource: what is never entered", () => {
  it("skips node_modules, .git, build output and dot folders, but reads .github/workflows", async () => {
    put(root, "node_modules/dep/index.js", "x");
    put(root, ".git/config", "x");
    put(root, ".next/server/app.js", "x");
    put(root, "dist/out.js", "x");
    put(root, ".vercel/project.json", "{}");
    put(root, ".idea/workspace.xml.txt", "x");
    put(root, "packages/web/node_modules/dep/index.js", "x");
    put(root, ".github/workflows/deploy.yaml", "name: deploy\n");
    put(root, ".github/ISSUE_TEMPLATE/bug.md", "x");
    put(root, "src/index.ts", "x");

    const tree = await readLocalSource(root);

    expect([...tree.files.keys()]).toEqual([".github/workflows/deploy.yaml", "src/index.ts"]);
    expect(tree.skipped.size).toBe(0);
  });
});

describe("readLocalSource: secrets are refused and never printed", () => {
  it("lists a .env file or a key file by path and reason, and holds none of its text", async () => {
    const leak = "value-that-must-not-travel";
    put(root, ".env", `API_TOKEN=${leak}\n`);
    put(root, ".env.local", `API_TOKEN=${leak}\n`);
    put(root, "apps/web/.env.production", `API_TOKEN=${leak}\n`);
    put(root, "certs/server.pem", leak);
    put(root, ".npmrc", `//registry.example/:_authToken=${leak}\n`);
    put(root, "config/credentials.json", `{"token":"${leak}"}`);
    put(root, "package.json", "{}");

    const tree = await readLocalSource(root);

    expect([...tree.files.keys()]).toEqual(["package.json"]);
    expect([...tree.skipped]).toEqual([
      [".env", "secret-looking"],
      [".env.local", "secret-looking"],
      [".npmrc", "secret-looking"],
      ["apps/web/.env.production", "secret-looking"],
      ["certs/server.pem", "secret-looking"],
      ["config/credentials.json", "secret-looking"],
    ]);
    // Nothing the reader returns holds the text: not a value, not a path, not a reason.
    const everything = JSON.stringify({
      files: [...tree.files],
      skipped: [...tree.skipped],
      label: tree.label,
    });
    expect(everything).not.toContain(leak);
  });

  it("reads a source file that only has 'secret' in its name", async () => {
    put(root, "lib/secrets.ts", "export const readSecret = () => 1;\n");
    put(root, "lib/credentials.ts", "export {};\n");
    expect([...(await readLocalSource(root)).files.keys()]).toEqual([
      "lib/credentials.ts",
      "lib/secrets.ts",
    ]);
  });

  it("refuses a file that holds a private key, whatever it is called", async () => {
    put(root, "notes/readme.txt", PEM);
    put(root, "src/ok.ts", "export {};\n");
    const tree = await readLocalSource(root);
    expect([...tree.files.keys()]).toEqual(["src/ok.ts"]);
    expect(tree.skipped.get("notes/readme.txt")).toBe("secret-looking");
    expect(JSON.stringify([...tree.skipped])).not.toContain("bm90LWEt");
  });
});

describe("readLocalSource: links are never followed", () => {
  // Creating a link needs a privilege on Windows runners; the reader's rule is the same there.
  const link = (target: string, path: string, type: "file" | "dir"): boolean => {
    try {
      symlinkSync(target, path, type);
      return true;
    } catch {
      return false;
    }
  };

  it("does not read a file link or a folder link that leads outside the folder", async () => {
    const leak = "text-outside-the-root";
    put(outside, "secret.ts", leak);
    put(outside, "dir/inner.ts", leak);
    put(root, "src/real.ts", "export {};\n");
    const a = link(join(outside, "secret.ts"), join(root, "src", "linked.ts"), "file");
    const b = link(join(outside, "dir"), join(root, "src", "linkdir"), "dir");
    if (!a || !b) return;

    const tree = await readLocalSource(root);

    expect([...tree.files.keys()]).toEqual(["src/real.ts"]);
    expect(tree.skipped.get("src/linked.ts")).toBe("symlink");
    expect(tree.skipped.get("src/linkdir")).toBe("symlink");
    expect(JSON.stringify([...tree.files])).not.toContain(leak);
  });

  it("does not follow a link that points back inside the folder either (no loops, no doubles)", async () => {
    put(root, "src/real.ts", "export {};\n");
    if (!link(join(root, "src"), join(root, "src", "again"), "dir")) return;
    const tree = await readLocalSource(root);
    expect([...tree.files.keys()]).toEqual(["src/real.ts"]);
  });

  it("reads the folder a link given as the root points to: the person named it", async () => {
    put(outside, "app/page.tsx", "export {};\n");
    const alias = join(dirname(root), "alias");
    if (!link(outside, alias, "dir")) return;
    expect([...(await readLocalSource(alias)).files.keys()]).toEqual(["app/page.tsx"]);
  });
});

describe("readLocalSource: limits", () => {
  it("skips a file over the size limit and says so", async () => {
    put(root, "src/big.ts", "x".repeat(200));
    put(root, "src/ok.ts", "ok");
    const tree = await readLocalSource(root, small({ maxFileBytes: 100 }));
    expect([...tree.files.keys()]).toEqual(["src/ok.ts"]);
    expect(tree.skipped.get("src/big.ts")).toBe("too-large");
    expect(tree.truncated).toBe(false);
  });

  it("lets a lockfile be larger than a source file", async () => {
    put(root, "pnpm-lock.yaml", "x".repeat(200));
    put(root, "package-lock.json", "x".repeat(200));
    put(root, "src/big.ts", "x".repeat(200));
    const tree = await readLocalSource(root, small({ maxFileBytes: 100, maxLockfileBytes: 300 }));
    expect([...tree.files.keys()]).toEqual(["package-lock.json", "pnpm-lock.yaml"]);
    expect(tree.skipped.get("src/big.ts")).toBe("too-large");
  });

  it("stops at the file limit with the same first files every time, and says it stopped", async () => {
    for (const n of ["e", "b", "d", "a", "c"]) put(root, `src/${n}.ts`, n);
    const first = await readLocalSource(root, small({ maxFiles: 3 }));
    const again = await readLocalSource(root, small({ maxFiles: 3 }));
    expect([...first.files.keys()]).toEqual(["src/a.ts", "src/b.ts", "src/c.ts"]);
    expect([...again.files.keys()]).toEqual([...first.files.keys()]);
    expect(first.truncated).toBe(true);
  });

  it("stops at the total size limit", async () => {
    put(root, "src/a.ts", "x".repeat(60));
    put(root, "src/b.ts", "x".repeat(60));
    put(root, "src/c.ts", "x".repeat(60));
    const tree = await readLocalSource(root, small({ maxTotalBytes: 130 }));
    expect([...tree.files.keys()]).toEqual(["src/a.ts", "src/b.ts"]);
    expect(tree.truncated).toBe(true);
  });

  it("does not go deeper than the depth limit", async () => {
    put(root, "a/b/c/deep.ts", "x");
    put(root, "a/top.ts", "x");
    const tree = await readLocalSource(root, small({ maxDepth: 2 }));
    expect([...tree.files.keys()]).toEqual(["a/top.ts"]);
    expect(tree.truncated).toBe(true);
  });

  it("skips a file with binary content", async () => {
    writeFileSync(join(root, "data.json"), Buffer.from([0x7b, 0x00, 0x7d]));
    put(root, "ok.json", "{}");
    const tree = await readLocalSource(root);
    expect([...tree.files.keys()]).toEqual(["ok.json"]);
    expect(tree.skipped.get("data.json")).toBe("binary");
  });
});

describe("readLocalSource: the folder", () => {
  it("is a ConfigError when it does not exist", async () => {
    await expect(readLocalSource(join(root, "nope"))).rejects.toBeInstanceOf(ConfigError);
  });

  it("is a ConfigError when it is a file", async () => {
    put(root, "package.json", "{}");
    await expect(readLocalSource(join(root, "package.json"))).rejects.toBeInstanceOf(ConfigError);
  });

  it("an empty folder is a tree with no files, not an error", async () => {
    const tree = await readLocalSource(root);
    expect(tree.files.size).toBe(0);
    expect(tree.truncated).toBe(false);
  });
});
