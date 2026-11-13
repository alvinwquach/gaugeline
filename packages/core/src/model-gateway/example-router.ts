/**
 * The program shown in the routing section of docs/model-gateway.md. A test runs it and compares what it
 * returns with the page, word for word, and checks that every line of the page's code is a line of this file.
 */
import {
  ModelGatewayError,
  createGateway,
  createRecordedAdapter,
  createRouter,
  type AnswerCheck,
} from "./index.js";

export async function runRoutingExample(): Promise<string> {
  const usage = { inputTokens: 40, outputTokens: 12, costMicros: 900, latencyMs: 300 };
  const answer = (text: string) => ({ text, usage });
  // A gateway over answers recorded once, keyed by call id. The second call of a task is "<id>:escalated".
  // `down` lists the calls this provider does not answer in time: a timeout is an outage.
  const gatewayOf = (provider: string, answers: [string, string][], down: string[] = []) => {
    const recorded = createRecordedAdapter(new Map(answers.map(([id, t]) => [id, answer(t)])));
    return createGateway({
      config: { provider, tiers: { fast: `${provider}-small`, strong: `${provider}-large` } },
      adapters: [
        {
          ...recorded,
          provider,
          complete: (call) =>
            down.includes(call.callId)
              ? Promise.reject(
                  new ModelGatewayError("timeout", `${provider} did not answer in time.`),
                )
              : recorded.complete(call),
        },
      ],
      env: () => ({}),
    });
  };
  // A plain rule: the answer must be one sentence under 80 characters, with no digits.
  const oneSentence: AnswerCheck<string> = ({ text }) =>
    text.length < 80 && !/\d/.test(text)
      ? { ok: true, value: text }
      : { ok: false, issues: ["the note must be one short sentence with no digits"] };

  // Recorded answers cost nothing, so these gateways have no budget and the router is told so: `unmetered`.
  const router = createRouter(
    {
      primary: gatewayOf(
        "alpha",
        [
          ["note-1", "Your menu page lost its canonical link on 12 November and nobody noticed."],
          ["note-1:escalated", "The menu page has no canonical link."],
          ["note-3", "Found 7 pages with the same problem, which is worse than last week."],
        ],
        ["note-2"],
      ),
      fallback: gatewayOf("beta", [["note-2", "The pop-up page loads slowly."]]),
    },
    { unmetered: true },
  );

  const out: string[] = [];
  for (const [task, callId] of [
    ["wording", "note-1"],
    ["wording", "note-2"],
    ["miner", "note-3"],
  ] as const) {
    const r = await router.route(
      {
        task,
        agentId: "triage",
        callId,
        input: {
          task: { template: "reword-findings" },
          findings: [{ id: "f-1", title: "The pop-up page loads slowly" }],
        },
      },
      oneSentence,
    );
    const path = r.attempts.map((a) => `${a.provider}/${a.tier} ${a.outcome}`).join(", ");
    out.push(
      r.kind === "advisory"
        ? `${task}: advisory, "${r.value}" (${path})`
        : `${task}: unsure, ${r.reason} (${path})`,
    );
  }
  return out.join("\n");
}
