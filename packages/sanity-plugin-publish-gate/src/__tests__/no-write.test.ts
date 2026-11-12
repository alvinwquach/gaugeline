import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const src = fileURLToPath(new URL("..", import.meta.url));
const files = readdirSync(src).filter((f) => f.endsWith(".ts"));
const text = files.map((f) => readFileSync(join(src, f), "utf8")).join("\n");

describe("the package cannot write", () => {
  it("has source files to look at", () => {
    expect(files).toEqual(expect.arrayContaining(["resolve.ts", "check.ts", "function.ts"]));
  });

  it("imports no Sanity client and no HTTP module, so it has nothing to write with", () => {
    expect(text).not.toMatch(
      /from "@sanity\/client"|from "sanity"|from "node:https?"|from "node:net"/,
    );
  });

  it("calls no mutation, no patch, and sends no method other than the fetcher's GET and HEAD", () => {
    expect(text).not.toMatch(
      /\.mutate\(|\.patch\(|\.createOrReplace\(|\.createIfNotExists\(|\.transaction\(|\.publish\(/,
    );
    expect(text).not.toMatch(/method:\s*["'](POST|PUT|PATCH|DELETE)/i);
    expect(text).not.toMatch(/\bfetch\(/);
  });

  it("the Studio's request is one GET with no credentials, no redirect and no body", () => {
    const request = readFileSync(join(src, "request.ts"), "utf8");
    expect(request).toMatch(/method: "GET"/);
    expect(request).toMatch(/credentials: "omit"/);
    expect(request).toMatch(/redirect: "error"/);
    expect(request).toMatch(/referrerPolicy: "no-referrer"/);
    expect(request).not.toMatch(
      /\bbody:|XMLHttpRequest|sendBeacon|WebSocket|localStorage|document\.cookie/,
    );
    // The one place the browser's fetch is named: every other file reaches the network through this one.
    const others = files.filter((f) => f !== "request.ts" && f !== "check.ts");
    for (const f of others)
      expect(readFileSync(join(src, f), "utf8"), f).not.toMatch(/globalThis\.fetch|\bsend\(/);
  });

  it("the Studio side stores nothing and parses no markup", () => {
    for (const f of ["publish-action.ts", "gate-state.ts", "held-message.ts", "plugin.ts"])
      expect(readFileSync(join(src, f), "utf8"), f).not.toMatch(
        /localStorage|sessionStorage|indexedDB|document\.cookie|dangerouslySetInnerHTML|innerHTML|insertAdjacentHTML|eval\(|new Function/,
      );
  });

  it("the endpoint answers a GET and never reads a request body", () => {
    const endpoint = readFileSync(join(src, "endpoint.ts"), "utf8");
    expect(endpoint).toMatch(/request\.method !== "GET"/);
    expect(endpoint).not.toMatch(/request\.(json|text|formData|arrayBuffer|blob|body)\b/);
  });

  it("never reads the Function's context, where its token is", () => {
    expect(text).not.toMatch(/clientOptions|\.context\b|\.token\b/);
  });
});
