import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { startFixture } from "../../../fixtures/src/index.js";
import { createFetcher } from "../fetcher.js";
import { checkSite } from "../site.js";

/** ADR-0002: checks are plain rules. Model SDKs never enter packages/core. */
const MODEL_SDKS = [
  /^openai$/,
  /^@anthropic-ai\//,
  /^@google\/generative-ai$/,
  /^@google\/genai$/,
  /^ai$/,
  /^@ai-sdk\//,
  /^cohere-ai$/,
  /^@mistralai\//,
  /^langchain/,
  /^@langchain\//,
  /^ollama$/,
  /^replicate$/,
];
const coreDir = fileURLToPath(new URL("../../", import.meta.url));

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const full = join(dir, n);
    if (n === "__tests__" || n === "node_modules" || n === "dist") return [];
    return statSync(full).isDirectory() ? sources(full) : n.endsWith(".ts") ? [full] : [];
  });
}

describe("ADR-0002: no model calls in core", () => {
  it("packages/core depends on no model SDK", () => {
    const pkg = JSON.parse(readFileSync(join(coreDir, "package.json"), "utf8")) as Record<
      string,
      Record<string, string> | undefined
    >;
    const deps = Object.keys({
      ...pkg.dependencies,
      ...pkg.peerDependencies,
      ...pkg.optionalDependencies,
    });
    expect(deps.filter((d) => MODEL_SDKS.some((r) => r.test(d)))).toEqual([]);
  });

  it("no core source imports a model SDK", () => {
    const hits: string[] = [];
    for (const f of sources(join(coreDir, "src"))) {
      for (const m of readFileSync(f, "utf8").matchAll(
        /(?:from|import)\s*\(?\s*["']([^"']+)["']/g,
      )) {
        if (MODEL_SDKS.some((r) => r.test(m[1] ?? ""))) hits.push(`${f}: ${m[1]}`);
      }
    }
    expect(hits).toEqual([]);
  });

  it("the same fixture checked twice gives the same findings, in the same order", async () => {
    for (const name of ["clean", "quick-start", "noindex-header", "redirect-chain", "thin-html"]) {
      const site = await startFixture(name);
      try {
        const run = async () =>
          JSON.stringify(
            (
              await checkSite({
                address: `${site.origin}/`,
                fetcher: createFetcher({ allowPrivate: true }),
              })
            ).result,
          );
        expect(await run(), name).toBe(await run());
      } finally {
        await site.close();
      }
    }
  });
});
