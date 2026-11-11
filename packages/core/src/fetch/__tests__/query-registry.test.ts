import { describe, expect, it } from "vitest";
import { registerQueryAllow, resolveQueryAllow } from "../query-registry.js";
import { allowProblems } from "../read-only-query.js";

/**
 * ADR-0006, Amendment 1: the registry fixes the method of a query entry. An adapter's entry has no
 * `method` field, so no adapter file ever writes the verb; the stored entry says POST, and an entry
 * that passes a `method` of its own (any value) is refused.
 */
const DOCS = { url: "https://dev.vendor.example/query-items", checked: "2026-11-11" } as const;
const BODY = { kind: "graphql-query" } as const;

describe("registerQueryAllow fixes the method", () => {
  it("takes an entry with no method and stores it with the method POST", () => {
    const entry = registerQueryAllow({
      id: "reg-fixed-method",
      host: "api.vendor.example",
      path: "/graphql",
      body: BODY,
      docs: DOCS,
    });
    expect(entry.method).toBe("POST");
    expect(resolveQueryAllow("reg-fixed-method")).toBe(entry);
    expect(Object.isFrozen(entry)).toBe(true);
  });

  it("registering the same method-less entry again (a module loaded twice) gives back the stored one", () => {
    const write = () =>
      registerQueryAllow({
        id: "reg-twice",
        host: "api.vendor.example",
        path: "/graphql",
        body: BODY,
        docs: DOCS,
      });
    expect(write()).toBe(write());
  });

  it("refuses an entry that passes a method, whatever the value, POST included", () => {
    for (const method of ["POST", "post", "PUT", "PATCH", "DELETE", "GET", "", undefined, null]) {
      expect(
        () =>
          registerQueryAllow({
            id: "reg-with-method",
            // @ts-expect-error the entry type has no `method`: the registry fixes it.
            method,
            host: "api.vendor.example",
            path: "/graphql",
            body: BODY,
            docs: DOCS,
          }),
        String(method),
      ).toThrow(/method is fixed by the registry/);
    }
    expect(resolveQueryAllow("reg-with-method")).toBeUndefined();
  });

  it("refuses a method smuggled in by a spread, and one that is an inherited or non-enumerable key", () => {
    const base = { id: "reg-spread", host: "api.vendor.example", path: "/graphql" } as const;
    const extra = { method: "POST" };
    expect(() =>
      registerQueryAllow({ ...base, ...extra, body: BODY, docs: DOCS } as never),
    ).toThrow(/method is fixed by the registry/);
    const hidden = { ...base, body: BODY, docs: DOCS };
    Object.defineProperty(hidden, "method", { value: "POST", enumerable: false });
    expect(() => registerQueryAllow(hidden as never)).toThrow(/method is fixed by the registry/);
    expect(resolveQueryAllow("reg-spread")).toBeUndefined();
  });

  it("allowProblems names the method key as a problem on an entry an adapter wrote", () => {
    const entry = {
      id: "x-entry",
      host: "api.vendor.example",
      path: "/graphql",
      body: BODY,
      docs: DOCS,
    };
    expect(allowProblems(entry)).toEqual([]);
    expect(allowProblems({ ...entry, method: "POST" } as never)).toEqual([
      expect.stringMatching(/method is fixed by the registry/),
    ]);
  });

  it("the stored entry still passes allowProblems as a stored entry, and a stored PUT does not", () => {
    const entry = registerQueryAllow({
      id: "reg-stored",
      host: "api.vendor.example",
      path: "/graphql",
      body: BODY,
      docs: DOCS,
    });
    expect(allowProblems(entry, { stored: true })).toEqual([]);
    expect(allowProblems({ ...entry, method: "PUT" } as never, { stored: true })).not.toEqual([]);
  });
});
