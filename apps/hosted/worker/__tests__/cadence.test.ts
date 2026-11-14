/**
 * Unit: the morning email's cadence beside the pool. Nothing waits on real time: the clock is a variable the
 * test moves and the step is a gated stand-in.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { morningCadence } from "../email/cadence.js";

const EVERY = 5 * 60_000;
const gate = () => {
  let open: () => void = () => {};
  const promise = new Promise<void>((r) => (open = r));
  return { promise, open };
};

describe("morningCadence", () => {
  afterEach(() => vi.restoreAllMocks());

  it("runs the step on the first look, then only once the cadence has passed", async () => {
    let t = Date.parse("2026-11-12T06:00:00Z");
    const seen: number[] = [];
    const c = morningCadence(
      async (now) => void seen.push(now.getTime()),
      () => new Date(t),
      EVERY,
    );
    c.tick();
    await c.settled();
    expect(seen).toEqual([t]);
    t += EVERY - 1;
    c.tick(); // one millisecond early
    await c.settled();
    expect(seen).toHaveLength(1);
    t += 1;
    c.tick();
    await c.settled();
    expect(seen).toEqual([t - EVERY, t]);
  });

  it("returns at once while the step is slow, and never starts a second copy beside it", async () => {
    let t = 0;
    const g = gate();
    let started = 0;
    const c = morningCadence(
      async () => {
        started += 1;
        await g.promise;
      },
      () => new Date(t),
      EVERY,
    );
    c.tick(); // does not wait for the step: a free slot is never held by it
    t += 10 * EVERY;
    c.tick(); // due again, but one is running
    expect(started).toBe(1);
    g.open();
    await c.settled();
    c.tick();
    await c.settled();
    expect(started).toBe(2);
  });

  it("a step that throws (or rejects) is swallowed, logged without its own words, and tried again when due", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    let t = 0;
    let calls = 0;
    const c = morningCadence(
      async () => {
        calls += 1;
        if (calls === 1) throw new Error("boom with the secret-words in it");
        if (calls === 2) throw undefined;
      },
      () => new Date(t),
      EVERY,
    );
    for (let i = 0; i < 3; i++) {
      expect(() => c.tick()).not.toThrow();
      await expect(c.settled()).resolves.toBeUndefined();
      t += EVERY;
    }
    expect(calls).toBe(3);
    expect(log).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(log.mock.calls)).not.toContain("secret-words");
  });

  it("a step that throws synchronously is swallowed too", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const c = morningCadence(
      () => {
        throw new Error("sync");
      },
      () => new Date(0),
      EVERY,
    );
    expect(() => c.tick()).not.toThrow();
    await c.settled();
  });
});
