/**
 * Reading what a model endpoint answered to a plain GET with no login (AI-12). Pure: the same answer gives the same
 * result. Nothing from the body leaves this file except a count and names from a fixed list of signs: no model name,
 * no message, no key fragment.
 *
 * The shapes are from memory (the providers' pages were unreachable when this was written): uncited. The OpenAI-style
 * list of models ({ object: "list", data: [{ id, object: "model" }] }), Ollama's ({ models: [{ name }] }), a chat
 * completion with choices, a candidates list, a content list of text blocks and a { model, response } object.
 */
export interface Answer {
  status: number;
  contentType: string;
  /** The start of the body, as text. */
  body: string;
}

export type Classified =
  | { kind: "open-list"; count: number }
  | { kind: "open-answer" }
  | { kind: "verbose-error"; signs: string[] }
  | { kind: "closed" }
  | { kind: "unclear"; reason: string };

/** Signs that an endpoint passes a provider's or its own raw error on. Each is bounded, so a hostile body is read in linear time. */
const SIGNS: readonly [label: string, pattern: RegExp][] = [
  [
    "a provider error type",
    /"(?:type|code)"\s*:\s*"(?:invalid_request_error|authentication_error|permission_error|rate_limit_error|overloaded_error|insufficient_quota|invalid_api_key|model_not_found|rate_limit_exceeded|context_length_exceeded)"/,
  ],
  [
    "a provider message",
    /Incorrect API key provided|You exceeded your current quota|API key not valid|x-api-key header is required|invalid x-api-key|Rate limit reached for|The model `[^`\n]{1,80}` does not exist/i,
  ],
  ["a key fragment", /\bsk-(?:proj-|ant-|or-)?[A-Za-z0-9_-]{0,12}\*{3,}[A-Za-z0-9_-]{0,8}/],
  [
    "a stack trace",
    /\bat\s+(?:async\s+)?[\w$.<>]{1,80}\s+\((?:\/|[A-Za-z]:\\|file:|node:)[^)\n]{0,300}:\d+:\d+\)|Traceback \(most recent call last\)/,
  ],
  [
    "a file path",
    /(?:\/(?:var\/task|app|usr\/src\/app|srv|home\/[a-z0-9_-]{1,32})|[A-Za-z]:\\(?:Users|inetpub))[\w./\\-]{1,200}\.(?:js|mjs|cjs|ts|tsx|py)\b/,
  ],
  [
    "an SDK error class",
    /\b(?:openai\.error|OpenAIError|APIConnectionError|AuthenticationError|RateLimitError|BadRequestError|GoogleGenerativeAIError|AI_APICallError)\b/,
  ],
];

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function parse(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}

/** A list of models: an OpenAI-style { data: [{ id, object: "model" }] } or an { models: [{ name | model }] } list. */
function modelCount(json: unknown): number | undefined {
  if (!isRecord(json)) return undefined;
  const data = json["data"];
  if (json["object"] === "list" && Array.isArray(data) && data.length > 0) {
    const first: unknown = data[0];
    if (
      isRecord(first) &&
      typeof first["id"] === "string" &&
      (first["object"] === "model" || "owned_by" in first)
    )
      return data.length;
  }
  const models = json["models"];
  if (Array.isArray(models) && models.length > 0) {
    const first: unknown = models[0];
    if (
      isRecord(first) &&
      (typeof first["name"] === "string" || typeof first["model"] === "string")
    )
      return models.length;
  }
  return undefined;
}

/** A model's reply: choices with a message or text, candidates, a list of text blocks, or { model, response }. */
function isReply(json: unknown): boolean {
  if (!isRecord(json)) return false;
  const choices = json["choices"];
  if (Array.isArray(choices) && choices.length > 0) {
    const c: unknown = choices[0];
    if (isRecord(c) && (isRecord(c["message"]) || typeof c["text"] === "string")) return true;
  }
  if (Array.isArray(json["candidates"]) && json["candidates"].length > 0) return true;
  const content = json["content"];
  if (
    json["type"] === "message" &&
    Array.isArray(content) &&
    content.some((b) => isRecord(b) && b["type"] === "text")
  )
    return true;
  return typeof json["model"] === "string" && typeof json["response"] === "string";
}

export function classifyAnswer(answer: Answer): Classified {
  const signs = SIGNS.filter(([, pattern]) => pattern.test(answer.body)).map(([label]) => label);
  if (signs.length > 0) return { kind: "verbose-error", signs };
  const { status } = answer;
  if (status === 401 || status === 403 || status === 405) return { kind: "closed" };
  if (status >= 200 && status < 300) {
    if (!/json/i.test(answer.contentType)) return { kind: "closed" };
    const json = parse(answer.body);
    const count = modelCount(json);
    if (count !== undefined) return { kind: "open-list", count };
    if (isReply(json)) return { kind: "open-answer" };
    return { kind: "closed" };
  }
  return { kind: "unclear", reason: `the address answered ${status}, which is not a clear answer` };
}
