/**
 * Unit: the worker's pool loop, with gated stand-ins for claiming and working. Nothing here depends on
 * how fast the machine is: every step waits for a state, never for a time, and the idle timer is set far
 * beyond the test so a loop that sleeps instead of looking again fails by timing out, every time.
 */
import { describe, expect, it, vi } from "vitest";
import { runPool } from "../pool.js";

const gate = () => {
  let open: () => void = () => {};
  const promise = new Promise<void>((r) => (open = r));
  return { promise, open };
};
const NEVER = 10 * 60_000;
const until = (check: () => void) => vi.waitFor(check, { timeout: 5000, interval: 5 });

describe("runPool", () => {
  it("a job that finishes while the loop is claiming does not leave a due job waiting for the idle timer", async () => {
    const stop = new AbortController();
    const slow = gate();
    const fast = gate();
    const claim2 = gate();
    const started: string[] = [];
    const queue = ["slow", "fast"];
    let claims = 0;
    const pool = runPool<string>({
      signal: stop.signal,
      limit: 2,
      idleMs: NEVER,
      claim: async (free) => {
        claims += 1;
        if (claims === 2) {
          // The claim is in flight (it has already looked at the table) while a job finishes and a new one arrives.
          await claim2.promise;
          return [];
        }
        return queue.splice(0, free);
      },
      work: async (job) => {
        started.push(job);
        if (job === "slow") await slow.promise;
        if (job === "fast") await fast.promise;
      },
    });
    try {
      await until(() => expect(started).toEqual(["slow", "fast"]));
      fast.open(); // a slot frees; the loop begins its second claim
      await until(() => expect(claims).toBe(2));
      slow.open(); // both jobs are done before the claim answers
      await until(() => expect(started).toEqual(["slow", "fast"]));
      queue.push("late"); // a job that became due after the claim looked
      claim2.open(); // the claim comes back empty
      // The loop must look again at once, not sleep on a drained queue with two free slots.
      await until(() => expect(started).toEqual(["slow", "fast", "late"]));
    } finally {
      slow.open();
      fast.open();
      stop.abort();
      await pool;
    }
  });

  it("a claim that fills the free slot while another job settled still looks again: the due job behind it is not left queued", async () => {
    // The failure seen in CI: limit 2, one gated slow job and three fast ones. The claim in flight takes the
    // slow job; the fast job beside it finishes meanwhile; the last fast job is still queued and due.
    const stop = new AbortController();
    const slow = gate();
    const fastA = gate();
    const fastB = gate();
    const claim2 = gate();
    const started: string[] = [];
    const queue = ["slow", "fastC"];
    const finished: string[] = [];
    let claims = 0;
    const pool = runPool<string>({
      signal: stop.signal,
      limit: 2,
      idleMs: NEVER,
      claim: async (free) => {
        claims += 1;
        if (claims === 1) return ["fastA", "fastB"];
        if (claims === 2) {
          await claim2.promise;
          return queue.splice(0, 1); // took "slow"; "fastC" stays queued
        }
        return queue.splice(0, free);
      },
      work: async (job) => {
        started.push(job);
        const held = ({ slow, fastA, fastB } as Record<string, ReturnType<typeof gate>>)[job];
        if (held) await held.promise;
        finished.push(job);
      },
    });
    try {
      await until(() => expect(started).toEqual(["fastA", "fastB"]));
      fastA.open(); // a slot frees: the second claim starts
      await until(() => expect(claims).toBe(2));
      fastB.open(); // the other fast job finishes while the claim is in flight
      await until(() => expect(finished).toEqual(["fastA", "fastB"]));
      claim2.open(); // the claim answers with the slow job only
      await until(() => expect(started).toContain("slow"));
      // One slot is held by the gated slow job, one is free, and fastC is due: it must start.
      await until(() => expect(started).toContain("fastC"));
    } finally {
      slow.open();
      stop.abort();
      await pool;
    }
  });

  it("never runs more than `limit` jobs at once, and starts the next the moment one settles", async () => {
    const stop = new AbortController();
    const gates = new Map<number, ReturnType<typeof gate>>();
    const queue = [1, 2, 3, 4, 5];
    let live = 0;
    let peak = 0;
    const done: number[] = [];
    const pool = runPool<number>({
      signal: stop.signal,
      limit: 2,
      idleMs: NEVER,
      claim: async (free) => queue.splice(0, free),
      work: async (n) => {
        live += 1;
        peak = Math.max(peak, live);
        const g = gate();
        gates.set(n, g);
        await g.promise;
        live -= 1;
        done.push(n);
      },
    });
    try {
      await until(() => expect([...gates.keys()]).toEqual([1, 2]));
      gates.get(2)!.open();
      await until(() => expect([...gates.keys()]).toEqual([1, 2, 3]));
      gates.get(3)!.open();
      await until(() => expect([...gates.keys()]).toEqual([1, 2, 3, 4]));
      for (const n of [1, 4]) gates.get(n)!.open();
      await until(() => expect([...gates.keys()]).toEqual([1, 2, 3, 4, 5]));
      gates.get(5)!.open();
      await until(() => expect(done).toHaveLength(5));
      expect(peak).toBe(2);
    } finally {
      for (const g of gates.values()) g.open();
      stop.abort();
      await pool;
    }
  });

  it("a drained queue is looked at again when a job settles, not only when the idle timer fires", async () => {
    const stop = new AbortController();
    const first = gate();
    const queue: string[] = ["a"];
    const ran: string[] = [];
    const pool = runPool<string>({
      signal: stop.signal,
      limit: 3,
      idleMs: NEVER,
      claim: async (free) => queue.splice(0, free),
      work: async (j) => {
        ran.push(j);
        if (j === "a") await first.promise;
      },
    });
    try {
      await until(() => expect(ran).toEqual(["a"]));
      queue.push("b"); // arrives while the queue was drained; only a settling job wakes the loop
      first.open();
      await until(() => expect(ran).toEqual(["a", "b"]));
    } finally {
      first.open();
      stop.abort();
      await pool;
    }
  });

  it("stops claiming on abort and waits for the jobs in hand", async () => {
    const stop = new AbortController();
    const g = gate();
    let finished = false;
    const queue = ["a", "b"];
    let claims = 0;
    const pool = runPool<string>({
      signal: stop.signal,
      limit: 2,
      idleMs: NEVER,
      claim: async (free) => {
        claims += 1;
        return queue.splice(0, free);
      },
      work: async () => {
        await g.promise;
        finished = true;
      },
    });
    await until(() => expect(claims).toBe(1));
    stop.abort();
    let returned = false;
    void pool.then(() => (returned = true));
    await new Promise((r) => setTimeout(r, 20));
    expect(returned).toBe(false);
    g.open();
    await pool;
    expect(finished).toBe(true);
    expect(claims).toBe(1);
  });

  it("a job that throws stops the pool after the jobs in hand settle, and the error is raised", async () => {
    const stop = new AbortController();
    const g = gate();
    let held = false;
    const queue = ["bad", "held"];
    const pool = runPool<string>({
      signal: stop.signal,
      limit: 2,
      idleMs: NEVER,
      claim: async (free) => queue.splice(0, free),
      work: async (j) => {
        if (j === "bad") throw new Error("boom");
        await g.promise;
        held = true;
      },
    });
    const outcome = pool.then(
      () => "ok",
      (e: Error) => e.message,
    );
    await new Promise((r) => setTimeout(r, 20));
    g.open();
    expect(await outcome).toBe("boom");
    expect(held).toBe(true);
  });
});
