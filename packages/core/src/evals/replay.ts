/**
 * The recorded fake model (AG-09): a deterministic replay keyed by case id. It looks a recording up and
 * does nothing else: no network, no key, no clock. A recording is checked when the model is built.
 */
import type { EvalModel, EvalRecording } from "./types.js";

export class EvalReplayError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EvalReplayError";
  }
}

const whole = (v: unknown): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const KEYS = ["text", "toolCalls", "usage"];
const USAGE = ["inputTokens", "outputTokens", "costMicros", "latencyMs"];

/** The recording if `raw` has exactly the recorded shape (whole non-negative numbers), else null. */
export function parseRecording(raw: unknown): EvalRecording | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (Object.keys(r).some((k) => !KEYS.includes(k)) || typeof r.text !== "string") return null;
  const u = r.usage as Record<string, unknown> | null | undefined;
  if (u === null || typeof u !== "object" || Object.keys(u).length !== USAGE.length) return null;
  if (!USAGE.every((k) => whole(u[k]))) return null;
  let toolCalls: { tool: string }[] | undefined;
  if (r.toolCalls !== undefined) {
    if (!Array.isArray(r.toolCalls)) return null;
    if (
      !r.toolCalls.every((c) => c !== null && typeof c === "object" && typeof c.tool === "string")
    )
      return null;
    toolCalls = r.toolCalls.map((c: { tool: string }) => ({ tool: c.tool }));
  }
  return {
    text: r.text,
    ...(toolCalls ? { toolCalls } : {}),
    usage: {
      inputTokens: u.inputTokens as number,
      outputTokens: u.outputTokens as number,
      costMicros: u.costMicros as number,
      latencyMs: u.latencyMs as number,
    },
  };
}

/** A model that answers each case from `recordings`. A case with no recording is refused, by name. */
export function createReplayModel(recordings: ReadonlyMap<string, EvalRecording>): EvalModel {
  const checked = new Map<string, EvalRecording>();
  for (const [id, raw] of recordings) {
    const rec = parseRecording(raw);
    if (!rec) throw new EvalReplayError(`The recording for case "${id}" is not well formed.`);
    checked.set(id, rec);
  }
  return {
    async complete({ caseId }) {
      const rec = checked.get(caseId);
      if (!rec) throw new EvalReplayError(`No recording for case "${caseId}".`);
      // A copy: nothing a caller does to the answer reaches the next replay.
      return parseRecording(rec) as EvalRecording;
    },
  };
}
