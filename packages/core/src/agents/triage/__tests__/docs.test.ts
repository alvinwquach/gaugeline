/**
 * The triage docs page (AG-12): the example's output is this code's real output, and the registration the
 * page tells an owner to make is the one the code enforces.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  createTriagePolicy,
  runTriage,
  TRIAGE_REGISTRATION,
  type TriageDraftCall,
} from "../index.js";
import { bakery } from "./fixtures.js";

const page = readFileSync(
  fileURLToPath(new URL("../../../../../../docs/hosted/agent-triage.md", import.meta.url)),
  "utf8",
);

/** The example on the page, run: the same calls, printed the same way. */
async function example(): Promise<string> {
  const now = () => Date.UTC(2026, 10, 13, 12);
  const drafts: TriageDraftCall[] = [];
  const outcome = await runTriage(
    { siteId: "site-bakery", findings: bakery },
    {
      policy: createTriagePolicy({ env: {}, now }),
      draft: async (call) => {
        drafts.push(call);
        return { inserted: true, draftId: `draft-${drafts.length}` };
      },
      now,
    },
  );
  return [
    ...drafts.map((d) => `${d.payload.subject}  (cites ${d.findingIds.join(", ")})`),
    `${outcome.created.length} drafts; ${outcome.plan.notTriaged} finding left out as worth knowing`,
    "",
    drafts[1]!.payload.body,
  ].join("\n");
}

describe("the docs page", () => {
  it("shows this example's real output", async () => {
    expect(page).toContain(await example());
  });

  it("the example's findings are the page's own", () => {
    for (const f of bakery) expect(page).toContain(f.title);
  });

  it("the registration it describes is the one the code enforces", () => {
    const l = TRIAGE_REGISTRATION.limits;
    expect(page).toContain(
      `calls_per_window = ${l.callsPerWindow}, window_seconds = ${l.windowMs / 1000}, cost_ceiling_micros = ${l.costCeilingMicros}, timeout_ms = ${l.timeoutMs}`,
    );
    expect(page).toContain(
      `'${TRIAGE_REGISTRATION.name}', :owner, '{${TRIAGE_REGISTRATION.scopes.join(",")}}'`,
    );
    expect(page).toMatch(/at most \*\*20 drafts\*\*/);
  });
});
