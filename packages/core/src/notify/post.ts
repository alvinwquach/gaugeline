import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

/**
 * The one place Gaugeline sends a POST: to the person's own channels, at their request. It is
 * deliberately not the fetcher, so the fetcher's read-only guard still covers every request to
 * the checked site. Webhook addresses are secrets: only the host ever appears in a result.
 */
export const NOTIFY_TIMEOUT_MS = 10_000;

export interface PostResult {
  ok: boolean;
  status?: number;
  error?: string;
}

/** The host of a webhook address, for messages; its path is the secret part. */
export function safeTarget(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "the webhook";
  }
}

export function postJson(
  url: string,
  body: unknown,
  opts: { timeoutMs?: number; headers?: Record<string, string> } = {},
): Promise<PostResult> {
  const timeoutMs = opts.timeoutMs ?? NOTIFY_TIMEOUT_MS;
  const host = safeTarget(url);
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return Promise.resolve({ ok: false, error: "the webhook address is not a valid address" });
  }
  if (u.protocol !== "https:" && u.protocol !== "http:")
    return Promise.resolve({
      ok: false,
      error: `${host}: only http and https addresses are sent to`,
    });
  const data = Buffer.from(JSON.stringify(body));
  const send = u.protocol === "https:" ? httpsRequest : httpRequest;
  return new Promise((resolve) => {
    let settled = false;
    const done = (r: PostResult) => {
      if (!settled) {
        settled = true;
        resolve(r);
      }
    };
    const req = send(
      u,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": String(data.length),
          "user-agent": "Gaugeline (notification)",
          ...opts.headers,
        },
      },
      (res) => {
        res.resume();
        const status = res.statusCode ?? 0;
        done(
          status >= 200 && status < 300
            ? { ok: true, status }
            : { ok: false, status, error: `${host} answered ${status}` },
        );
      },
    );
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      done({ ok: false, error: `${host} did not answer within ${timeoutMs / 1000} seconds` });
    });
    // Never the raw error: it can carry the full address.
    req.on("error", (err: NodeJS.ErrnoException) =>
      done({ ok: false, error: `${host} could not be reached (${err.code ?? "error"})` }),
    );
    req.end(data);
  });
}
