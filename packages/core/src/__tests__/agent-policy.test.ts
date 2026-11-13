/**
 * The agent policy (AG-03 part 2): a pure decision, taken before an agent's call runs. No I/O: the clock and
 * the environment are handed in, and every deny goes to the sink handed in.
 */
import { describe, expect, it } from "vitest";
import {
  AGENT_DENY_REASONS,
  AGENTS_OFF_ENV,
  MAX_COST_MICROS,
  agentsOff,
  createAgentPolicy,
  isAgentDenyReason,
  type AgentDenyLog,
  type AgentPolicyConfig,
  type AgentRule,
} from "../agent-policy.js";

const T0 = Date.UTC(2026, 10, 13, 9, 0, 0);
const DAY = 86_400_000;
const TOOLS = ["read:runs", "draft:email", "draft:pull_request"] as const;
const LIMITS = { callsPerWindow: 3, windowMs: 60_000, costCeilingMicros: 1_000, timeoutMs: 5_000 };

function setup(
  rules: Record<string, Partial<AgentRule>> = { menu: {} },
  extra: Partial<AgentPolicyConfig> = {},
) {
  let now = T0;
  const env: Record<string, string | undefined> = {};
  const log: AgentDenyLog[] = [];
  const agents = new Map(
    Object.entries(rules).map(([id, r]) => [
      id,
      { status: "active", tools: ["draft:email"], limits: LIMITS, ...r } as AgentRule,
    ]),
  );
  const policy = createAgentPolicy({
    tools: TOOLS,
    agents,
    env,
    now: () => now,
    onDeny: (e) => log.push(e),
    ...extra,
  });
  const call = (over: Record<string, unknown> = {}) =>
    policy.decide({ agentId: "menu", tool: "draft:email", costMicros: 0, ...over } as never);
  return {
    policy,
    env,
    log,
    call,
    tick: (ms: number) => (now += ms),
    set: (t: number) => (now = t),
  };
}

describe("the closed list of reasons", () => {
  it("is the SQL's list, in the same words", () => {
    expect([...AGENT_DENY_REASONS].sort()).toEqual(
      [
        "unknown-agent",
        "revoked",
        "disabled",
        "scope",
        "tool-not-allowed",
        "rate-limit",
        "cost-ceiling",
        "timeout",
        "kill-switch-agent",
        "kill-switch-global",
        "bad-input",
      ].sort(),
    );
    expect(isAgentDenyReason("scope")).toBe(true);
    for (const v of ["Scope", "", null, 1, "allowed"]) expect(isAgentDenyReason(v)).toBe(false);
  });
});

describe("deny by default", () => {
  it("failing fixture: an agent with no tools is refused for scope, and the deny is logged", () => {
    const s = setup({ menu: { tools: [] } });
    const d = s.call();
    expect(d).toMatchObject({
      allowed: false,
      reason: "scope",
      agentId: "menu",
      tool: "draft:email",
    });
    expect(s.log).toEqual([
      { at: new Date(T0).toISOString(), agentId: "menu", tool: "draft:email", reason: "scope" },
    ]);
  });

  it("passing fixture: an agent with the tool is allowed, with a deadline, and nothing is logged", () => {
    const s = setup();
    expect(s.call()).toEqual({
      allowed: true,
      reason: null,
      agentId: "menu",
      tool: "draft:email",
      at: T0,
      deadlineMs: T0 + LIMITS.timeoutMs,
    });
    expect(s.log).toEqual([]);
  });

  it("an empty policy refuses everyone", () => {
    const s = setup({});
    expect(s.call().reason).toBe("unknown-agent");
  });
});

