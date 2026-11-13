/**
 * The recorded fake behind the gateway (AG-19). It is the AG-09 replay (`../evals/replay.ts`), put behind the
 * adapter interface: a lookup by call id, no network, no key, no clock. `recordGateway` captures the answers
 * of a live run once (manual work, never in CI) so they can be committed and replayed; a recordings file holds
 * answers and what they cost, never a prompt, a key or a model name, and is refused if an answer holds a key.
 */
import { EvalReplayError, createReplayModel, parseRecording } from "../evals/replay.js";
import type { EvalRecording } from "../evals/types.js";
import { secretsInValue } from "../secrets.js";
import type { ModelAdapter, ModelGateway } from "./types.js";

/** The provider name of the fake. It needs no key variable and has no host. */
export const RECORDED_PROVIDER = "recorded";
/** The most recordings one file may hold. */
export const MAX_RECORDINGS = 10_000;
const CALL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/** An adapter that answers each call from `recordings` by its call id. A call with no recording is an error. */
export function createRecordedAdapter(
  recordings: ReadonlyMap<string, EvalRecording>,
): ModelAdapter {
  const replay = createReplayModel(recordings);
  return {
    provider: RECORDED_PROVIDER,
    needsKey: false,
    complete: ({ callId, model, prompt }) =>
      replay.complete({ caseId: callId, agentId: model, prompt }),
  };
}

/** A gateway that passes every call through and keeps each answer by call id (the last one wins). */
export function recordGateway(inner: ModelGateway): {
  gateway: ModelGateway;
  recordings(): Map<string, EvalRecording>;
} {
  const seen = new Map<string, EvalRecording>();
  return {
    gateway: {
      provider: inner.provider,
      budget: inner.budget,
      async complete(request) {
        const answer = await inner.complete(request);
        seen.set(request.callId, {
          text: answer.text,
          ...(answer.toolCalls
            ? { toolCalls: answer.toolCalls.map((c) => ({ tool: c.tool })) }
            : {}),
          usage: { ...answer.usage },
        });
        return answer;
      },
    },
    recordings: () => new Map(seen),
  };
}

/** The recordings as JSON text: call ids in order, so the same recordings are the same text. */
export function recordingsToJson(recordings: ReadonlyMap<string, EvalRecording>): string {
  const sorted = [...recordings].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `${JSON.stringify(Object.fromEntries(sorted), null, 2)}\n`;
}

/** The recordings in `text`, each checked. Throws EvalReplayError, never repeating what the file says. */
export function recordingsFromJson(text: string): Map<string, EvalRecording> {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new EvalReplayError("The recordings file is not JSON.");
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw))
    throw new EvalReplayError("The recordings file must be an object of call id to recording.");
  const entries = Object.entries(raw);
  if (entries.length > MAX_RECORDINGS)
    throw new EvalReplayError(`The recordings file has more than ${MAX_RECORDINGS} recordings.`);
  const out = new Map<string, EvalRecording>();
  for (const [id, value] of entries) {
    if (!CALL_ID.test(id))
      throw new EvalReplayError("A call id in the recordings file is not an id.");
    const rec = parseRecording(value);
    if (!rec) throw new EvalReplayError(`The recording for call "${id}" is not well formed.`);
    if (secretsInValue(rec.text).length > 0)
      throw new EvalReplayError(
        `The recording for call "${id}" holds something that looks like a key.`,
      );
    out.set(id, rec);
  }
  return out;
}
