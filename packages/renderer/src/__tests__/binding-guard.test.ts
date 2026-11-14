import { describe, expect, it, vi } from "vitest";
import { BINDING_CALL_CAP, budgeted } from "../binding-guard.js";

/**
 * A function the page can call by name (the form counter, the observer's capture of a push) is reachable from any
 * script on the page, so what it costs per call and in all is bounded here, whatever the page sends.
 */
describe("budgeted: a page-callable function with a call cap", () => {
  it("passes every call up to the cap on, with its arguments", () => {
    const seen: unknown[] = [];
    const f = budgeted(
      (a: unknown, b: unknown) => seen.push([a, b]),
      () => undefined,
      3,
    );
    f(1, 2);
    f("x", { y: 1 });
    f(null, undefined);
    expect(seen).toEqual([
      [1, 2],
      ["x", { y: 1 }],
      [null, undefined],
    ]);
  });

  it("never calls the function past the cap, and says so exactly once", () => {
    const inner = vi.fn();
    const flood = vi.fn();
    const f = budgeted(inner, flood, 5);
    for (let i = 0; i < 400_000; i += 1) f(i);
    expect(inner).toHaveBeenCalledTimes(5);
    expect(flood).toHaveBeenCalledTimes(1);
  });

  it("does not touch what it ignores: a getter on an argument past the cap is never read", () => {
    let read = 0;
    const bait = {
      get t() {
        read += 1;
        return 1;
      },
    };
    const f = budgeted(
      (..._a: unknown[]) => undefined,
      () => undefined,
      1,
    );
    f({});
    for (let i = 0; i < 1000; i += 1) f(bait);
    expect(read).toBe(0);
  });

  it("is a thousand calls by default", () => {
    expect(BINDING_CALL_CAP).toBe(1000);
    const inner = vi.fn();
    const flood = vi.fn();
    const f = budgeted(inner, flood);
    for (let i = 0; i < 1001; i += 1) f();
    expect(inner).toHaveBeenCalledTimes(1000);
    expect(flood).toHaveBeenCalledTimes(1);
  });

  it("is not tripped by exactly the cap", () => {
    const flood = vi.fn();
    const f = budgeted(() => undefined, flood, 10);
    for (let i = 0; i < 10; i += 1) f();
    expect(flood).not.toHaveBeenCalled();
  });

  it("each function has its own budget", () => {
    const a = vi.fn();
    const b = vi.fn();
    const fa = budgeted(a, () => undefined, 2);
    const fb = budgeted(b, () => undefined, 2);
    for (let i = 0; i < 5; i += 1) fa();
    fb();
    expect(a).toHaveBeenCalledTimes(2);
    expect(b).toHaveBeenCalledTimes(1);
  });

  it("keeps nothing per call: a function that is called a million times keeps one counter", () => {
    const f = budgeted(
      (..._a: unknown[]) => undefined,
      () => undefined,
      1,
    );
    const before = process.memoryUsage().heapUsed;
    for (let i = 0; i < 1_000_000; i += 1) f({ big: "x".repeat(100) });
    const grown = process.memoryUsage().heapUsed - before;
    expect(grown).toBeLessThan(50_000_000);
  });

  it("a function that throws within the budget still counts the call", () => {
    const flood = vi.fn();
    const f = budgeted(
      () => {
        throw new Error("boom");
      },
      flood,
      2,
    );
    expect(() => f()).toThrow("boom");
    expect(() => f()).toThrow("boom");
    expect(() => f()).not.toThrow();
    expect(flood).toHaveBeenCalledTimes(1);
  });
});
