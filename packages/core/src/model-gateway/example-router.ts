/**
 * The program shown in the routing section of docs/model-gateway.md. A test runs it and compares what it
 * returns with the page, word for word, and checks that every line of the page's code is a line of this file.
 */
import { createGateway, createRecordedAdapter, createRouter, type AnswerCheck } from "./index.js";

export async function runRoutingExample(): Promise<string> {
  const usage = { inputTokens: 40, outputTokens: 12, costMicros: 900, latencyMs: 300 };
  const answer = (text: string) => ({ text, usage });
  // A gateway over answers recorded once, keyed by call id. The second call of a task is "<id>:escalated".
  const gatewayOf = (provider: string, answers: [string, string][]) =>
    createGateway({
      config: { provider, tiers: { fast: `${provider}-small`, strong: `${provider}-large` } },
      adapters: [
        { ...createRecordedAdapter(new Map(answers.map(([id, t]) => [id, answer(t)]))), provider },
      ],
      env: () => ({}),
    });
  // A plain rule: the answer must be one sentence under 80 characters, with no digits.
  const oneSentence: AnswerCheck<string> = ({ text }) =>
    text.length < 80 && !/\d/.test(text)
      ? { ok: true, value: text }
      : { ok: false, issues: ["the note must be one short sentence with no digits"] };

  const router = createRouter({
    primary: gatewayOf("alpha", [
      ["note-1", "Your menu page lost its canonical link on 12 November and nobody noticed."],
      ["note-1:escalated", "The menu page has no canonical link."],
      ["note-3", "Found 7 pages with the same problem, which is worse than last week."],
    ]),
    fallback: gatewayOf("beta", [["note-2", "The pop-up page loads slowly."]]),
  });

  const out: string[] = [];
  for (const [task, callId] of [
    ["wording", "note-1"],
    ["wording", "note-2"],
    ["miner", "note-3"],
  ] as const) {
    const r = await router.route(
      { task, agentId: "triage", callId, prompt: "Word this finding." },
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
