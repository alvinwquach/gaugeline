/**
 * The gate cannot be walked around (AG-23). An adapter takes a `GatedPayload`, which only the privacy gate can
 * make: a plain string does not compile there (a `@ts-expect-error` line that the type check fails without) and
 * is refused at run time by every adapter; no file but the gate imports the function that makes one; and no file
 * but the gateway calls an adapter. Offline: no network, no key, no clock.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ApiKey } from "../key.js";
import { PLAIN_KEY } from "./helpers.js";
import { isGatedPayload, issueGatedPayload } from "../gated.js";
import { buildModelPayload, buildPayloadWith, DEFAULT_PAYLOAD_PARTS } from "../privacy.js";
import { createRecordedAdapter } from "../recorded.js";
import { createProviderAdapter } from "../send.js";
import type { AdapterCall } from "../types.js";

const call = (prompt: unknown): AdapterCall => ({
  model: "m",
  callId: "c",
  maxOutputTokens: 5,
  signal: new AbortController().signal,
  key: new ApiKey(PLAIN_KEY),
  prompt: prompt as never,
});

describe("a plain string is not a payload", () => {
  it("does not compile where an adapter's prompt is expected", () => {
    const bad: AdapterCall = {
      model: "m",
      callId: "c",
      maxOutputTokens: 5,
      signal: new AbortController().signal,
      key: undefined,
      // @ts-expect-error a plain string is not a GatedPayload: only the privacy gate can make one
      prompt: "Reword: the menu link gives a 404.",
    };
    expect(typeof bad.prompt).toBe("string");
  });

  it("is refused at run time by the recorded adapter and by the sender", async () => {
    const recorded = createRecordedAdapter(new Map());
    const sender = createProviderAdapter("example");
    for (const adapter of [recorded, sender])
      for (const prompt of ["a string", { text: () => "x" }, undefined, 7])
        await expect(
          adapter.complete(call(prompt)),
          `${adapter.provider} ${String(prompt)}`,
        ).rejects.toMatchObject({
          code: "bad-request",
        });
  });

  it("is not a payload even when it has the same method: only the gate's own objects are", () => {
    expect(isGatedPayload("text")).toBe(false);
    expect(isGatedPayload({ text: () => "x" })).toBe(false);
    expect(isGatedPayload(Object.freeze({ text: () => "x" }))).toBe(false);
    const r = buildModelPayload({ task: { template: "reword-findings" } });
    expect(r.ok && isGatedPayload(r.gated)).toBe(true);
    expect(r.ok && r.gated.text()).toBe(r.ok && r.payload);
  });

  it("is never given by a gate with a part taken out", () => {
    const r = buildPayloadWith(
      { task: { template: "reword-findings" } },
      { ...DEFAULT_PAYLOAD_PARTS, redactions: [] },
    );
    expect(r.ok && "gated" in r).toBe(false);
  });
});

/** Every source file of the packages that is not a test, with its text. */
function sources(): { file: string; text: string }[] {
  const root = fileURLToPath(new URL("../../../../../", import.meta.url));
  const out: { file: string; text: string }[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (["node_modules", "dist", "__tests__", ".next", "coverage"].includes(name)) continue;
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.(ts|tsx|mts|js|mjs)$/.test(name) && !/\.test\.|\.d\.ts$/.test(name))
        out.push({ file: path.slice(root.length), text: readFileSync(path, "utf8") });
    }
  };
  for (const top of ["packages", "apps"]) {
    for (const pkg of readdirSync(join(root, top))) {
      const src = join(root, top, pkg, "src");
      try {
        walk(src);
      } catch {
        // a package with no src folder
      }
    }
  }
  return out;
}

describe("only the privacy gate makes a payload, and only the gateway calls an adapter", () => {
  const all = sources();

  it("finds the source files", () => {
    expect(all.length).toBeGreaterThan(200);
    expect(all.map((f) => f.file)).toContain("packages/core/src/model-gateway/gateway.ts");
  });

  it("has no file but gated.ts and privacy.ts that mentions issueGatedPayload", () => {
    const users = all.filter((f) => f.text.includes("issueGatedPayload")).map((f) => f.file);
    expect(users.sort()).toEqual([
      "packages/core/src/model-gateway/gated.ts",
      "packages/core/src/model-gateway/privacy.ts",
    ]);
  });

  it("has no file but gateway.ts that calls complete on an adapter", () => {
    const callers = all
      .filter((f) => /\badapters?!?(?:\[[^\]]*\])?\??\.complete\s*\(/.test(f.text))
      .map((f) => f.file);
    expect(callers).toEqual(["packages/core/src/model-gateway/gateway.ts"]);
  });

  it("has the gateway hand an adapter the gated payload and nothing else", () => {
    const g = all.find((f) => f.file.endsWith("model-gateway/gateway.ts"))!.text;
    expect(g).toContain("prompt: gated,");
    expect(g).not.toMatch(/prompt:\s*(sent|request\.)/);
  });

  it("is checked by a scan that would find a second caller (a planted one is seen)", () => {
    const planted = "const x = await adapter.complete({ prompt: 'x' });";
    expect(/\badapters?!?(?:\[[^\]]*\])?\??\.complete\s*\(/.test(planted)).toBe(true);
    expect(/\badapters?!?(?:\[[^\]]*\])?\??\.complete\s*\(/.test("replay.complete({})")).toBe(
      false,
    );
  });
});

describe("issueGatedPayload is only for the gate", () => {
  it("makes an object the gate's own set recognises, and a copy of it is not one", () => {
    const p = issueGatedPayload("x");
    expect(isGatedPayload(p)).toBe(true);
    expect(isGatedPayload({ ...p })).toBe(false);
    expect(isGatedPayload(Object.create(p))).toBe(false);
  });
});
