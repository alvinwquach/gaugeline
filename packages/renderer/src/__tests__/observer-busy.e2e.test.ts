import { existsSync, readFileSync, readdirSync } from "node:fs";
import {
  CheckRegistry,
  checkSite,
  createFetcher,
  createNetworkTransport,
  defineCheck,
  eventsConfigSchema,
  type EventsRead,
  type PageSnapshot,
} from "@gaugeline/core";
import { SITES_DIR, startFixture, type Fixture } from "@gaugeline/fixtures";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { findBrowser } from "../browser.js";
import { createPlaywrightRenderer } from "../playwright.js";

/**
 * A page that never returns after it loads must not hold the observer, or leave a browser process spinning,
 * after the observer's limit or its own time to answer. Runs only where a browser is installed.
 */
const found = findBrowser({ env: process.env, exists: existsSync, platform: process.platform });
let driver = true;
try {
  await import("playwright-core");
} catch {
  driver = false;
}

let processesSeen = 0;
/**
 * Clock ticks of CPU used so far by the processes this test process started, the browser and its helpers
 * (Linux): its descendants, so a browser another test file started in its own process is not counted.
 */
function browserTicks(): number | undefined {
  if (process.platform !== "linux") return undefined;
  const parent = new Map<number, number>();
  const ticks = new Map<number, number>();
  for (const name of readdirSync("/proc").filter((n) => /^\d+$/.test(n))) {
    try {
      const stat = readFileSync(`/proc/${name}/stat`, "utf8");
      const f = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      parent.set(Number(name), Number(f[1]));
      ticks.set(Number(name), Number(f[11]) + Number(f[12]));
    } catch {
      // the process ended
    }
  }
  const family = new Set<number>([process.pid]);
  for (let grew = true; grew;) {
    grew = false;
    for (const [pid, ppid] of parent)
      if (!family.has(pid) && family.has(ppid)) {
        family.add(pid);
        grew = true;
      }
  }
  family.delete(process.pid);
  processesSeen = family.size;
  let total = 0;
  for (const pid of family) total += ticks.get(pid) ?? 0;
  return total;
}

describe.skipIf(!driver || !found.ok)(
  "the click observer against a page that never returns",
  () => {
    let site: Fixture;
    beforeAll(async () => {
      site = await startFixture("renderer-busy");
    });
    afterAll(async () => {
      await site?.close();
    });

    async function observe(observerLimitMs?: number) {
      const renderer = createPlaywrightRenderer({
        transport: createNetworkTransport({ allowPrivate: true, target: site.origin }),
        chromiumSandbox: process.getuid?.() !== 0,
        limits: { pages: 20 },
        ...(observerLimitMs === undefined ? {} : { observerLimitMs }),
      });
      let read: EventsRead | undefined;
      const probe = defineCheck<PageSnapshot>({
        id: "busy-probe",
        area: "Visitors",
        severity: "low",
        title: "Probe",
        what: "w",
        why: "y",
        fix: "f",
        tech: "t",
        size: "S",
        done: "d",
        estimateChanges: "e",
        run: async (_p, ctx) => {
          read = await ctx.events?.();
          return [];
        },
      });
      const started = Date.now();
      await checkSite({
        address: site.origin,
        fetcher: createFetcher({ allowPrivate: true, target: site.origin }),
        registry: new CheckRegistry().register(probe),
        events: eventsConfigSchema.parse(
          JSON.parse(readFileSync(`${SITES_DIR}renderer-busy/gaugeline.events.json`, "utf8")),
        ),
        ...(renderer.observer ? { eventObserver: renderer.observer } : {}),
      });
      return { renderer, read, ms: Date.now() - started };
    }

    /** CPU the browser's processes used over the next second, as a share of one core. */
    async function share(): Promise<number | undefined> {
      const a = browserTicks();
      await new Promise((r) => setTimeout(r, 1000));
      const b = browserTicks();
      return a === undefined || b === undefined ? undefined : (b - a) / 100;
    }

    const notStarted = (read: EventsRead | undefined) =>
      read && "unchecked" in read.result && /could not start|browser/i.test(read.result.unchecked)
        ? read.result.unchecked
        : undefined;

    async function quiet() {
      const cpu = await share();
      if (cpu === undefined) return;
      // The browser's processes were found, or a low number would mean nothing.
      expect(processesSeen).toBeGreaterThan(0);
      expect(cpu).toBeLessThan(0.5);
    }

    it("gives up on a page that stops responding, says so, and leaves no process spinning", async (ctx) => {
      const { renderer, read, ms } = await observe();
      try {
        const why = notStarted(read);
        if (why) return ctx.skip(`the browser does not start here: ${why}`);
        // Each call into the page is bounded, so the whole run answers in seconds, not at the limit.
        expect(ms).toBeLessThan(60_000);
        expect(
          read && "clicks" in read.result ? read.result.clicks.map((c) => c.unobserved) : [],
        ).toEqual(
          expect.arrayContaining([expect.stringMatching(/stopped responding|could not be read/)]),
        );
        await quiet();
      } finally {
        await renderer.close();
      }
    }, 120_000);

    it("at its time limit closes the page in use and does not leave the browser spinning", async (ctx) => {
      const { renderer, read, ms } = await observe(1200);
      try {
        const why = notStarted(read);
        if (why) return ctx.skip(`the browser does not start here: ${why}`);
        // Closing the page in use ends the call that was stuck in it, so the answer is either the limit
        // itself or every click not observed because the page was closed: never a click that was watched.
        const answer = read?.result;
        if (answer && "unchecked" in answer) expect(answer.unchecked).toMatch(/longer than/);
        else
          expect(
            answer && "clicks" in answer ? answer.clicks.map((c) => c.unobserved) : [],
          ).not.toContain(undefined);
        // The limit, the time to close what was open, and the check's own work.
        expect(ms).toBeLessThan(25_000);
        await quiet();
      } finally {
        await renderer.close();
      }
    }, 120_000);
  },
);