describe("each reason", () => {
  it("unknown-agent: the caller's id is neither echoed nor logged", () => {
    const s = setup();
    for (const id of ["someone", "", null, undefined, 42, { toString: () => "menu" }])
      expect(s.call({ agentId: id })).toMatchObject({ reason: "unknown-agent", agentId: null });
    expect(s.log.every((e) => e.agentId === null)).toBe(true);
  });

  it("revoked wins over the global switch, disabled and a stop", () => {
    const s = setup({ menu: { status: "revoked", stopped: true } });
    s.env[AGENTS_OFF_ENV] = "1";
    expect(s.call().reason).toBe("revoked");
  });

  it("kill-switch-global comes before disabled; disabled before kill-switch-agent", () => {
    const s = setup({ menu: { status: "disabled", stopped: true } });
    s.env[AGENTS_OFF_ENV] = "1";
    expect(s.call().reason).toBe("kill-switch-global");
    delete s.env[AGENTS_OFF_ENV];
    expect(s.call().reason).toBe("disabled");
    const t = setup({ menu: { stopped: true } });
    expect(t.call().reason).toBe("kill-switch-agent");
  });

  it("bad-input: no tool, a long tool, a missing, negative, fractional, NaN or huge cost", () => {
    const s = setup();
    for (const over of [
      { tool: undefined },
      { tool: 7 },
      { tool: "x".repeat(65) },
      { costMicros: undefined },
      { costMicros: -1 },
      { costMicros: 0.5 },
      { costMicros: Number.NaN },
      { costMicros: Number.POSITIVE_INFINITY },
      { costMicros: MAX_COST_MICROS + 1 },
      { costMicros: Number.MAX_SAFE_INTEGER + 2 },
      { costMicros: "0" },
      { costMicros: 10n },
      { receivedAtMs: Number.NaN },
    ])
      expect(
        s.call(over).reason,
        JSON.stringify(over, (_, v) => String(v)),
      ).toBe("bad-input");
    // A tool name that is not on the closed list is never logged: it is the caller's text.
    expect(s.log.slice(0, 3).map((e) => e.tool)).toEqual([null, null, null]);
    expect(s.log[3]?.tool).toBe("draft:email");
  });

  it("tool-not-allowed: a name not on the closed list; scope: on the list but not the agent's", () => {
    const s = setup();
    expect(s.call({ tool: "publish_now" })).toMatchObject({
      reason: "tool-not-allowed",
      tool: null,
    });
    expect(s.call({ tool: "draft:pull_request" })).toMatchObject({
      reason: "scope",
      tool: "draft:pull_request",
    });
    // A rule naming a tool off the closed list does not make it callable.
    const t = setup({ menu: { tools: ["publish_now"] } });
    expect(t.call({ tool: "publish_now" }).reason).toBe("tool-not-allowed");
  });

  it("timeout: a call that waited longer than the agent's timeout before it was decided", () => {
    const s = setup();
    expect(s.call({ receivedAtMs: T0 - LIMITS.timeoutMs }).allowed).toBe(true);
    expect(s.call({ receivedAtMs: T0 - LIMITS.timeoutMs - 1 }).reason).toBe("timeout");
  });

  it("rate-limit: the call after the last place in the window; refused calls do not count", () => {
    const s = setup();
    s.call({ tool: "draft:pull_request" });
    for (let i = 0; i < LIMITS.callsPerWindow; i++) expect(s.call().allowed).toBe(true);
    expect(s.call()).toMatchObject({ allowed: false, reason: "rate-limit" });
  });

  it("cost-ceiling: the call that would pass the day's ceiling; exactly the ceiling is allowed", () => {
    const s = setup({ menu: { limits: { ...LIMITS, callsPerWindow: 100 } } });
    expect(s.call({ costMicros: 600 }).allowed).toBe(true);
    expect(s.call({ costMicros: 401 }).reason).toBe("cost-ceiling");
    expect(s.call({ costMicros: 400 }).allowed).toBe(true);
    expect(s.call({ costMicros: 1 }).reason).toBe("cost-ceiling");
    expect(s.call({ costMicros: 0 }).allowed).toBe(true);
  });

  it("calls_per_window 0 stops an agent without touching its status", () => {
    const s = setup({ menu: { limits: { ...LIMITS, callsPerWindow: 0 } } });
    expect(s.call().reason).toBe("rate-limit");
  });

  it("every reason the code can give is on the closed list, and every deny reaches the sink once", () => {
    const s = setup();
    const seen = new Set<string>();
    for (let i = 0; i < 8; i++) {
      const d = s.call(i % 2 ? { tool: "nope" } : {});
      if (d.reason) seen.add(d.reason);
    }
    expect([...seen].sort()).toEqual(["rate-limit", "tool-not-allowed"]);
    expect([...seen].every(isAgentDenyReason)).toBe(true);
    // Allowed at 0, 2 and 4; denied at 1, 3, 5, 6 and 7.
    expect(s.log).toHaveLength(5);
  });
});

describe("the clock", () => {
  it("a new window starts once the old one has ended", () => {
    const s = setup();
    for (let i = 0; i < 3; i++) s.call();
    expect(s.call().reason).toBe("rate-limit");
    s.tick(LIMITS.windowMs - 1);
    expect(s.call().reason).toBe("rate-limit");
    s.tick(1);
    expect(s.call().allowed).toBe(true);
  });

  it("the cost resets at midnight UTC, not before", () => {
    const s = setup({ menu: { limits: { ...LIMITS, callsPerWindow: 100 } } });
    const midnight = Math.ceil(T0 / DAY) * DAY;
    expect(s.call({ costMicros: 1_000 }).allowed).toBe(true);
    s.set(midnight - 1);
    expect(s.call({ costMicros: 1 }).reason).toBe("cost-ceiling");
    s.set(midnight);
    expect(s.call({ costMicros: 1_000 }).allowed).toBe(true);
  });

  it("a clock that goes back opens no new window and forgets no cost (fail closed)", () => {
    const s = setup();
    for (let i = 0; i < 3; i++) s.call({ costMicros: 300 });
    s.set(T0 - DAY);
    expect(s.call().reason).toBe("rate-limit");
    s.set(T0 + LIMITS.windowMs);
    expect(s.call({ costMicros: 101 }).reason).toBe("cost-ceiling");
  });

  it("a clock that returns NaN or Infinity denies: no deadline can be kept", () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY]) {
      const s = setup();
      s.set(bad);
      expect(s.call().reason).toBe("timeout");
    }
  });
});

