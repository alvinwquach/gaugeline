import { describe, expect, it } from "vitest";
import {
  closeOf,
  codePaths,
  conditions,
  lineOf,
  scanSource,
  unreadReason,
  webhookHandlers,
} from "../source-scan.js";
import { treeOf } from "./helpers.js";

const input = (files: Record<string, string>, skipped = {}) => ({
  kind: "local-source" as const,
  tree: treeOf(files, { skipped }),
});

describe("scanSource", () => {
  it("blanks comments and string text, keeps the quotes, and keeps every position and line", () => {
    const text = `const a = "if (x)"; // if (y)\n/* if (z)\n */ const b = 'q';`;
    const { code, bare } = scanSource(text);
    expect(code).toHaveLength(text.length);
    expect(bare).toHaveLength(text.length);
    expect(bare).not.toMatch(/if/);
    expect(code).toContain('"if (x)"');
    expect(code).not.toContain("if (y)");
    expect(bare.split("\n")).toHaveLength(3);
    expect(bare).toContain('"      "');
  });

  it("keeps the ${ } parts of a template string as code and blanks its text", () => {
    const { bare, code } = scanSource("const m = `hello ${user.id} and ${ fn(`x ${y}`) }`;");
    expect(bare).toContain("${user.id}");
    expect(bare).toContain("fn(");
    expect(bare).not.toContain("hello");
    expect(code).toContain("hello");
  });

  it("does not let an escaped quote or an unclosed quote swallow the rest of the file", () => {
    const { bare } = scanSource(`const a = 'it\\'s'; const b = "open\nconst c = 1;`);
    expect(bare).toContain("const c = 1;");
    expect(bare).toContain("const b");
  });
});

describe("lineOf, closeOf, conditions", () => {
  it("counts lines from 1", () => {
    expect(lineOf("a\nb\nc", 0)).toBe(1);
    expect(lineOf("a\nb\nc", 4)).toBe(3);
  });

  it("finds the bracket that closes, nested, and -1 when it never does", () => {
    expect(closeOf("f(a(b)(c))x", 1)).toBe(9);
    expect(closeOf("{ { }", 0)).toBe(-1);
  });

  it("reads an if with a block, with one statement, and with an else", () => {
    const { bare } = scanSource(
      `if (!a) { return 1; }\nif (b) return 2;\nif (c(d)) throw e; else x();`,
    );
    const found = conditions(bare);
    expect(found.map((c) => c.cond)).toEqual(["!a", "b", "c(d)"]);
    expect(found[0]?.body).toBe("{ return 1; }");
    expect(found[1]?.body).toBe("return 2");
    expect(found[2]?.body).toBe("throw e");
  });
});

describe("which files are read", () => {
  it("reads code files, not tests, mocks or type declarations", () => {
    const i = input({
      "app/a.ts": "",
      "app/b.test.ts": "",
      "app/__tests__/c.ts": "",
      "types/d.d.ts": "",
      "app/e.tsx": "",
      "app/f.md": "",
    });
    expect(codePaths(i)).toEqual(["app/a.ts", "app/e.tsx"]);
  });

  it("finds a receiver by the helper it imports, the header it reads, or a route that revalidates behind a secret", () => {
    const i = input({
      "a.ts": `import { isValidSignature } from "@sanity/webhook";`,
      "b.ts": `const h = req.headers.get("Sanity-Webhook-Signature");`,
      "app/api/c/route.ts": `import { revalidatePath } from "next/cache";\nconst secret = 1; revalidatePath("/");`,
      "lib/d.ts": `import { revalidatePath } from "next/cache";\nconst secret = 1; revalidatePath("/");`,
      "app/api/e/route.ts": `export function GET() { return new Response("ok"); }`,
      "f.ts": `// import x from "@sanity/webhook"`,
    });
    expect(webhookHandlers(i).map((h) => h.path)).toEqual(["a.ts", "app/api/c/route.ts", "b.ts"]);
  });

  it("says which code file was not read, and nothing when all were", () => {
    expect(unreadReason(input({ "a.ts": "" }))).toBeUndefined();
    expect(unreadReason(input({}, { "lib/big.ts": "too-large", "x.json": "too-large" }))).toBe(
      "lib/big.ts was not read (too-large), so Gaugeline cannot say nothing is wrong in it.",
    );
  });
});
