/**
 * The Publish button's state, as a pure function: the same state and event always give the same
 * next state, and nothing here reads or writes anything outside it. The state lives in the Studio's
 * memory for one session. An override is one transition from one held state; it is not recorded
 * anywhere (no dataset, no storage, no request).
 */
import type { GateAnswer } from "./answer.js";

export const GATE_STATES = [
  "idle",
  "checking",
  "clean",
  "findings",
  "could-not-check",
  "override-confirmed",
] as const;

export type GateState =
  /** Nothing asked yet, or the document changed since the last answer. */
  | { name: "idle" }
  /** One question is out, about this page. */
  | { name: "checking"; url: string }
  /** The page is right. Publish goes through. */
  | { name: "clean"; answer: GateAnswer }
  /** The page has problems at or above `blockOn`. Publish is held. */
  | { name: "findings"; answer: GateAnswer }
  /** The check did not run. Never a pass: held unless the config fails open. */
  | { name: "could-not-check"; answer: GateAnswer }
  /** A person confirmed publishing anyway, for this document as it stands. */
  | { name: "override-confirmed"; answer: GateAnswer };

export type GateEvent =
  | { type: "check"; url: string }
  | { type: "answer"; answer: GateAnswer }
  /** Sent only by the confirm button of the override dialog. */
  | { type: "confirm-override" }
  /** The document changed: forget the answer and any override. */
  | { type: "reset" };

export const IDLE: GateState = { name: "idle" };

export function gateReduce(state: GateState, event: GateEvent): GateState {
  switch (event.type) {
    case "check":
      return { name: "checking", url: event.url };
    case "answer":
      // Only the question that is out, and only about the page that was asked: a late or mixed-up answer is dropped.
      if (state.name !== "checking" || event.answer.url !== state.url) return state;
      return event.answer.status === "clean"
        ? { name: "clean", answer: event.answer }
        : { name: event.answer.status, answer: event.answer };
    case "confirm-override":
      return state.name === "findings" || state.name === "could-not-check"
        ? { name: "override-confirmed", answer: state.answer }
        : state;
    case "reset":
      return IDLE;
  }
}

/** Whether Sanity's own Publish may run. `failOpen` lets a check that could not run through. */
export function canPublish(state: GateState, failOpen = false): boolean {
  return (
    state.name === "clean" ||
    state.name === "override-confirmed" ||
    (failOpen && state.name === "could-not-check")
  );
}
