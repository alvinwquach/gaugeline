# The model gateway: one way to reach a model

If an agent ever words a draft for you (a note to a bakery owner about a broken menu link), it should reach a
model one way, and that way should be easy to check: it never prints your key, it never sends more than it was
given, it stops when it takes too long, and in a test it needs no key and no network. This page describes that
one way. It is [agent](./agent-safety.md) plumbing with the same rules as every agent: a model **only words a
draft**, and what it says is advice for a person to read, never a result that decides anything.

**Today.** The interface, the two tiers, the config shape, the recorded fake, the hooks for budgets and the one
module that sends a request to a provider are built and tested (row AG-19). **Not wired.** Nothing calls the
sending module yet, and its only provider entry is an example on a reserved name that never resolves, so
nothing here can reach a model today. Reading your key on the command line is
[AG-20](https://github.com/alvinwquach/gaugeline/blob/main/docs/adr/0014-agent-safety-model.md), budgets are built ([model budgets](./model-budgets.md), AG-22) and the
privacy rules for what is sent are AG-23. The decision behind all of this is
[ADR-0005, as amended on 13 Nov 2026](https://github.com/alvinwquach/gaugeline/blob/main/docs/adr/0005-notifications-post-to-your-own-channels.md):
your own key, from your own environment, findings and ids and snippets only, never a whole page.

## Two tiers

| Tier     | For                                                                  |
| -------- | -------------------------------------------------------------------- |
| `fast`   | wording a draft                                                      |
| `strong` | the check writer and the field-findings miner (the routing is AG-21) |

A request names a tier, never a model. The config says which model each tier uses, so changing a model is one
line in a file and never a change to an agent. A tier that does not exist, or that your config names no model
for, is refused before anything else happens.

## The config

A config holds a provider, a model id for each tier, and the **name** of the environment variable that holds
your key. It never holds the key, and it has no setting for a host: where a provider can be reached is kept in
code, not in a file.

```json
{
  "provider": "example",
  "keyEnv": "EXAMPLE_API_KEY",
  "tiers": { "fast": "example-small", "strong": "example-large-2026-01-15" },
  "timeoutMs": 30000,
  "maxInputChars": 50000,
  "maxOutputTokens": 1024
}
```

| Setting           | Meaning                                                                                                                                                                                                             |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `provider`        | lower case words joined by dashes; the gateway needs an adapter registered under it (today `example` and `recorded`)                                                                                                |
| `keyEnv`          | the variable that holds your key, from a closed list kept in the code (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `EXAMPLE_API_KEY` and others). Any other name, or a pasted key, is refused. There are no custom names |
| `tiers`           | a model id for `fast`, `strong` or both: lower case words and short version numbers joined by dashes, dots or colons (`gpt-4o-mini-2024-07-18`). A UUID, hex, base32 or any key-like value is refused               |
| `timeoutMs`       | 100 to 120000, default 30000: the call is stopped after this long                                                                                                                                                   |
| `maxInputChars`   | 1 to 100000, default 100000: a longer prompt is refused and nothing is sent                                                                                                                                         |
| `maxOutputTokens` | 1 to 8192, default 1024                                                                                                                                                                                             |

The file is strict. A setting the page does not know (`apiKey`, `token`, `host`, `baseUrl`, `allowPrivate`) is an
error, and an error says where the problem is and never repeats what was written there, because the value may
be a key someone pasted in the wrong place.

## What one call does

1. Checks the tier, the ids and the size of the prompt. Nothing is read or sent yet.
2. Reads your key from the environment **now**. It is never kept between calls, so unsetting the variable stops
   the next call. An unset or blank variable is `missing-key`, and the error names the variable, never a value.
3. Refuses the call if the prompt holds your own key (`key-in-prompt`), and replaces any other secret, email
   address or phone number in the prompt with a marker.
4. Asks the budget hooks. With no budget they say yes to everything; with a
   [budget ledger](./model-budgets.md) (AG-22) they check the run, day and workspace ceilings against the worst the
   call can cost. Anything that is not a clear yes (an error, an empty answer) stops the call.
5. Calls the adapter with a hard timeout and a signal that is aborted when it runs out.
6. Checks the answer: text, the tool calls it tried and its usage as whole numbers, nothing else, and not more
   than 100000 characters. Anything else is `bad-answer`, and the error does not repeat the answer.

The key is handed to the adapter wrapped, so printing it, writing it as JSON or inspecting it shows
`[redacted key]`; only the adapter can read it out. Every error message is cleaned before it is raised: your
key is removed in the forms a request writes it (as is, in a web address, as base64, inside JSON), key shapes
and personal data are replaced, hidden characters are shown, and the text is cut short. The gateway prints and
logs nothing.

| Error code            | Means                                                                  |
| --------------------- | ---------------------------------------------------------------------- |
| `bad-config`          | the config is not valid, or the provider needs a `keyEnv` and has none |
| `unknown-provider`    | no adapter is registered for the provider                              |
| `unknown-tier`        | the tier is not `fast` or `strong`                                     |
| `tier-not-configured` | the config names no model for that tier                                |
| `bad-request`         | the prompt, agent id or call id is not usable                          |
| `input-too-large`     | the prompt is over the limit                                           |
| `missing-key`         | the variable is not set, blank, or the environment could not be read   |
| `bad-key`             | the value has a space, a line break or a control character             |
| `key-in-prompt`       | the prompt holds your own key                                          |
| `budget`              | the budget hooks said no, or did not say yes                           |
| `timeout`             | no answer in time                                                      |
| `provider-error`      | the adapter failed; its message is cleaned                             |
| `bad-answer`          | the answer is not in the expected shape                                |

## Your own key

Gaugeline uses your key, never its own, and keeps none. There are two modes, both with the key in your own
environment:

- **Mode 1, the command line.** The call runs in your own process, with the key in the environment you start it from.
- **Mode 2, hosted.** The call runs in your own worker (the process you run for the hosted tier, the same one that
  applies approved drafts), with your own key in its environment. Gaugeline's hosted service makes no model call
  and holds no key: no table or column holds one, and a test fails if the hosted app imports the gateway.

A key Gaugeline would hold for you, with metering (mode 3), is parked with billing. `createByokGateway` refuses it
by name, and the only modes it accepts are `cli` and `worker`.

Your settings go in `gaugeline.llm.json`: the config above, and nothing else. `gaugeline llm` reads that file
and the one variable it names, and tells you what is set up. It never shows the key, sends nothing, and exits 0 when
it ran, also when the key is not set.

```text title=Setup
Model setup (mode 1)
provider: example
fast: example-small
strong: example-large
key: EXAMPLE_API_KEY is set (its value is never shown)
The call runs in: this command line, in your own process, with your own key.
Gaugeline keeps no key: it reads yours from your environment when a call is made, and prints or logs none.
This sent nothing.
```

The file is refused if it holds anything that looks like a key, a host, or a setting it does not know. What a file
says is never repeated back unless it is on a closed list kept in the code: a provider, a model id and a key variable
are printed as written only if they are known (`example`, `example-small`, `OPENAI_API_KEY`). Any other provider or
model id is printed as the fixed text `[not on the known list]`, with no character and no length of it, and an
unknown setting as "setting 2". A key
variable that is not on the list is refused without being shown or read, because a deny list could never be complete.
To use another provider's variable, add it to the list in `known.ts`, the way a provider host is added to the
sending module. The gateway
reads the variable when a call is made and never keeps it, and it writes no file, so unsetting the variable stops
the next call. What leaves your machine in each mode is [AG-23](https://github.com/alvinwquach/gaugeline/blob/main/docs/adr/0014-agent-safety-model.md)'s page.

## A model's answer is never a pass

Every answer carries `advisory: true` and has no field for a verdict. Grouping, ranking, diffing and checking
stay plain code, and a model-worded draft is read by a person before anything happens, as in
[Agent evals](./agent-evals.md): that page's judge can only say `advisory` or `unsure`, and the gateway holds
to the same rule.

## The recorded fake, and recording once

In tests the provider is `recorded`: the [eval harness](./agent-evals.md)'s replay, put behind the same
interface. It looks an answer up by call id. It needs no key, has no host, reads no clock and never touches the
network, and a call with no recording is an error that names the call. `gatewayEvalModel(gateway, "fast")`
lets the eval harness run an agent through the gateway, so a live run is the same code with a real adapter
behind it (manual only, never in CI).

To make a recording, wrap a gateway with `recordGateway` while you run by hand, then write the answers with
`recordingsToJson`. The file holds each answer and what it cost, keyed by call id: no prompt, no key and no
model name. `recordingsFromJson` refuses a file in which an answer looks like it holds a key, so one cannot be
committed by accident.

## Example: wording a note for a bakery pop-up

Run from `packages/core` with `node --import tsx example.mts`:

```ts title=Example
import {
  ModelGatewayError,
  createGateway,
  createRecordedAdapter,
  shownModelId,
  shownProvider,
} from "./src/model-gateway/index.js";

// What a config file holds: a provider and a model id per tier. Never a key, never a host.
const config = {
  provider: "recorded",
  tiers: { fast: "recorded-small", strong: "recorded-large" },
};
// One answer a model gave once, recorded under the id of the call that asked for it.
const answers = new Map([
  [
    "reword-1",
    {
      text: "The menu link on the pop-up page is broken. Point it at the live menu page.",
      usage: { inputTokens: 52, outputTokens: 14, costMicros: 800, latencyMs: 410 },
    },
  ],
]);
const gateway = createGateway({
  config,
  adapters: [createRecordedAdapter(answers)],
  env: () => ({}),
});
const out: string[] = [];

const answer = await gateway.complete({
  tier: "fast",
  agentId: "triage",
  callId: "reword-1",
  prompt: `Reword for the owner: the menu link gives a 404. Reply to ${["baker", "example.test"].join("@")}`,
});
out.push(
  `tier ${answer.tier} -> model ${shownModelId(answer.provider, answer.model)} (provider ${shownProvider(answer.provider)})`,
);
out.push(`text: ${answer.text}`);
out.push(
  `usage: ${answer.usage.inputTokens} in, ${answer.usage.outputTokens} out, ${answer.usage.costMicros} micro-units`,
);
out.push(`advisory: ${answer.advisory}, redacted: ${answer.redacted}`);

for (const [what, request] of [
  ["unknown tier", { tier: "ultra", agentId: "triage", callId: "reword-1", prompt: "Hi" }],
  [
    "oversized prompt",
    { tier: "fast", agentId: "triage", callId: "reword-1", prompt: "a".repeat(100_001) },
  ],
] as const) {
  try {
    await gateway.complete(request as never);
  } catch (err) {
    if (!(err instanceof ModelGatewayError)) throw err;
    out.push(`${what}: refused (${err.code})`);
  }
}

console.log(out.join("\n"));
```

```text title=Output
tier fast -> model recorded-small (provider recorded)
text: The menu link on the pop-up page is broken. Point it at the live menu page.
usage: 52 in, 14 out, 800 micro-units
advisory: true, redacted: true
unknown tier: refused (unknown-tier)
oversized prompt: refused (input-too-large)
```

The email address in the prompt was replaced before the adapter saw it, which is what `redacted: true` says. A
test runs this same code and fails if this page's output differs from it.

The eval harness gives the same report through the gateway as it does from the replay itself:

```text title=Evals
agent triage: 3 golden, 8 known-bad
golden     golden-two-causes         pass
golden     golden-one-urgent         pass
golden     golden-page-text-is-data  pass
known-bad  bad-missing-id            caught (cited-ids)
known-bad  bad-invented-number       caught (no-invented-numbers)
known-bad  bad-write-call            caught (no-write-call)
known-bad  bad-over-cost             caught (limits)
known-bad  bad-too-slow              caught (limits)
known-bad  bad-too-many-calls        caught (limits)
known-bad  bad-oversized-input       caught (limits)
known-bad  bad-malformed-output      caught (schema)
golden 3/3 pass; known-bad 8/8 caught; cost 1008000 micro-units
```

## The one sending module

`packages/core/src/model-gateway/send.ts` is the only file that sends a request to a model provider. It is not
the fetcher and not the notification sender, and the lint rule and the boundary test name it, so a second file
that opens a connection fails both.

- **A list of hosts, in code.** The module can reach only the hosts on `PROVIDER_HOSTS`: an exact lower-case name,
  https, one path. A caller names a provider (`example`), never a host or a path, and no config or flag can add
  one. A provider is added by a change to that list and to its test.
- **Your key, at call time.** The gateway reads it from your environment and hands it to the sender for that call;
  it goes into one header and nowhere else. It is not in the body, an error, a log or a recording.
- **A bounded payload.** At most 16000 bytes of prompt, and text that is a whole page (a document type line, or an
  `html`, `head` or `body` element) is refused. A finding may quote one tag; a page cannot get through. This is a
  tripwire: what may be sent is decided by the caller and the privacy rules (AG-23).
- **No redirects, no private addresses.** A 3xx is an error and is never followed. A name that resolves to a
  loopback, private, link-local, shared (CGNAT) or cloud-metadata address is refused when the connection is made,
  with the same rule the fetcher uses, even if one of several answers is public.
- **Its own connection, and only JSON back.** The request uses its own https agent, never Node's global one, so
  Node's built-in proxy support (`NODE_USE_ENV_PROXY` or `--use-env-proxy`) cannot route it around the address
  check: a test runs it with that support on. A 2xx answer is read only when its content type is
  `application/json` (with `charset=utf-8`, if any); anything else is refused without being read or repeated.
- **A hard timeout.** 60 seconds at most, whatever the config says, and the request is destroyed when the gateway
  gives up sooner. The answer is read up to 256 KB.
- **Plain errors, with a class.** An error says the host and a status or an error code. It never repeats the answer,
  the request, an address or a key. It also carries a class, decided by the status or the error code and never by
  words: a 5xx, a lost connection (`ECONNREFUSED`, `ECONNRESET`, `ETIMEDOUT`, `EHOSTUNREACH`, `ENETUNREACH`,
  `ENOTFOUND`, `EAI_AGAIN`, `EPIPE`) and a timeout are an `outage`; 401 and 403 are `bad-key`; 429 is
  `rate-limited`; 400 and 422 (and a prompt the sender will not send) are `bad-request`; a 3xx is `redirect`; a name
  that resolves to a private address is `blocked-address`; an answer that is not JSON is `not-json` and one in the
  wrong shape is `bad-answer`; any other status is `refused` and any other error code is `unclassified`. The
  [router](#routing-and-escalation) tries a second provider after an `outage` and after nothing else.

The request is a POST of `{ model, prompt, max_output_tokens }` with `Authorization: Bearer <key>`, and the answer is
`{ text, usage: { input_tokens, output_tokens } }`; the cost is worked out in whole micro-units from a price in
the list. No provider SDK is used. No real provider is chosen yet: that is a decision for the owner, made by
adding an entry. Tests never reach a provider: they hand the sender a request function that talks to a server on
a loopback address, or one that never answers.

## Routing and escalation

A router decides which tier a task uses and what to do when an answer is no good. It is a short fixed list, not a
model's choice, and the same inputs always take the same path.

| Task           | Tier     |
| -------------- | -------- |
| `wording`      | `fast`   |
| `check-writer` | `strong` |
| `miner`        | `strong` |

1. **The task's tier, on the first provider.**
2. **An outage: once, the same call on a second provider**, if you gave one. An outage is a timeout, a lost
   connection or a 5xx answer, and **nothing else**. It is decided by the _class_ the adapter gave its error
   (`failure: "outage"`), never by the words of the message, so a provider's body that happens to say "503" or
   "timeout" changes nothing. Every other class is a refusal and stops the task: `bad-key` (a 401 or 403),
   `bad-request` (a 400 or 422, or a prompt the sender will not send), `rate-limited` (a 429: your own limit, a
   second provider would be sent the same payload for nothing), `redirect`, `blocked-address`, `refused` (any
   other status) and `unclassified` (an error with no class, a plain `Error` included). The payload that a
   provider refused is never sent to another one; the payload of a call that timed out or lost its connection may
   already have reached the first provider (see _What a fallback means for your data_, below). A second provider is another gateway you build with its own
   adapter; adding a host to the list of reachable hosts is a change to the sending module, never a setting.
3. **A failed check, or an answer in no usable shape: once, the `strong` tier**, on the provider that answered,
   with the plain reasons added to the prompt. The reasons are at most five lines of 120 characters, cleaned; the
   first answer is never repeated. A `strong` task has no higher tier, so one failed answer ends there. An answer
   that is not JSON, or not the expected shape, is a failed answer like this, never a reason to try another
   provider.
4. **A budget stop, or any refusal that is not an outage** (a missing key, a prompt that is too large, a prompt that
   holds your key), **stops at once**: a second provider would meet the same problem, or use your key for nothing.
   The budget itself is the gateway's hook (row AG-22); the router only obeys it.

**One budget for both providers, and a budget at all.** A fallback must not be a way round the ceilings, so
`createRouter` refuses to build unless three things hold (each is a `bad-config` error):

- **Both gateways were made by `createGateway`.** A router takes only those: an object built by hand, or a copy,
  wrapper or proxy of a real one, could say it has a budget and spend none. A made gateway is frozen, with the
  budget it was given: its `complete` and `budget` cannot be assigned, redefined or deleted. The router keeps the
  `complete` it found when it was built and calls that, never the property again.
- **They share the same budget object.** Hand the one `RunBudget` from the [budget ledger](./model-budgets.md) to
  both as `budget`. A fallback with a budget of its own, with none while the first has one, or with a wrapper that
  only looks the same, is refused, because the second provider's calls would not be counted against the run's
  ceilings. A gateway shows the budget it uses as `gateway.budget`.
- **There is a budget.** A model call with no ceiling is something a person must ask for: without a budget the
  router is refused unless you pass `{ unmetered: true }`, and `unmetered` is itself refused when any gateway has a
  budget. The recorded fakes in tests and the example below have none, so they say `unmetered`.

**What a fallback means for your data.** Read this before you give the router a second provider. Falling back
means **the same prompt can be sent to both providers**. It happens after a timeout or a lost connection, and in
those cases the first provider may already have received the whole payload (the request left your machine before the
answer failed to come back), so you cannot assume the second provider is the only one that has seen it. It also
happens after a 5xx, and the router decides that from the status alone, **without reading the body**: it never looks
at what the first provider said. Any other failure (a refused key, a rate limit, a bad request, a redirect, a
blocked address, an answer that is not JSON) does not fall back, so a payload a provider refused is not offered to
another. Both providers must be on the sending module's list of hosts, and both are bound by the same limits: the
payload cap, findings and ids and snippets only, never a whole page. If a second provider is not acceptable for the
data you send, do not configure a fallback.

At most **three calls** are made for one task: the first, one fallback and one escalation. No order of failures
makes a fourth, and a test runs every script of up to three steps for each provider to show it (the worst case is an
escalation that meets an outage, or an outage whose fallback then fails the check). `maxCalls` can lower the cap,
never raise it. The time all the calls of a task take together has a **deadline**, two minutes by default
(`deadlineMs`, 1000 to 600000). It holds inside a call as well as between calls. The router owns one abort signal for the whole task and
aborts it at the deadline. Each call is given the time that is left, and that time covers the budget check as well
as the provider: the gateway starts its clock before it asks the budget, stops waiting for a check that outlasts it,
and **never calls the adapter once the call has been aborted**, whatever order things finish in (it looks again
after every wait). The sender uses the shorter of that time and its own 60 seconds. The router also stops waiting at
the deadline whatever the gateway does, and an answer that arrives after it is not used (its cost is kept). A task
therefore never runs past its deadline, nothing is sent after the router has given up, and a clock that gives
nothing usable, or runs backwards, counts as no time left. The check is plain code you give it; for an agent with an
[eval set](./agent-evals.md), `agentAnswerCheck` runs the same schema, cited-id, invented-number and write-call
assertions on the live answer. What comes out is `advisory` (an answer that passed the check, for a person to read)
or `unsure`, with the reason: `failed-checks`, `outage`, `budget`, `refused`, `deadline` (the task's time was used)
or `calls` (a lowered `maxCalls` was used). There is no outcome that says
pass, and nothing here gates a build. Each attempt is listed with its provider, tier and result, and the cost of
every answer received is added up, including one that failed the check.

```ts title=RouteExample
import {
  ModelGatewayError,
  createGateway,
  createRecordedAdapter,
  createRouter,
  type AnswerCheck,
} from "./src/model-gateway/index.js";

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
console.log(out.join("\n"));
```

```text title=RouteOutput
wording: advisory, "The menu page has no canonical link." (alpha/fast failed-checks, alpha/strong accepted)
wording: advisory, "The pop-up page loads slowly." (alpha/fast outage, beta/fast accepted)
miner: unsure, failed-checks (alpha/strong failed-checks)
```

The first note was too long and had a digit, so the `fast` answer failed the check and the `strong` one passed.
The second had no answer from `alpha`, so `beta` answered. The third was a `miner` task, which uses `strong`, and
its one answer failed, so it is `unsure`.

## What it does not do

- It does not call a provider by itself. Nothing uses the sending module yet; wiring your key in on the command
  line is AG-20.
- It does not enforce a budget by itself: the [budget ledger](./model-budgets.md) (AG-22) is handed to the gateway as
  `budget`, and the router stops when it says no.
- It does not decide what may be sent. A caller passes findings, evidence snippets and ids, never a page; the
  redaction here is a last line of defence, and the privacy rules are AG-23.
- A redaction by pattern misses a secret in a shape it does not know, and it replaces any run of eight or more
  digits, which can hide a count. Read a draft before you use it.
