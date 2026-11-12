import { describe, expect, it } from "vitest";
import { couldNotCheck, type GateAnswer } from "../answer.js";
import { GATE_STATES, IDLE, canPublish, gateReduce, type GateState } from "../gate-state.js";

const URL1 = "https://lantern-yard.example/menu";
const finding = {
  id: "broken-links",
  severity: "high" as const,
  title: "A link on the page is dead",
  evidence: "returned 404",
  url: `${URL1}/old`,
};
const base = { version: 1 as const, url: URL1, checkedAt: "2026-11-12T10:00:00.000Z" };
const clean: GateAnswer = { ...base, status: "clean", findings: [] };
const found: GateAnswer = { ...base, status: "findings", findings: [finding] };
const stopped = couldNotCheck(URL1, "The page answered 503.");

const checking: GateState = { name: "checking", url: URL1 };
const state = (name: GateState["name"]): GateState => {
  switch (name) {
    case "idle":
      return IDLE;
    case "checking":
      return checking;
    case "clean":
      return { name, answer: clean };
    case "findings":
      return { name, answer: found };
    case "could-not-check":
      return { name, answer: stopped };
    case "override-confirmed":
      return { name, answer: found };
  }
};

describe("the gate's state machine", () => {
  it("names six states, and the docs table lists the same six", () => {
    expect(GATE_STATES).toEqual([
      "idle",
      "checking",
      "clean",
      "findings",
      "could-not-check",
      "override-confirmed",
    ]);
  });

  it("idle -> checking -> clean, findings or could-not-check by what the answer says", () => {
    expect(gateReduce(IDLE, { type: "check", url: URL1 })).toEqual(checking);
    expect(gateReduce(checking, { type: "answer", answer: clean }).name).toBe("clean");
    expect(gateReduce(checking, { type: "answer", answer: found }).name).toBe("findings");
    expect(gateReduce(checking, { type: "answer", answer: stopped }).name).toBe("could-not-check");
  });

  it("a check can start from every state but checking, and always forgets an earlier override", () => {
    for (const name of GATE_STATES) {
      const next = gateReduce(state(name), { type: "check", url: URL1 });
      expect(next, name).toEqual(checking);
    }
  });

  it("an answer is taken only while checking, and only about the page that was asked", () => {
    for (const name of GATE_STATES.filter((n) => n !== "checking")) {
      const held = state(name);
      expect(gateReduce(held, { type: "answer", answer: clean }), name).toBe(held);
    }
    const other = { ...clean, url: "https://lantern-yard.example/shop" };
    expect(gateReduce(checking, { type: "answer", answer: other })).toBe(checking);
  });

  it("only a held page can be overridden, and only by a confirm event", () => {
    expect(gateReduce(state("findings"), { type: "confirm-override" })).toEqual({
      name: "override-confirmed",
      answer: found,
    });
    expect(gateReduce(state("could-not-check"), { type: "confirm-override" })).toEqual({
      name: "override-confirmed",
      answer: stopped,
    });
    for (const name of ["idle", "checking", "clean", "override-confirmed"] as const) {
      const held = state(name);
      expect(gateReduce(held, { type: "confirm-override" }), name).toBe(held);
    }
  });

  it("reset (the document changed) returns every state to idle", () => {
    for (const name of GATE_STATES)
      expect(gateReduce(state(name), { type: "reset" }), name).toBe(IDLE);
  });

  it("publishing is allowed only when clean or after a confirmed override", () => {
    expect(GATE_STATES.filter((n) => canPublish(state(n)))).toEqual([
      "clean",
      "override-confirmed",
    ]);
  });

  it("failing open lets a check that could not run through, and nothing else", () => {
    expect(GATE_STATES.filter((n) => canPublish(state(n), true))).toEqual([
      "clean",
      "could-not-check",
      "override-confirmed",
    ]);
  });
});
