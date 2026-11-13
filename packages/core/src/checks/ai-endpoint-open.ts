import { classifyAnswer } from "../ai-endpoints/answer.js";
import { NetworkError } from "../errors.js";
import type { Fetcher } from "../fetcher.js";
import { defineCheck, type Finding } from "../model.js";
import type { PageSnapshot } from "../snapshot.js";
import { isHtmlPage } from "./page.js";

/** Bytes of each answer read: a list of models or an error is short, and the rest is never kept. */
const PEEK_BYTES = 16384;

export const AI_ENDPOINT_NO_CONSENT_REASON =
  "this check asks routes on your site that you listed as model endpoints, so it runs only with --owner-consent (or gaugeline.consent.json), on sites you own or have permission to test";

/** One set of answers per run and site: the first page that asks reports it. */
const asked = new WeakMap<object, Set<string>>();

/**
 * AI-12, a probing check (rule 14). A route on the site that talks to a model can answer anyone: it lists the models
 * behind it, replies to a request with no login, or hands back the provider's raw error (which can name the provider,
 * the model, a fragment of the key, a stack trace or a path on the server). Gaugeline looks only at the routes the owner
 * lists under modelEndpoints in gaugeline.ai.json, with one GET each and nothing sent: it never picks a path of its
 * own, never sends a POST (so a chat route that wants a POST and answers 405 is shown as closed, which says nothing
 * about what a POST would get), and never prints any text from the answer.
 *
 * // [docs] uncited: the shapes of a model list, a model's reply and a provider's error are from memory; the providers' pages were unreachable when this was written. The check says what it saw and no more.
 */
export const aiEndpointOpen = defineCheck<PageSnapshot>({
  id: "ai-endpoint-open",
  size: "M",
  done: "Every route you listed answers a GET with 401, 403 or 405 and a plain message, and none shows a provider's error text.",
  estimateChanges:
    "Putting a login or a rate limit on the route is the work; a route built on a framework's AI helper usually has one place to do it. Stopping the raw error text is one catch block.",
  area: "Security & email",
  severity: "high",
  title: "An AI endpoint on your site answers with no login or shows the provider's error text",
  what: "A route you listed as a model endpoint answered a plain GET with no login: it listed its models, replied as a model would, or showed the provider's own error text (a provider error type, a fragment of the key, a stack trace or a server path). Gaugeline names the route and what it saw, never the text.",
  why: "A model route that answers anyone lets strangers run your model account up, read what the model was told to do, or use your site as a free relay. An error that passes the provider's message through tells them which provider and model you use, and sometimes part of your key.",
  fix: "Put a login, a signed session or a rate limit in front of the route, and answer an error with a short message of your own: catch the provider's error on the server, log it there, and send back a plain status.",
  tech: `probing check, off without --owner-consent and a modelEndpoints entry in gaugeline.ai.json: one GET each of the routes you list (at most 8, each a path starting with /), once per run, to the site's own origin with no cookie, no Authorization header and no query, at most ${PEEK_BYTES} bytes of each answer read and never kept; Gaugeline never picks a route itself and never sends a POST, so a route that needs a POST and answers 405 is shown as closed, which says nothing about a POST. A JSON list of models (an OpenAI-style data list of models, or a models list with names) or a model's reply (choices, candidates, a text content block, or a response with a model) answered with 2xx is a high finding that gives the route and a count, never a model name; a provider error type, a provider message, a masked key fragment, a stack trace, a server file path or an SDK error class in the body of any answer is a medium finding that names the signs and none of the text; 401, 403 and 405 and plain answers pass; 404, 429, a 5xx with no such text and no answer are could-not-check. The shapes are from memory (uncited)`,
  async run(page, ctx) {
    if (!isHtmlPage(page)) return [];
    const routes = ctx.ai?.modelEndpoints;
    if (routes === undefined || routes.length === 0) return [];
    const origin = new URL(page.finalUrl).origin;
    const key: object | undefined = ctx.fetcher ?? ctx.budget;
    if (key === undefined || !ctx.fetcher) return [];
    const seen = asked.get(key) ?? new Set<string>();
    asked.set(key, seen);
    if (seen.has(origin)) return [];
    seen.add(origin);
    if (ctx.ownerConsent !== true) {
      ctx.couldNotCheck?.(origin, AI_ENDPOINT_NO_CONSENT_REASON);
      return [];
    }
    const out: Finding[] = [];
    for (const route of [...new Set(routes)]) {
      const url = `${origin}${route}`;
      const hop = await answer(ctx.fetcher, url);
      if (hop === undefined) {
        ctx.couldNotCheck?.(url, "the address did not answer");
        continue;
      }
      const result = classifyAnswer({
        status: hop.status,
        contentType: hop.headers["content-type"] ?? "",
        body: hop.body ?? "",
      });
      switch (result.kind) {
        case "closed":
          break;
        case "unclear":
          ctx.couldNotCheck?.(url, result.reason);
          break;
        case "open-list":
          out.push(
            finding(
              this,
              url,
              "high",
              `${route} answers ${hop.status} and lists ${result.count} ${result.count === 1 ? "model" : "models"} to anyone, with no login`,
            ),
          );
          break;
        case "open-answer":
          out.push(
            finding(
              this,
              url,
              "high",
              `${route} answers ${hop.status} with a model's reply to anyone, with no login`,
            ),
          );
          break;
        case "verbose-error":
          out.push(
            finding(
              this,
              url,
              "medium",
              `${route} answers ${hop.status} with the provider's own error text: ${result.signs.join(", ")}`,
            ),
          );
          break;
      }
    }
    return out;
  },
});

function finding(
  check: { id: string; title: string },
  url: string,
  severity: Finding["severity"],
  evidence: string,
): Finding {
  return { checkId: check.id, severity, title: check.title, evidence, url };
}

async function answer(fetcher: Fetcher, url: string) {
  try {
    const hops = await fetcher.get(url, { anonymous: true, maxBytes: PEEK_BYTES });
    const last = hops.at(-1);
    return last && !last.error ? last : undefined;
  } catch (err) {
    if (err instanceof NetworkError) return undefined;
    throw err;
  }
}
