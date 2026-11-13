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
model id is printed as its first three characters and its length, and an unknown setting as "setting 2". A key
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
} from "./src/model-gateway/index.js";

// What a config file holds: a provider and a model id per tier. Never a key, never a host.
const config = { provider: "recorded", tiers: { fast: "word-small", strong: "word-large" } };
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
out.push(`tier ${answer.tier} -> model ${answer.model} (provider ${answer.provider})`);
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
tier fast -> model word-small (provider recorded)
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
- **Plain errors.** An error says the host and a status or an error code. It never repeats the answer, the
  request, an address or a key.

The request is a POST of `{ model, prompt, max_output_tokens }` with `Authorization: Bearer <key>`, and the answer is
`{ text, usage: { input_tokens, output_tokens } }`; the cost is worked out in whole micro-units from a price in
the list. No provider SDK is used. No real provider is chosen yet: that is a decision for the owner, made by
adding an entry. Tests never reach a provider: they hand the sender a request function that talks to a server on
a loopback address, or one that never answers.

## What it does not do

- It does not call a provider by itself. Nothing uses the sending module yet; wiring your key in on the command
  line is AG-20.
- It does not choose between tiers, retry, or fall back to a second provider (AG-21), and it does not enforce a
  budget by itself: the [budget ledger](./model-budgets.md) (AG-22) is handed to it as `budget`.
- It does not decide what may be sent. A caller passes findings, evidence snippets and ids, never a page; the
  redaction here is a last line of defence, and the privacy rules are AG-23.
- A redaction by pattern misses a secret in a shape it does not know, and it replaces any run of eight or more
  digits, which can hide a count. Read a draft before you use it.