describe("concurrent-looking calls", () => {
  it("fifty calls started together take exactly the window's places", async () => {
    const s = setup({ menu: { limits: { ...LIMITS, callsPerWindow: 7 } } });
    const out = await Promise.all(
      Array.from({ length: 50 }, () => Promise.resolve().then(() => s.call())),
    );
    expect(out.filter((d) => d.allowed)).toHaveLength(7);
    expect(s.log).toHaveLength(43);
  });

  it("two agents keep separate windows and costs", () => {
    const s = setup({ menu: {}, hours: {} });
    for (let i = 0; i < 3; i++) s.call();
    expect(s.call().reason).toBe("rate-limit");
    expect(s.call({ agentId: "hours" }).allowed).toBe(true);
  });
});

describe("memory", () => {
  it("unknown callers add nothing: state is one entry per registered agent at most", () => {
    const s = setup({ menu: {}, hours: {} });
    for (let i = 0; i < 10_000; i++) s.call({ agentId: `anon-${i}` });
    expect(s.policy.tracked()).toBe(0);
    s.call();
    s.call({ agentId: "hours" });
    s.call({ agentId: "hours", tool: "draft:pull_request" });
    expect(s.policy.tracked()).toBe(2);
  });

  it("refuses a configuration with more agents than it may track", () => {
    expect(() => setup({ a: {}, b: {} }, { maxTracked: 1 })).toThrow(/at most 1 agent/);
  });
});

describe("configuration", () => {
  it("refuses limits that are not whole numbers in range", () => {
    for (const bad of [
      { callsPerWindow: -1 },
      { callsPerWindow: 1.5 },
      { windowMs: 0 },
      { costCeilingMicros: MAX_COST_MICROS + 1 },
      { costCeilingMicros: Number.NaN },
      { timeoutMs: 99 },
    ])
      expect(() => setup({ menu: { limits: { ...LIMITS, ...bad } } }), JSON.stringify(bad)).toThrow(
        /limit/,
      );
  });

  it("refuses an unknown status", () => {
    expect(() => setup({ menu: { status: "paused" as never } })).toThrow(/status/);
  });

  it("logs nothing but time, ids, tool and reason", () => {
    const s = setup();
    s.call({ tool: "draft:pull_request", costMicros: 5, payload: "secret page text" });
    expect(Object.keys(s.log[0] ?? {}).sort()).toEqual(["agentId", "at", "reason", "tool"]);
  });

  it("a sink that throws does not turn a deny into an allow", () => {
    const s = setup(
      { menu: { tools: [] } },
      {
        onDeny: () => {
          throw new Error("disk full");
        },
      },
    );
    expect(s.call()).toMatchObject({ allowed: false, reason: "scope" });
  });
});

describe("the global kill switch", () => {
  it("is read at every call: set, then unset", () => {
    const s = setup();
    expect(s.call().allowed).toBe(true);
    s.env[AGENTS_OFF_ENV] = "1";
    expect(s.call().reason).toBe("kill-switch-global");
    delete s.env[AGENTS_OFF_ENV];
    expect(s.call().allowed).toBe(true);
  });

  it("only unset or exactly 0 leaves agents on; anything else, garbled included, stops them", () => {
    expect(agentsOff({})).toBe(false);
    expect(agentsOff({ [AGENTS_OFF_ENV]: undefined })).toBe(false);
    expect(agentsOff({ [AGENTS_OFF_ENV]: "0" })).toBe(false);
    for (const v of ["1", "", " 0", "0 ", "00", "false", "no", "off", "\u0000", "0\n"])
      expect(agentsOff({ [AGENTS_OFF_ENV]: v }), JSON.stringify(v)).toBe(true);
  });

  it("an environment that cannot be read stops every agent", () => {
    const env = new Proxy(
      {},
      {
        get() {
          throw new Error("unreadable");
        },
      },
    );
    expect(agentsOff(env)).toBe(true);
    expect(agentsOff(null as never)).toBe(true);
    const s = setup({ menu: {} }, { env });
    expect(s.call().reason).toBe("kill-switch-global");
  });
});
